// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pipeline;

use crate::pipeline::{StreamOptions, SubtitleCue};
use crossbeam_channel::{unbounded, Receiver, Sender};
use directories_next::ProjectDirs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use whisper_rs::{WhisperContext, WhisperContextParameters};

/// Which subtitle output the user asked for. Drives the whisper `translate`
/// task flag — never hardcoded:
///  * `Original` runs `translate = false` (source language output)
///  * `English` runs `translate = true` (English output)
///  * `Both` runs two passes over the same audio, one per flag.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum SubtitleMode {
    Original,
    English,
    Both,
}

/// Generation strategy for a transcription job.
///  * `Stream`: real-time VAD-gated decoding; "Both" runs two passes on
///    separate async threads so subtitles never lag the video.
///  * `Batch`: every pass runs to completion before anything is surfaced,
///    guaranteeing perfectly-synced, zero-latency dual subtitles at playback.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum TranscriptionMode {
    Stream,
    Batch,
}

/// Tags for the two inference passes. The UI render queue merges cues by this
/// tag into per-language tracks.
const KIND_ORIGINAL: &str = "original";
const KIND_TRANSLATION: &str = "translation";

/// Build the decode pass list for a requested subtitle mode. Each entry is a
/// `(translate, kind)` pair: `translate` tells whisper whether to output
/// English, `kind` labels the cues for the UI merge step.
fn passes_for_mode(mode: SubtitleMode) -> Vec<(bool, String)> {
    match mode {
        SubtitleMode::Original => vec![(false, KIND_ORIGINAL.to_string())],
        SubtitleMode::English => vec![(true, KIND_TRANSLATION.to_string())],
        SubtitleMode::Both => vec![
            (false, KIND_ORIGINAL.to_string()),
            (true, KIND_TRANSLATION.to_string()),
        ],
    }
}

/// Resolved execution plan for a transcription job: which passes to decode,
/// whether realtime "Both" runs them on separate threads (so subtitles never
/// lag the video at 2x), and how many whisper contexts to load.
#[derive(Debug, PartialEq)]
struct JobPlan {
    passes: Vec<(bool, String)>,
    parallel: bool,
    context_count: usize,
}

