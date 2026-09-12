// ZanPlayer Lite — iOS native playback backend.
//
// Tauri v2 in-app mobile plugin registered from Rust via
// `api.register_ios_plugin(init_zanplayer_media)` with the binding macro
// `tauri::ios_plugin_binding!(init_zanplayer_media)` (which expands to
// `swift!(fn init_zanplayer_media() -> *const c_void)`). The Swift symbol that
// backs it is the `@_cdecl("init_zanplayer_media")` free function below.
//
// Contract with Rust (`src-tauri/src/native_player/mobile.rs`):
//   * commands are the CMD_* verb strings: load, play, pause, seek,
//     set_volume, set_speed, stop, position, diagnostics
//   * payload argument keys are snake_case: path, position, level, speed
//   * `position` must resolve a camelCase object `[position, duration, paused,
//     ended]` — Rust deserializes it straight into `MpvTimeUpdate`.
//
// The native video surface fills the whole window BEHIND the transparent
// WKWebView (DOM chrome floats above), mirroring the desktop layering model.
// There is no per-frame DOM-stage anchoring: `apply_surface_layout` is a no-op
// in Rust because the stage maps 1:1 to the window on mobile.

import AVFoundation
import UIKit
import WebKit
import Tauri

private struct LoadArgs: Decodable {
    let path: String
}

private struct SeekArgs: Decodable {
    let position: Double
}

private struct VolumeArgs: Decodable {
    let level: Double
}

private struct SpeedArgs: Decodable {
    let speed: Double
}

/// Plain UIView whose layer IS an AVPlayerLayer (layerClass override) — the
/// tidy AVFoundation idiom for an embeddable native player view.
private final class PlayerSurfaceView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

@TauriPlugin
class MediaPlaybackPlugin: Plugin {

    private let player = AVPlayer()
    private var surfaceView: PlayerSurfaceView?
    private weak var webviewRef: WKWebView?
    private var storedRate: Float = 1.0
    private var didEnd = false

    override init() {
        super.init()
        player.actionAtItemEnd = .pause
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(itemDidPlayToEnd),
            name: .AVPlayerItemDidPlayToEndTime,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func itemDidPlayToEnd() {
        didEnd = true
    }

    // --- lifecycle ---------------------------------------------------------

    /// Make the WKWebView chrome transparent and mount the video surface below
    /// it. Mirror of the macOS/Windows layering model: the DOM stage (captions,
    /// OSD, controls) floats above the native frames.
    @objc public override func load(webview: WKWebView) {
        webview.isOpaque = false
        webview.backgroundColor = .clear
        webview.scrollView.backgroundColor = .clear
        webview.layer.backgroundColor = UIColor.clear.cgColor

        webviewRef = webview
        attachSurface(below: webview)
    }

    private func attachSurface(below webview: WKWebView) {
        guard surfaceView == nil else { return }
        let host = webview.superview
        let container: UIView
        if let host = host {
            container = host
        } else if let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }),
            let windowView = window.rootViewController?.view {
            container = windowView
        } else {
            return
        }

        let surface = PlayerSurfaceView(frame: container.bounds)
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        surface.playerLayer.player = player
        surface.playerLayer.videoGravity = .resizeAspect
        surface.backgroundColor = .clear
        container.insertSubview(surface, at: 0)
        surfaceView = surface
    }

    // --- commands (called from Rust via run_mobile_plugin) -----------------

    @objc public func load(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(LoadArgs.self)
        let url: URL
        if args.path.contains("://") {
            guard let parsed = URL(string: args.path) else {
                invoke.reject("invalid media URL: \(args.path)")
                return
            }
            url = parsed
        } else {
            url = URL(fileURLWithPath: args.path)
        }
        didEnd = false
        // In edge cases `load(invoke)` fires before `load(webview:)`; mount the
        // surface lazily so video is visible as soon as it starts playing.
        if surfaceView == nil, let wv = webviewRef {
            attachSurface(below: wv)
        }
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        player.defaultRate = storedRate
        player.play()
        invoke.resolve()
    }

    @objc public func play(_ invoke: Invoke) throws {
        didEnd = false
        player.rate = storedRate
        invoke.resolve()
    }

    @objc public func pause(_ invoke: Invoke) throws {
        player.pause()
        invoke.resolve()
    }

    @objc public func seek(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SeekArgs.self)
        didEnd = false
        player.seek(
            to: CMTime(seconds: max(0.0, args.position), preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
        invoke.resolve()
    }

    @objc public func set_volume(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(VolumeArgs.self)
        player.volume = Float(max(0.0, min(args.level / 100.0, 1.0)))
        invoke.resolve()
    }

    @objc public func set_speed(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SpeedArgs.self)
        storedRate = Float(max(0.1, args.speed))
        player.defaultRate = storedRate
        if player.timeControlStatus == .playing {
            player.rate = storedRate
        }
        invoke.resolve()
    }

    @objc public func stop(_ invoke: Invoke) throws {
        player.pause()
        player.replaceCurrentItem(with: nil)
        didEnd = false
        invoke.resolve()
    }

    @objc public func position(_ invoke: Invoke) throws {
        let snapshot: [String: Any]
        if let item = player.currentItem {
            let seconds = item.currentTime().seconds
            let duration = item.duration.seconds
            let durationValue = duration.isFinite && duration > 0 ? duration : 0.0
            snapshot = [
                "position": max(0.0, seconds.isFinite ? seconds : 0.0),
                "duration": durationValue,
                "paused": player.timeControlStatus != .playing,
                "ended": didEnd || (item.duration.isValid && item.currentTime() >= item.duration),
            ]
        } else {
            snapshot = [
                "position": 0.0,
                "duration": 0.0,
                "paused": true,
                "ended": false,
            ]
        }
        invoke.resolve(snapshot)
    }

    @objc public func diagnostics(_ invoke: Invoke) throws {
        let p = player
        let item = p.currentItem
        let duration = item?.duration.seconds ?? -1
        let info = "ios avfoundation backend; " +
            "surface=\(surfaceView != nil); " +
            "loaded=\(item != nil); " +
            "durationSec=\(duration.isFinite ? String(duration) : "unset"); " +
            "posSec=\(item?.currentTime().seconds ?? -1); " +
            "playing=\(p.timeControlStatus == .playing); volume=\(p.volume); rate=\(p.rate)"
        invoke.resolve(["diagnostics": info])
    }
}

@_cdecl("init_zanplayer_media")
func initZanplayerMedia() -> Plugin {
    return MediaPlaybackPlugin()
}