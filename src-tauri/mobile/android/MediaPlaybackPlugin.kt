// ZanPlayer Lite — Android native playback backend.
//
// Tauri v2 in-app mobile plugin registered from Rust via
// `api.register_android_plugin("com.micropsy.zanplayer_lite", "MediaPlaybackPlugin")`
// (see src-tauri/src/native_player/mobile_android.rs). The Java class is looked
// up as `com/micropsy/zanplayer_lite/MediaPlaybackPlugin`, so this file must be
// placed at `gen/android/app/src/main/java/com/micropsy/zanplayer_lite/`
// (run `npx tauri android init` once to scaffold the Android project, then copy
// this file in).
//
// Contract with Rust (`src-tauri/src/native_player/mobile.rs`):
//   * commands are the CMD_* verb strings: load, play, pause, seek,
//     set_volume, set_speed, stop, position, diagnostics
//   * payload argument keys are snake_case: path, position, level, speed
//   * `position` must resolve a camelCase object `{ position, duration,
//     paused, ended }` — Rust deserializes it straight into `MpvTimeUpdate`.
//
// The native video surface fills the whole window BEHIND the transparent Tauri
// WebView (DOM chrome floats above), mirroring the desktop layering model.
// There is no per-frame DOM-stage anchoring: `apply_surface_layout` is a no-op
// in Rust because the stage maps 1:1 to the window on mobile.

package com.micropsy.zanplayer_lite

import android.app.Activity
import android.graphics.PixelFormat
import android.graphics.Color
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
internal class LoadArgs {
    lateinit var path: String
}

@InvokeArg
internal class SeekArgs {
    var position: Double = 0.0
}

@InvokeArg
internal class VolumeArgs {
    var level: Double = 0.0
}

@InvokeArg
internal class SpeedArgs {
    var speed: Double = 1.0
}

@TauriPlugin
class MediaPlaybackPlugin(
    private val activity: Activity
) : Plugin(activity) {

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var attached = false

    override fun load(webView: WebView) {
        // The webview chrome must let the video surface behind it show
        // through: opaque white would bury the frames exactly like the desktop
        // window-VO problem. Also make the window format translucent so the
        // WebView content layer is blended instead of composited as opaque.
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null)
        activity.window.setFormat(PixelFormat.TRANSLUCENT)
    }

    // --- lifecycle ---------------------------------------------------------

    private fun ensureSurface() {
        if (attached && playerView != null) {
            return
        }
        val view = PlayerView(activity).apply {
            useController = false
            resizeMode = PlayerView.RESIZE_MODE_FIT
            setBackgroundColor(Color.TRANSPARENT)
        }
        // Insert at index 0 of the decor container so the player sits BELOW
        // the existing webview content (which Tauri mounts as a later child).
        // Full-window: the DOM stage covers the whole screen on mobile.
        val lp = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        (activity.window.decorView as? ViewGroup)?.addView(view, 0, lp)
        playerView = view
        attached = true
    }

    private fun detachSurface() {
        val view = playerView ?: return
        (view.parent as? ViewGroup)?.removeView(view)
        playerView = null
    }

    private fun ensurePlayer(): ExoPlayer? {
        var p = player
        if (p == null) {
            p = ExoPlayer.Builder(activity.applicationContext).build()
            player = p
            playerView?.player = p
        }
        return p
    }

    private fun resolveMediaUri(raw: String): Uri {
        return when {
            raw.startsWith("content://") || raw.startsWith("file://") ||
                raw.startsWith("http://") || raw.startsWith("https://") ->
                Uri.parse(raw)
            // Plain absolute paths (app sandbox / cache copies handed back by
            // the Tauri dialog plugin on some builds).
            else -> Uri.fromFile(File(raw))
        }
    }

    // --- commands (called from Rust via run_mobile_plugin) -----------------

    @Command
    fun load(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(LoadArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("invalid load args: ${e.message}")
            return
        }
        try {
            ensureSurface()
            val p = ensurePlayer() ?: throw IllegalStateException("player unavailable")
            p.stop()
            p.setMediaItem(MediaItem.fromUri(resolveMediaUri(args.path)))
            p.prepare()
            p.play()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("load failed: ${e.message}")
        }
    }

    @Command
    fun play(invoke: Invoke) {
        player?.play()
        invoke.resolve()
    }

    @Command
    fun pause(invoke: Invoke) {
        player?.pause()
        invoke.resolve()
    }

    @Command
    fun seek(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SeekArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("invalid seek args: ${e.message}")
            return
        }
        player?.let {
            it.seekTo((args.position * 1000L).toLong().coerceAtLeast(0L))
            it.playWhenReady = true
        }
        invoke.resolve()
    }

    @Command
    fun set_volume(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(VolumeArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("invalid volume args: ${e.message}")
            return
        }
        player?.volume = (args.level / 100.0).toFloat().coerceIn(0f, 1f)
        invoke.resolve()
    }

    @Command
    fun set_speed(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SpeedArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("invalid speed args: ${e.message}")
            return
        }
        player?.setPlaybackSpeed(args.speed.toFloat().coerceAtLeast(0.1f))
        invoke.resolve()
    }

    @Command
    fun stop(invoke: Invoke) {
        player?.let {
            it.pause()
            it.stop()
        }
        invoke.resolve()
    }

    @Command
    fun position(invoke: Invoke) {
        val p = player
        val ret = JSObject()
        if (p == null) {
            ret.put("position", 0.0)
            ret.put("duration", 0.0)
            ret.put("paused", true)
            ret.put("ended", false)
        } else {
            val currentMs = p.currentPosition.coerceAtLeast(0L)
            val durationMs = if (p.duration == androidx.media3.common.C.TIME_UNSET) {
                0L
            } else {
                p.duration.coerceAtLeast(0L)
            }
            ret.put("position", currentMs / 1000.0)
            ret.put("duration", durationMs / 1000.0)
            ret.put("paused", !p.isPlaying)
            ret.put("ended", p.playbackState == Player.STATE_ENDED)
        }
        invoke.resolve(ret)
    }

    @Command
    fun diagnostics(invoke: Invoke) {
        val p = player
        val out = StringBuilder("android media3 backend; ")
        if (p == null) {
            out.append("player=not-initialized; surface=$attached")
        } else {
            out.append("player=initialized; state=${p.playbackState}; " +
                "posMs=${p.currentPosition}; durationMs=").append(if (p.duration == androidx.media3.common.C.TIME_UNSET) "unset" else p.duration)
                .append("; volume=${p.volume}; speed=${p.playbackParameters.speed}; " +
                    "surface=$attached; isPlaying=${p.isPlaying}")
        }
        val ret = JSObject()
        ret.put("diagnostics", out.toString())
        invoke.resolve(ret)
    }
}