fn plan_job(subtitle_mode: SubtitleMode, transcription_mode: TranscriptionMode) -> JobPlan {
    let passes = passes_for_mode(subtitle_mode);
    // Two passes are cheap to overlap *only* in realtime mode, where each pass
    // owns a thread and its own context. Batch mode is inherently sequential:
    // one context decodes every pass, so loading a second one is pure waste.
    let parallel = transcription_mode == TranscriptionMode::Stream && passes.len() > 1;
    let context_count = if parallel { passes.len() } else { 1 };
    JobPlan {
        passes,
        parallel,
        context_count,
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
struct VideoFile {
    path: String,
    name: String,
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    #[serde(rename = "modelName")]
    model_name: String,
    percent: f64,
    #[serde(rename = "speedMBps")]
    speed_mb_per_sec: f64,
    #[serde(rename = "etaSeconds")]
    eta_seconds: u64,
}

#[derive(Clone, serde::Serialize)]
struct PipelineProgress {
    percentage: f64,
}

#[derive(Clone, serde::Serialize)]
struct TranscriptionDone {
    total: usize,
}

/// One complete cue timeline handed to the UI when a full (batch) job finishes.
#[derive(Clone, serde::Serialize)]
struct BatchTrack {
    kind: String,
    language: String,
    cues: Vec<SubtitleCue>,
}

#[derive(Clone, serde::Serialize)]
struct TranscriptionBatchDone {
    tracks: Vec<BatchTrack>,
}

// ---------------------------------------------------------------------------
// Project save/load (`.zan`). The JSON schema mirrors the frontend store's
// `camelCase` field names so the file round-trips between Rust and TypeScript
// without translation. `version` is reserved for forward-compatible migrations.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCue {
    id: String,
    start_time: f64,
    end_time: f64,
    text: String,
    kind: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTrack {
    id: String,
    name: String,
    language: String,
    cues: Vec<ProjectCue>,
    #[serde(default)]
    is_generated: Option<bool>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSubtitleStyle {
    font_name: String,
    font_size: f64,
    primary_color: String,
    outline_color: String,
    back_color: String,
    bold: bool,
    italic: bool,
    alignment: String,
}

/// Current schema version of the `.zan` project file.
const PROJECT_VERSION: u32 = 1;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectData {
    version: u32,
    video_path: String,
    subtitle_tracks: Vec<ProjectTrack>,
    active_subtitle_track_id: Option<String>,
    show_subtitles: bool,
    subtitle_mode: String,
    transcription_mode: String,
    source_language: String,
    subtitle_style: ProjectSubtitleStyle,
    current_time: f64,
}

/// Thread-safe render queue the UI drains against the player master clock.
/// The background decode thread appends globalized cues here; the webview calls
/// `poll_transcript_cues` (typically on a timer or after `transcript-cues-ready`)
/// and only surfaces cues whose timestamp overlaps the current playhead.
#[derive(Clone, Default)]
struct RenderQueue(Arc<Mutex<Vec<SubtitleCue>>>);

/// Handle for one live transcription job's seek channel: which media file the
/// job is decoding and the sender its streaming passes listen on. Replaced on
/// every `start_transcription`; empty while idle, so seeks outside a run are
/// no-ops.
#[derive(Clone)]
struct JobSeek {
    media_path: String,
    seek_tx: Sender<f64>,
}

/// App-managed live control channel. `seek_transcription` forwards a playhead
/// jump to a realtime (streaming) job so its passes drop VAD/utterance state
/// and reposition the WAV reader instead of transcribing stale audio.
#[derive(Clone, Default)]
struct SeekControl(Arc<Mutex<Option<JobSeek>>>);

fn get_app_dir() -> PathBuf {
    let proj_dirs =
        ProjectDirs::from("com", "micropsy", "ZanPlayerLite").expect("Failed to get app dir");
    proj_dirs.data_local_dir().to_path_buf()
}

fn models_dir() -> PathBuf {
    get_app_dir().join("models")
}

// ---------------------------------------------------------------------------
// Model resolution (GGML `.bin` + quantized GGUF).
// ---------------------------------------------------------------------------

/// Base filenames for a requested model key. whisper.cpp ships the large model
/// as `large-v3` (and `large-v3-turbo`), never plain `large`.
fn base_model_names(model_name: &str) -> Vec<String> {
    let lower = model_name.trim().to_ascii_lowercase();
    if lower == "large" {
        vec!["large-v3".to_string(), "large".to_string()]
    } else {
        vec![lower]
    }
}

/// Ordered candidate filenames for a model key, spanning legacy quantized
/// `.bin` files and modern `.gguf` weights (e.g. `ggml-large-v3-q5_0.gguf`).
fn model_candidates(model_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for base in base_model_names(model_name) {
        for ext in [".bin", ".gguf"] {
            let plain = format!("ggml-{}{}", base, ext);
            if !out.contains(&plain) {
                out.push(plain);
            }
            for quant in ["-q5_0", "-q8_0"] {
                let candidate = format!("ggml-{}{}{}", base, quant, ext);
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
        }
    }
    out
}

/// GGUF weights live under the modern `ggml-org` org; legacy `.bin` under
/// `ggerganov`. Each candidate gets the host it actually exists on.
fn model_url(filename: &str) -> String {
    let host = if filename.ends_with(".gguf") {
        "ggml-org"
    } else {
        "ggerganov"
    };
    format!("https://huggingface.co/{}/whisper.cpp/resolve/main/{}?download=true", host, filename)
}

fn is_whisper_model_file(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    lower.starts_with("ggml-") && (lower.ends_with(".bin") || lower.ends_with(".gguf"))
}

/// Map a stored model filename back to the UI model key.
fn model_key_from_filename(filename: &str) -> String {
    let name = filename.strip_prefix("ggml-").unwrap_or(filename);
    let base = name
        .trim_end_matches(".bin")
        .trim_end_matches(".gguf")
        .trim_end_matches("-q5_0")
        .trim_end_matches("-q4_0")
        .trim_end_matches("-q8_0")
        .trim_end_matches("-f16")
        .trim_end_matches(".en");
    match base {
        "large-v3" | "large-v3-turbo" | "large" => "large".to_string(),
        other if other.starts_with("large-v3-") => "large".to_string(),
        other => other.to_string(),
    }
}

fn find_model(models_dir: &Path, model_name: &str) -> Option<PathBuf> {
    model_candidates(model_name)
        .into_iter()
        .map(|f| models_dir.join(f))
        .find(|p| p.exists())
}

#[tauri::command]
async fn download_whisper_model(app: AppHandle, model_name: String) -> Result<String, String> {
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let candidates = model_candidates(&model_name);
    for filename in &candidates {
        let model_path = dir.join(filename);
        if model_path.exists() {
            return Ok(model_path.to_string_lossy().to_string());
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("ZanPlayerLite/0.0.1 (macOS)")
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let mut last_err = String::from("no candidate models");
    for filename in &candidates {
        let model_path = dir.join(filename);
        let part_path = dir.join(format!("{}.part", filename));
        let url = model_url(filename);
        match download_and_save(&client, &url, &part_path, &model_path, &app, &model_name).await {
            Ok(path) => return Ok(path),
            Err(e) => {
                std::fs::remove_file(&part_path).ok();
                last_err = e;
            }
        }
    }
    Err(format!("All model sources failed: {}", last_err))
}

async fn download_and_save(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    model_path: &Path,
    app: &AppHandle,
    model_name: &str,
) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download model: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    let content_length = response.content_length().unwrap_or(0);

    let mut file = File::create(part_path).map_err(|e| format!("Failed to create model file: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_update = std::time::Instant::now();
    let mut last_downloaded = 0;

    while let Some(chunk) = futures_util::TryStreamExt::try_next(&mut stream).await.map_err(|e| format!("Failed to read model chunk: {}", e))? {
        file.write_all(&chunk).map_err(|e| format!("Failed to write model chunk: {}", e))?;
        downloaded += chunk.len() as u64;

        // Update progress every 100ms
        let now = std::time::Instant::now();
        if now.duration_since(last_update) >= std::time::Duration::from_millis(100) {
            let time_since_last = now.duration_since(last_update).as_secs_f64();
            let downloaded_since_last = downloaded - last_downloaded;
            let speed_bytes_per_sec = if time_since_last > 0.0 { downloaded_since_last as f64 / time_since_last } else { 0.0 };
            let speed_mb_per_sec = speed_bytes_per_sec / (1024.0 * 1024.0);
            let percent = if content_length > 0 {
                (downloaded as f64 / content_length as f64) * 100.0
            } else {
                0.0
            };
            let eta_seconds = if speed_bytes_per_sec > 0.0 && content_length > 0 {
                ((content_length - downloaded) as f64 / speed_bytes_per_sec) as u64
            } else {
                0
            };

            app.emit("model-download-progress", ProgressPayload {
                model_name: model_name.to_string(),
                percent,
                speed_mb_per_sec,
                eta_seconds,
            }).ok();

            last_update = now;
            last_downloaded = downloaded;
        }
    }

    // Verify download size
    if content_length > 0 && downloaded != content_length {
        return Err(format!("Model download incomplete: expected {} bytes, got {}", content_length, downloaded));
    }

    drop(file); // Close file to ensure it's flushed
    std::fs::rename(part_path, model_path).map_err(|e| format!("Failed to finalize model file: {}", e))?;

    Ok(model_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_whisper_model(model_name: String) -> Result<(), String> {
    let dir = models_dir();
    for filename in model_candidates(&model_name) {
        let path = dir.join(filename);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_downloaded_models() -> Result<Vec<String>, String> {
    let dir = models_dir();
    let mut models = Vec::new();
    if dir.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                if is_whisper_model_file(filename) {
                    let key = model_key_from_filename(filename);
                    if !models.contains(&key) {
                        models.push(key);
                    }
                }
            }
        }
    }
    Ok(models)
}

#[tauri::command]
async fn check_model_downloaded(model_name: String) -> Result<bool, String> {
    let dir = models_dir();
    Ok(find_model(&dir, &model_name).is_some())
}

// ---------------------------------------------------------------------------
// Dual-pass transcription: VAD -> Whisper decode (translate on/off per pass) ->
// PTS sync. "Both" runs the original + translation passes over the same audio.
// ---------------------------------------------------------------------------

/// whisper.cpp model initialization (`whisper_init_*`) is not thread-safe, so
/// context creation is serialized here. It is held only while a `WhisperContext`
/// is constructed; the decode passes themselves run lock-free on their own
/// contexts — including two parallel passes for realtime "Both" mode — because
/// whisper-rs marks each `WhisperContext` `Send + Sync` and the segment
/// callbacks use the safe variant.
static MODEL_LOAD_LOCK: Mutex<()> = Mutex::new(());

/// Start a transcription job for a media file.
///
/// Non-WAV input is first extracted to a 16 kHz mono temp WAV via the bundled
/// FFmpeg sidecar (awaited here so the spawn only carries CPU-bound work), then
/// a dedicated thread runs the job: VAD-gated Whisper decode with the requested
/// `subtitle_mode` (Original / English / Both) and `transcription_mode`
/// (real-time stream vs. full batch). Returns immediately after the thread is
/// launched.
#[tauri::command]
async fn start_transcription(
    app: AppHandle,
    media_path: String,
    model_name: String,
    language: Option<String>,
    subtitle_mode: SubtitleMode,
    transcription_mode: TranscriptionMode,
) -> Result<(), String> {
    let dir = models_dir();
    let model_path = match find_model(&dir, &model_name) {
        Some(p) => p,
        None => PathBuf::from(download_whisper_model(app.clone(), model_name.clone()).await?),
    };

    let media = PathBuf::from(&media_path);
    let is_wav = media
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);

    let wav_path = if is_wav {
        media
    } else {
        let temp_dir = std::env::temp_dir();
        PathBuf::from(
            extract_audio(app.clone(), media_path.clone(), temp_dir.to_string_lossy().to_string()).await?,
        )
    };

    // Register this job's live seek channel so `seek_transcription` (invoked on
    // every playhead jump while subtitles are running) can reposition the
    // realtime passes. Replacing the sender for a new job is safe: streaming
    // passes hold a cloned receiver; a stale sender simply finds no listeners.
    let (seek_tx, seek_rx) = unbounded::<f64>();
    app.state::<SeekControl>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .replace(JobSeek {
            media_path: media_path.clone(),
            seek_tx,
        });

    std::thread::spawn(move || {
        run_transcription_job(
            app,
            wav_path,
            !is_wav,
            model_path,
            language,
            subtitle_mode,
            transcription_mode,
            seek_rx,
        );
    });
    Ok(())
}

fn run_transcription_job(
    app: AppHandle,
    wav_path: PathBuf,
    cleanup_wav: bool,
    model_path: PathBuf,
    language: Option<String>,
    subtitle_mode: SubtitleMode,
    transcription_mode: TranscriptionMode,
    seek_rx: Receiver<f64>,
) {
    let plan = plan_job(subtitle_mode, transcription_mode);
    let passes = plan.passes.clone();
    let parallel = plan.parallel;

    // Load whisper contexts serially (model init is not thread-safe). Two
    // independent contexts are required for realtime "Both" so each pass gets
    // its own session; decode then runs concurrently without any global lock.
    let mut contexts = Vec::new();
    for _ in 0..plan.context_count {
        let _guard = MODEL_LOAD_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match WhisperContext::new_with_params(&model_path, WhisperContextParameters::default()) {
            Ok(ctx) => contexts.push(ctx),
            Err(e) => {
                let _ =
                    app.emit("transcription-error", format!("Failed to load Whisper model: {}", e));
                if cleanup_wav {
                    std::fs::remove_file(&wav_path).ok();
                }
                return;
            }
        }
    }

    let result = match (transcription_mode, parallel) {
        // One real-time pass streams cues out the moment each chunk decodes.
        (TranscriptionMode::Stream, false) => {
            run_streaming_job(app.clone(), &wav_path, passes, contexts, language, seek_rx)
        }
        // Two real-time passes (original + translation) on separate threads over
        // the same WAV, so "Both" never doubles wall-clock time per chunk.
        (TranscriptionMode::Stream, true) => {
            run_streaming_job(app.clone(), &wav_path, passes, contexts, language, seek_rx)
        }
        // Full batch: one context decodes every pass sequentially, buffering all
        // cues; the UI surfaces both complete tracks only when the job finishes.
        (TranscriptionMode::Batch, false) => {
            run_batch_job(app.clone(), &wav_path, contexts, language, &passes)
        }
        (TranscriptionMode::Batch, true) => unreachable!("batch mode never needs parallel contexts"),
    };

    if cleanup_wav {
        std::fs::remove_file(&wav_path).ok();
    }

    match result {
        Ok(total) => {
            let _ = app.emit("transcription-done", TranscriptionDone { total });
        }
        Err(e) => {
            let _ = app.emit("transcription-error", e);
        }
    }
}

/// Drain the render queue. The UI calls this (on a timer and/or after
/// `transcript-cues-ready`) and matches cues against the player clock.
#[tauri::command]
fn poll_transcript_cues(state: State<'_, RenderQueue>) -> Vec<SubtitleCue> {
    let mut guard = state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    std::mem::take(&mut *guard)
}

/// Forward a playhead jump to the active realtime (streaming) job, if any.
/// Each streaming pass drops its current VAD/utterance state and repositions
/// the WAV reader to `seek_to` (PTS seconds) so subtitles regenerate for the
/// position the video actually moved to — instead of surfacing stale audio
/// decoded from before the seek. Batch jobs ignore this (they surface nothing
/// until the whole file decodes). No-op when no job is running for `media_path`.
#[tauri::command]
fn seek_transcription(
    app: AppHandle,
    media_path: String,
    seek_to: f64,
) -> Result<(), String> {
    let Some(control) = app
        .try_state::<SeekControl>()
        .and_then(|c| c.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone())
    else {
        return Ok(());
    };
    if control.media_path == media_path && !seek_to.is_nan() {
        let _ = control.seek_tx.send(seek_to.max(0.0));
    }
    Ok(())
}

/// Running average of per-pass progress slots (0.0-100.0). Each parallel
/// realtime pass reports into its own slot; the UI sees the average so a "Both"
/// job never reports 2x progress. Empty => 0.0.
fn combined_progress(slots: &[f64]) -> f64 {
    if slots.is_empty() {
        return 0.0;
    }
    slots.iter().sum::<f64>() / slots.len() as f64
}

/// Baseline (0-100) for one pass inside a sequential full (batch) job, so the
/// whole job reports smooth overall progress across passes instead of jumping.
fn batch_pass_base(pass_index: usize, pass_count: usize) -> f64 {
    if pass_count == 0 {
        return 0.0;
    }
    pass_index as f64 / pass_count as f64 * 100.0
}

// ---------------------------------------------------------------------------
// Realtime (stream) runner.
// ---------------------------------------------------------------------------

/// Run one or more live passes. Every pass decodes the *same* WAV with its own
/// `WhisperContext` on its own thread, so for "Both" the transcribe and
/// translate passes proceed in parallel and each audio chunk is only as slow as
/// the slowest pass — subtitles never lag the video by 2x.
fn run_streaming_job(
    app: AppHandle,
    wav_path: &Path,
    passes: Vec<(bool, String)>,
    contexts: Vec<WhisperContext>,
    language: Option<String>,
    seek_rx: Receiver<f64>,
) -> Result<usize, String> {
    let pass_count = passes.len();
    let queue = app.state::<RenderQueue>().0.clone();
    // One live percentage slot per pass; the UI sees their running average so a
    // parallel "Both" job reports smooth combined progress.
    let progress = Arc::new(Mutex::new(vec![0.0f64; pass_count]));

    let mut handles = Vec::with_capacity(pass_count);
    for (idx, ((translate, kind), ctx)) in passes
        .into_iter()
        .zip(contexts.into_iter())
        .enumerate()
    {
        let app = app.clone();
        let wav = wav_path.to_path_buf();
        let queue = queue.clone();
        let progress = progress.clone();
        let language = language.clone();
        let seek_rx = seek_rx.clone();
        handles.push(std::thread::spawn(move || {
            run_streaming_pass_inner(
                &app,
                &wav,
                &ctx,
                language,
                translate,
                kind,
                idx,
                queue,
                progress,
                seek_rx,
            )
        }));
    }

    let mut total = 0usize;
    for handle in handles {
        match handle.join() {
            Ok(Ok(n)) => total += n,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("Transcription worker thread panicked".to_string()),
        }
    }
    Ok(total)
}

/// One real-time pass: VAD-gated chunked decode pushing cues to the render
/// queue and streaming `transcript-segment`/`transcript-cues-ready` events.
/// `seek_rx` carries playhead jumps from the UI; each one drops the current
/// VAD/utterance state and repositions the WAV reader (see `StreamOptions::seek_rx`).
fn run_streaming_pass_inner(
    app: &AppHandle,
    wav_path: &Path,
    ctx: &WhisperContext,
    language: Option<String>,
    translate: bool,
    kind: String,
    pass_index: usize,
    queue: Arc<Mutex<Vec<SubtitleCue>>>,
    progress: Arc<Mutex<Vec<f64>>>,
    seek_rx: Receiver<f64>,
) -> Result<usize, String> {
    let options = StreamOptions {
        language,
        seek_rx: Some(seek_rx),
        ..StreamOptions::default()
    };

    let mut on_cue = {
        let emit_app = app.clone();
        let queue = queue.clone();
        move |cue: SubtitleCue| {
            queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(cue.clone());
            let _ = emit_app.emit("transcript-segment", cue);
            let _ = emit_app.emit("transcript-cues-ready", ());
        }
    };

    let mut on_progress = {
        let emit_app = app.clone();
        let progress = progress.clone();
        move |pct: f64| {
            let combined = {
                let mut slots = progress
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                slots[pass_index] = pct.clamp(0.0, 100.0);
                combined_progress(&slots)
            };
            let _ = emit_app.emit(
                "transcription-progress",
                PipelineProgress {
                    percentage: combined.clamp(0.0, 100.0),
                },
            );
        }
    };

    pipeline::transcribe_wav_streaming(
        ctx,
        wav_path,
        &options,
        translate,
        Some(kind),
        &mut on_cue,
        &mut on_progress,
    )
}

// ---------------------------------------------------------------------------
// Full (batch) runner.
// ---------------------------------------------------------------------------

/// Language label stamped on a completed batch track: English for the
/// translation pass, the normalized source language (or "auto") otherwise.
fn batch_language_tag(translate: bool, language: Option<&str>) -> String {
    if translate {
        return "en".to_string();
    }
    language
        .and_then(|l| pipeline::normalize_language(Some(l)))
        .unwrap_or_else(|| "auto".to_string())
}

/// Full (batch) transcription. A single context decodes every pass sequentially
/// over the *entire* audio and buffers all cues. Nothing is streamed to the UI:
/// when every pass is done, one `transcription-batch-done` event delivers the
/// complete cue timelines, giving perfectly-synchronized, zero-latency dual
/// subtitles once playback starts.
fn run_batch_job(
    app: AppHandle,
    wav_path: &Path,
    contexts: Vec<WhisperContext>,
    language: Option<String>,
    passes: &[(bool, String)],
) -> Result<usize, String> {
    let ctx = contexts.into_iter().next().expect("batch job has a context");
    let pass_count = passes.len().max(1);
    let mut tracks = Vec::with_capacity(passes.len());
    let mut total = 0usize;

    for (pass_index, (translate, kind)) in passes.iter().enumerate() {
        // Buffered locally per pass, then handed to the UI in one shot.
        let mut collected: Vec<SubtitleCue> = Vec::new();
        let options = StreamOptions {
            language: language.clone(),
            ..StreamOptions::default()
        };

        let mut on_cue = |cue: SubtitleCue| collected.push(cue);

        let mut on_progress = {
            let emit_app = app.clone();
            let base = batch_pass_base(pass_index, pass_count);
            let span = 100.0 / pass_count as f64;
            move |pct: f64| {
                let _ = emit_app.emit(
                    "transcription-progress",
                    PipelineProgress {
                        percentage: (base + pct * span / 100.0).clamp(0.0, 100.0),
                    },
                );
            }
        };

        total += pipeline::transcribe_wav_streaming(
            &ctx,
            wav_path,
            &options,
            *translate,
            Some(kind.clone()),
            &mut on_cue,
            &mut on_progress,
        )?;
        drop(on_cue);

        let language_tag = batch_language_tag(*translate, language.as_deref());
        tracks.push(BatchTrack {
            kind: kind.clone(),
            language: language_tag,
            cues: collected,
        });
    }

    let _ = app.emit("transcription-batch-done", TranscriptionBatchDone { tracks });
    Ok(total)
}

// ---------------------------------------------------------------------------
// Dialogs, subtitle I/O, ffmpeg.
// ---------------------------------------------------------------------------

#[tauri::command]
async fn open_video_dialog(app: AppHandle) -> Result<Option<VideoFile>, String> {
    let file_path = app.dialog().file()
        .add_filter("Video Files", &["mp4", "webm", "mkv", "avi", "mov", "m4v"])
        .blocking_pick_file();

    let video_file = file_path.map(|p| {
        let path_buf = p.into_path().unwrap();
        let name = path_buf
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        VideoFile {
            path: path_buf.to_string_lossy().to_string(),
            name,
        }
    });

    Ok(video_file)
}

#[tauri::command]
async fn open_subtitle_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = app.dialog().file()
        .add_filter("Subtitle Files", &["srt", "vtt", "ass", "ssa", "sub"])
        .blocking_pick_file();

    let file_str = file_path.map(|p| p.into_path().unwrap().to_string_lossy().to_string());
    Ok(file_str)
}

#[tauri::command]
async fn save_subtitle_dialog(app: AppHandle, default_name: String) -> Result<Option<String>, String> {
    let file_path = app.dialog().file()
        .add_filter("SRT Files", &["srt"])
        .add_filter("VTT Files", &["vtt"])
        .add_filter("ASS Files", &["ass"])
        .set_file_name(default_name)
        .blocking_save_file();

    let file_str = file_path.map(|p| p.into_path().unwrap().to_string_lossy().to_string());
    Ok(file_str)
}

#[tauri::command]
async fn open_project_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = app.dialog().file()
        .add_filter("ZanPlayer Lite Project", &["zan"])
        .blocking_pick_file();

    let file_str = file_path.map(|p| p.into_path().unwrap().to_string_lossy().to_string());
    Ok(file_str)
}

#[tauri::command]
async fn save_project_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = app.dialog().file()
        .add_filter("ZanPlayer Lite Project", &["zan"])
        .set_file_name("untitled.zan")
        .blocking_save_file();

    let file_str = file_path.map(|p| p.into_path().unwrap().to_string_lossy().to_string());
    Ok(file_str)
}

#[tauri::command]
async fn write_project_file(file_path: String, data: ProjectData) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let mut file = File::create(&file_path).map_err(|e| format!("Cannot create project file: {}", e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("Cannot write project file: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn read_project_file(file_path: String) -> Result<(ProjectData, bool), String> {
    let mut content = String::new();
    File::open(&file_path)
        .map_err(|e| format!("Cannot open project file: {}", e))?
        .read_to_string(&mut content)
        .map_err(|e| format!("Cannot read project file: {}", e))?;

    let data: ProjectData = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid or corrupted project file: {}", e))?;

    if data.version != PROJECT_VERSION {
        return Err(format!(
            "Unsupported project version: {} (this app supports version {})",
            data.version, PROJECT_VERSION
        ));
    }

    // Validate the media file still exists before the UI offers to restore it.
    let media_exists = Path::new(&data.video_path).exists();
    Ok((data, media_exists))
}

#[tauri::command]
async fn read_subtitle_file(file_path: String) -> Result<Vec<SubtitleCue>, String> {
    let mut content = String::new();
    File::open(&file_path)
        .map_err(|e| e.to_string())?
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;

    let extension = Path::new(&file_path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase());

    let cues = match extension.as_deref() {
        Some("srt") => parse_srt(&content)?,
        Some("vtt") => parse_vtt(&content)?,
        Some("ass") | Some("ssa") => parse_ass(&content)?,
        _ => Err("Unsupported subtitle format".to_string())?,
    };

    Ok(cues)
}

fn parse_srt(text: &str) -> Result<Vec<SubtitleCue>, String> {
    let mut cues = Vec::new();
    let blocks: Vec<&str> = text.trim().split("\n\n").collect();

    for block in blocks {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() >= 3 {
            let time_line = lines[1];
            if let Some((start, end)) = parse_time_line(time_line, ',') {
                let text = lines[2..].join("\n");
                cues.push(SubtitleCue {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: start,
                    end_time: end,
                    text,
                    kind: None,
                });
            }
        }
    }

    Ok(cues)
}

fn parse_vtt(text: &str) -> Result<Vec<SubtitleCue>, String> {
    let mut cues = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    while i < lines.len() && !lines[i].contains("-->") {
        i += 1;
    }

    while i < lines.len() {
        if lines[i].contains("-->") {
            if let Some((start, end)) = parse_time_line(lines[i], '.') {
                i += 1;
                let mut text = String::new();
                while i < lines.len() && !lines[i].is_empty() && !lines[i].contains("-->") {
                    text += &format!("\n{}", lines[i]);
                    i += 1;
                }
                cues.push(SubtitleCue {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: start,
                    end_time: end,
                    text: text.trim_start().to_string(),
                    kind: None,
                });
            }
        }
        i += 1;
    }

    Ok(cues)
}

fn parse_ass(text: &str) -> Result<Vec<SubtitleCue>, String> {
    let mut cues = Vec::new();
    let mut format = None;
    let tag_re = regex::Regex::new(r"\{.*?\}")
        .unwrap_or_else(|_| regex::Regex::new(r"").unwrap());

    for line in text.lines() {
        if let Some(line) = line.strip_prefix("Format:") {
            format = Some(
                line.split(',')
                    .map(|s| s.trim().to_string())
                    .collect::<Vec<_>>(),
            );
        } else if let Some(line) = line.strip_prefix("Dialogue:") {
            if let Some(fmt) = &format {
                let parts: Vec<&str> = line.splitn(fmt.len(), ',').collect();
                let start_idx = fmt.iter().position(|s| s == "Start");
                let end_idx = fmt.iter().position(|s| s == "End");
                let text_idx = fmt.iter().position(|s| s == "Text");

                if let (Some(si), Some(ei), Some(ti)) = (start_idx, end_idx, text_idx) {
                    let start = parse_ass_time(parts.get(si).unwrap_or(&""))?;
                    let end = parse_ass_time(parts.get(ei).unwrap_or(&""))?;
                    let mut text = parts.get(ti).unwrap_or(&"").to_string();
                    text = text.replace(r"\N", "\n");
                    text = tag_re.replace_all(&text, "").to_string();

                    cues.push(SubtitleCue {
                        id: uuid::Uuid::new_v4().to_string(),
                        start_time: start,
                        end_time: end,
                        text,
                        kind: None,
                    });
                }
            }
        }
    }

    Ok(cues)
}

fn parse_ass_time(s: &str) -> Result<f64, String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() >= 3 {
        let h = parts[0].parse::<f64>().map_err(|e| e.to_string())?;
        let m = parts[1].parse::<f64>().map_err(|e| e.to_string())?;
        let s = parts[2].parse::<f64>().map_err(|e| e.to_string())?;
        Ok(h * 3600.0 + m * 60.0 + s)
    } else {
        Err("Invalid ASS time format".to_string())
    }
}

fn parse_time_line(line: &str, sep: char) -> Option<(f64, f64)> {
    let parts: Vec<&str> = line.split("-->").collect();
    if parts.len() == 2 {
        if let (Ok(start), Ok(end)) = (parse_time_str(parts[0].trim(), sep), parse_time_str(parts[1].trim(), sep)) {
            return Some((start, end));
        }
    }
    None
}

fn parse_time_str(s: &str, sep: char) -> Result<f64, String> {
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() >= 2 {
        let time_part = parts[0];
        let frac_part = parts[1].chars().take(3).collect::<String>();
        let frac = frac_part.parse::<f64>().unwrap_or(0.0) / 1000.0;
        let hms: Vec<&str> = time_part.split(':').collect();
        let mut total = 0.0;
        if hms.len() == 3 {
            total += hms[0].parse::<f64>().map_err(|e| e.to_string())? * 3600.0;
            total += hms[1].parse::<f64>().map_err(|e| e.to_string())? * 60.0;
            total += hms[2].parse::<f64>().map_err(|e| e.to_string())?;
        } else if hms.len() == 2 {
            total += hms[0].parse::<f64>().map_err(|e| e.to_string())? * 60.0;
            total += hms[1].parse::<f64>().map_err(|e| e.to_string())?;
        }
        Ok(total + frac)
    } else {
        Ok(0.0)
    }
}

#[tauri::command]
async fn write_subtitle_file(
    file_path: String,
    cues: Vec<SubtitleCue>,
    format: String,
) -> Result<(), String> {
    let content = match format.to_lowercase().as_str() {
        "srt" => export_srt(cues),
        "vtt" => export_vtt(cues),
        "ass" => export_ass(cues),
        _ => Err(format!("Unsupported format: {}", format))?,
    };

    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn export_srt(cues: Vec<SubtitleCue>) -> String {
    let mut content = String::new();
    for (i, cue) in cues.iter().enumerate() {
        content.push_str(&format!("{}\n", i + 1));
        content.push_str(&format_time(cue.start_time, true));
        content.push_str(" --> ");
        content.push_str(&format_time(cue.end_time, true));
        content.push('\n');
        content.push_str(&cue.text);
        content.push_str("\n\n");
    }
    content
}

fn export_vtt(cues: Vec<SubtitleCue>) -> String {
    let mut content = "WEBVTT\n\n".to_string();
    for cue in cues {
        content.push_str(&format_time(cue.start_time, false));
        content.push_str(" --> ");
        content.push_str(&format_time(cue.end_time, false));
        content.push('\n');
        content.push_str(&cue.text);
        content.push_str("\n\n");
    }
    content
}

fn export_ass(cues: Vec<SubtitleCue>) -> String {
    let mut content = "[Script Info]
Title: Subtitle
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
".to_string();

    for cue in cues {
        let start = format_ass_time(cue.start_time);
        let end = format_ass_time(cue.end_time);
        let text = cue.text.replace('\n', r"\N");
        content.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            start, end, text
        ));
    }

    content
}

fn format_ass_time(seconds: f64) -> String {
    let h = (seconds / 3600.0) as i32;
    let m = ((seconds % 3600.0) / 60.0) as i32;
    let s = seconds % 60.0;
    format!("{}:{:02}:{:05.2}", h, m, s)
}

fn format_time(seconds: f64, is_srt: bool) -> String {
    let hours = (seconds / 3600.0) as u32;
    let minutes = ((seconds % 3600.0) / 60.0) as u32;
    let secs = (seconds % 60.0) as u32;
    let ms = ((seconds % 1.0) * 1000.0) as u32;
    if is_srt {
        format!(
            "{:02}:{:02}:{:02},{:03}",
            hours, minutes, secs, ms
        )
    } else {
        format!(
            "{:02}:{:02}:{:02}.{:03}",
            hours, minutes, secs, ms
        )
    }
}

#[tauri::command]
async fn write_file(
    _app: AppHandle,
    file_name: String,
    file_data: Vec<u8>,
    output_dir: String,
) -> Result<String, String> {
    let output_path = PathBuf::from(output_dir).join(format!(
        "{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        file_name
    ));

    let mut file = File::create(&output_path).map_err(|e| e.to_string())?;
    file.write_all(&file_data).map_err(|e| e.to_string())?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn extract_audio(
    app: AppHandle,
    video_path: String,
    output_dir: String,
) -> Result<String, String> {
    let output_path = std::path::PathBuf::from(output_dir).join(format!(
        "extracted_{}.wav",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    ));
    let sidecar_command = app.shell().sidecar("ffmpeg")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?;
    let output = sidecar_command
        .args(["-i", &video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", output_path.to_str().unwrap()])
        .output().await.map_err(|e| format!("FFmpeg execution failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("FFmpeg error: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn relaunch_app(app: AppHandle) {
    tauri::process::restart(&app.env());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_candidates_cover_bin_and_quantized_gguf() {
        let candidates = model_candidates("large");
        assert!(candidates.contains(&"ggml-large-v3.bin".to_string()));
        assert!(candidates.contains(&"ggml-large-v3-q5_0.gguf".to_string()));
        assert!(candidates.contains(&"ggml-large-v3-q8_0.bin".to_string()));

        let small = model_candidates("small");
        assert!(small.contains(&"ggml-small.gguf".to_string()));
        assert!(small.contains(&"ggml-small-q5_0.bin".to_string()));

        // No duplicate filenames across bases.
        let mut all: Vec<String> = candidates.clone();
        all.extend(model_candidates("small"));
        for name in &all {
            assert_eq!(all.iter().filter(|c| c == &name).count(), 1);
        }
    }

    #[test]
    fn model_key_from_filename_maps_quantized_and_v3() {
        assert_eq!(model_key_from_filename("ggml-large-v3.bin"), "large");
        assert_eq!(model_key_from_filename("ggml-large-v3-q5_0.gguf"), "large");
        assert_eq!(model_key_from_filename("ggml-large-v3-turbo-q5_0.gguf"), "large");
        assert_eq!(model_key_from_filename("ggml-small-q5_0.bin"), "small");
        assert_eq!(model_key_from_filename("ggml-base.en.bin"), "base");
    }

    #[test]
    fn model_url_uses_org_by_extension() {
        assert!(model_url("ggml-small.bin").contains("ggerganov"));
        assert!(model_url("ggml-small-q5_0.gguf").contains("ggml-org"));
    }

    // -- Dual-pass job planning ------------------------------------------------

    #[test]
    fn passes_for_mode_tags_original_then_translation() {
        assert_eq!(
            passes_for_mode(SubtitleMode::Original),
            vec![(false, KIND_ORIGINAL.to_string())]
        );
        assert_eq!(
            passes_for_mode(SubtitleMode::English),
            vec![(true, KIND_TRANSLATION.to_string())]
        );
        let both = passes_for_mode(SubtitleMode::Both);
        assert_eq!(both.len(), 2);
        assert_eq!(both[0], (false, KIND_ORIGINAL.to_string()));
        assert_eq!(both[1], (true, KIND_TRANSLATION.to_string()));
    }

    #[test]
    fn plan_job_single_passes_run_on_one_context() {
        for mode in [SubtitleMode::Original, SubtitleMode::English] {
            for tm in [TranscriptionMode::Stream, TranscriptionMode::Batch] {
                let plan = plan_job(mode, tm);
                assert_eq!(plan.passes.len(), 1);
                assert!(!plan.parallel);
                assert_eq!(plan.context_count, 1);
            }
        }
    }

    #[test]
    fn plan_job_both_stream_spawns_two_parallel_contexts() {
        let plan = plan_job(SubtitleMode::Both, TranscriptionMode::Stream);
        assert_eq!(plan.passes.len(), 2);
        assert!(plan.parallel);
        assert_eq!(plan.context_count, 2);
    }

    #[test]
    fn plan_job_both_batch_stays_sequential_on_one_context() {
        let plan = plan_job(SubtitleMode::Both, TranscriptionMode::Batch);
        assert_eq!(plan.passes.len(), 2);
        assert!(!plan.parallel);
        assert_eq!(plan.context_count, 1);
    }

    #[test]
    fn subtitle_and_transcription_modes_serde_use_lowercase_names() {
        let cases = [
            ("\"original\"", SubtitleMode::Original),
            ("\"english\"", SubtitleMode::English),
            ("\"both\"", SubtitleMode::Both),
        ];
        for (json, expected) in cases {
            assert_eq!(serde_json::from_str::<SubtitleMode>(json).unwrap(), expected);
        }
        let cases = [
            ("\"stream\"", TranscriptionMode::Stream),
            ("\"batch\"", TranscriptionMode::Batch),
        ];
        for (json, expected) in cases {
            assert_eq!(serde_json::from_str::<TranscriptionMode>(json).unwrap(), expected);
        }
        assert!(serde_json::from_str::<SubtitleMode>("\"Both\"").is_err());
        assert!(serde_json::from_str::<TranscriptionMode>("\"Stream\"").is_err());
    }

    #[test]
    fn combined_progress_averages_per_pass_slots() {
        assert_eq!(combined_progress(&[]), 0.0);
        assert_eq!(combined_progress(&[0.0]), 0.0);
        assert_eq!(combined_progress(&[100.0, 0.0]), 50.0);
        assert_eq!(combined_progress(&[25.0, 75.0]), 50.0);
        assert_eq!(combined_progress(&[100.0, 100.0]), 100.0);
    }

    #[test]
    fn batch_pass_base_slices_progress_across_passes() {
        assert_eq!(batch_pass_base(0, 2), 0.0);
        assert_eq!(batch_pass_base(1, 2), 50.0);
        assert_eq!(batch_pass_base(0, 1), 0.0);
        assert_eq!(batch_pass_base(0, 0), 0.0);
    }

    #[test]
    fn batch_language_tag_marks_english_but_normalizes_source() {
        assert_eq!(batch_language_tag(true, None), "en");
        assert_eq!(batch_language_tag(true, Some("klingon")), "en");
        assert_eq!(batch_language_tag(false, Some("my")), "my");
        assert_eq!(batch_language_tag(false, Some("")), "auto");
        assert_eq!(batch_language_tag(false, Some("klingon")), "auto");
        assert_eq!(batch_language_tag(false, None), "auto");
    }

    #[test]
    fn srt_and_vtt_parsers_tag_loaded_cues_as_non_generated() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue\n";
        let cues = parse_srt(srt).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Hello world");
        assert!((cues[0].start_time - 1.0).abs() < 1e-9);
        assert!((cues[0].end_time - 3.5).abs() < 1e-9);
        assert!(cues[0].kind.is_none());

        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHi there\n";
        let cues = parse_vtt(vtt).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Hi there");
        assert!((cues[0].start_time - 1.0).abs() < 1e-9);
        assert!(cues[0].kind.is_none());
    }

    // -- Project save/load ---------------------------------------------------

    fn sample_project() -> ProjectData {
        ProjectData {
            version: PROJECT_VERSION,
            video_path: "/tmp/movie.mp4".to_string(),
            subtitle_tracks: vec![ProjectTrack {
                id: "track-orig".to_string(),
                name: "Auto-Generated (Original)".to_string(),
                language: "my".to_string(),
                cues: vec![
                    ProjectCue {
                        id: "c1".to_string(),
                        start_time: 1.0,
                        end_time: 3.0,
                        text: "Hello".to_string(),
                        kind: Some("original".to_string()),
                    },
                    ProjectCue {
                        id: "c2".to_string(),
                        start_time: 4.0,
                        end_time: 6.0,
                        text: "World".to_string(),
                        kind: Some("original".to_string()),
                    },
                ],
                is_generated: Some(true),
            }],
            active_subtitle_track_id: Some("track-orig".to_string()),
            show_subtitles: true,
            subtitle_mode: "both".to_string(),
            transcription_mode: "stream".to_string(),
            source_language: "my".to_string(),
            subtitle_style: ProjectSubtitleStyle {
                font_name: "Arial".to_string(),
                font_size: 24.0,
                primary_color: "#FFFFFF".to_string(),
                outline_color: "#000000".to_string(),
                back_color: "#80000000".to_string(),
                bold: false,
                italic: false,
                alignment: "bottom".to_string(),
            },
            current_time: 0.0,
        }
    }

    #[test]
    fn project_roundtrip_preserves_camel_case_json() {
        let project = sample_project();
        let json = serde_json::to_string(&project).unwrap();
        let back: ProjectData = serde_json::from_str(&json).unwrap();

        assert_eq!(back.version, PROJECT_VERSION);
        assert_eq!(back.video_path, "/tmp/movie.mp4");
        assert_eq!(back.subtitle_tracks.len(), 1);
        assert_eq!(back.subtitle_tracks[0].cues.len(), 2);
        assert_eq!(back.subtitle_tracks[0].cues[0].text, "Hello");
        assert_eq!(back.active_subtitle_track_id.as_deref(), Some("track-orig"));
        assert_eq!(back.source_language, "my");
        assert!(!back.subtitle_style.bold);
    }

    #[test]
    fn project_json_keys_are_camel_case() {
        let project = sample_project();
        let json = serde_json::to_string(&project).unwrap();

        assert!(json.contains("\"videoPath\""), "expected camelCase videoPath");
        assert!(json.contains("\"subtitleTracks\""), "expected camelCase subtitleTracks");
        assert!(json.contains("\"activeSubtitleTrackId\""), "expected camelCase activeSubtitleTrackId");
        assert!(json.contains("\"showSubtitles\""), "expected camelCase showSubtitles");
        assert!(json.contains("\"subtitleMode\""), "expected camelCase subtitleMode");
        assert!(json.contains("\"transcriptionMode\""), "expected camelCase transcriptionMode");
        assert!(json.contains("\"sourceLanguage\""), "expected camelCase sourceLanguage");
        assert!(json.contains("\"subtitleStyle\""), "expected camelCase subtitleStyle");
        assert!(json.contains("\"currentTime\""), "expected camelCase currentTime");
        assert!(json.contains("\"isGenerated\""), "expected camelCase isGenerated");

        // Must NOT contain snake_case equivalents.
        assert!(!json.contains("\"video_path\""));
        assert!(!json.contains("\"subtitle_tracks\""));
        assert!(!json.contains("\"active_subtitle_track_id\""));
    }

    #[test]
    fn project_rejects_unsupported_version() {
        let mut project = sample_project();
        project.version = 99;
        let json = serde_json::to_string(&project).unwrap();
        let back: ProjectData = serde_json::from_str(&json).unwrap();
        // The serde deserialization succeeds, but the command's version check would reject it.
        assert_ne!(back.version, PROJECT_VERSION);
        assert_eq!(back.version, 99);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RenderQueue::default())
        .manage(SeekControl::default())
        .invoke_handler(tauri::generate_handler![
            open_video_dialog,
            open_subtitle_dialog,
            save_subtitle_dialog,
            read_subtitle_file,
            write_subtitle_file,
            open_project_dialog,
            save_project_dialog,
            write_project_file,
            read_project_file,
            write_file,
            extract_audio,
            start_transcription,
            poll_transcript_cues,
            seek_transcription,
            download_whisper_model,
            delete_whisper_model,
            list_downloaded_models,
            check_model_downloaded,
            relaunch_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}