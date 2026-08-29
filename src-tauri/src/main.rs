// Multi Screen Recorder - Tauri main process
// Manages settings, filesystem, ffmpeg conversion

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod encoder;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::http;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    recordings_dir: Mutex<PathBuf>,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(rename = "recordingsDir")]
    recordings_dir: Option<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn default_recordings_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("recordings")
}

fn load_recordings_dir(app: &AppHandle) -> PathBuf {
    if let Some(path) = settings_path(app) {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&raw) {
                if let Some(dir) = settings.recordings_dir {
                    let dir = PathBuf::from(dir);
                    if dir.exists() {
                        return dir;
                    }
                }
            }
        }
    }
    default_recordings_dir(app)
}

fn save_settings(app: &AppHandle, recordings_dir: &PathBuf) {
    if let Some(path) = settings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let settings = Settings {
            recordings_dir: Some(recordings_dir.to_string_lossy().to_string()),
        };
        if let Ok(json) = serde_json::to_string_pretty(&settings) {
            let _ = fs::write(path, json);
        }
    }
}

fn ensure_dir(dir: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create recordings folder: {e}"))
}

#[tauri::command]
fn get_recordings_path(state: State<'_, AppState>) -> String {
    state
        .recordings_dir
        .lock()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn open_recordings_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.recordings_dir.lock().unwrap().clone();
    ensure_dir(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// Open the author's address in the user's mail client, from the About dialog.
#[tauri::command]
fn open_feedback_email(app: AppHandle) -> Result<(), String> {
    let url = "mailto:thanhduc@banmai.org?subject=Multi%20Screen%20Recorder%20feedback";
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct PickResult {
    canceled: bool,
    path: Option<String>,
}

#[tauri::command]
async fn change_recordings_path(app: AppHandle) -> Result<PickResult, String> {
    let dialog = app.dialog().clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_title("Select folder to save recordings")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    match picked {
        Some(folder) => {
            let path = folder.into_path().map_err(|e| e.to_string())?;
            ensure_dir(&path)?;
            {
                let state: State<'_, AppState> = app.state();
                *state.recordings_dir.lock().unwrap() = path.clone();
            }
            save_settings(&app, &path);
            Ok(PickResult {
                canceled: false,
                path: Some(path.to_string_lossy().to_string()),
            })
        }
        None => Ok(PickResult {
            canceled: true,
            path: None,
        }),
    }
}

// Save recorded WebM bytes (raw IPC body), run fast metadata fix, return final path
#[tauri::command]
fn save_webm(
    app: AppHandle,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        _ => return Err("Invalid recording data (expected raw bytes)".into()),
    };
    if bytes.is_empty() {
        return Err("Invalid recording data (empty)".into());
    }

    let dir = state.recordings_dir.lock().unwrap().clone();
    ensure_dir(&dir)?;

    let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S");
    let webm_path = dir.join(format!("recording-{stamp}.webm"));
    fs::write(&webm_path, &bytes).map_err(|e| format!("Cannot save recording: {e}"))?;

    // Fast metadata fix (regenerate PTS, no re-encode); keep original file on failure
    let _ = encoder::fix_webm_metadata(&app, &webm_path);

    Ok(webm_path.to_string_lossy().to_string())
}

// Convert WebM to MP4; emits convert-progress {fileName, percent}; deletes source on success
#[tauri::command]
async fn convert_to_mp4(app: AppHandle, webm_path: String) -> Result<String, String> {
    let input = PathBuf::from(&webm_path);
    if !input.exists() {
        return Err("WebM file not found".into());
    }
    let output = input.with_extension("mp4");
    let app2 = app.clone();
    let in2 = input.clone();
    let out2 = output.clone();
    tauri::async_runtime::spawn_blocking(move || encoder::convert_to_mp4(&app2, &in2, &out2, true))
        .await
        .map_err(|e| e.to_string())??;
    let _ = fs::remove_file(&input);
    Ok(output.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct ConvertFileResult {
    canceled: bool,
    path: Option<String>,
    error: Option<String>,
}

// Pick a WebM/video file and convert to MP4 (source kept)
#[tauri::command]
async fn convert_file_to_mp4(app: AppHandle) -> Result<ConvertFileResult, String> {
    let start_dir = {
        let state: State<'_, AppState> = app.state();
        let dir = state.recordings_dir.lock().unwrap().clone();
        dir
    };
    let dialog = app.dialog().clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_title("Select WebM file to convert to MP4")
            .set_directory(start_dir)
            .add_filter("WebM / Video", &["webm", "mkv", "avi"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file) = picked else {
        return Ok(ConvertFileResult {
            canceled: true,
            path: None,
            error: None,
        });
    };
    let input = file.into_path().map_err(|e| e.to_string())?;
    if !input.exists() {
        return Ok(ConvertFileResult {
            canceled: false,
            path: None,
            error: Some("File not found".into()),
        });
    }
    let output = input.with_extension("mp4");
    let app2 = app.clone();
    let in2 = input.clone();
    let out2 = output.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || encoder::convert_to_mp4(&app2, &in2, &out2, true))
            .await
            .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => Ok(ConvertFileResult {
            canceled: false,
            path: Some(output.to_string_lossy().to_string()),
            error: None,
        }),
        Err(e) => Ok(ConvertFileResult {
            canceled: false,
            path: None,
            error: Some(e),
        }),
    }
}

/// Serve a recording over `stream://localhost/<url-encoded path>` with HTTP range
/// support, so the preview player can seek without downloading from the start.
///
/// The built-in `asset:` protocol ignores Range requests, which makes the
/// `<video>` element read a long recording sequentially on every seek.
fn stream_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let not_found = || {
        http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap()
    };

    // stream://localhost/<percent-encoded absolute path>
    let encoded = request.uri().path().trim_start_matches('/');
    let path = match percent_decode(encoded) {
        Some(p) => PathBuf::from(p),
        None => return not_found(),
    };

    let mut file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return not_found(),
    };
    let total = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return not_found(),
    };

    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("mp4") => "video/mp4",
        _ => "video/webm",
    };

    // Parse "Range: bytes=start-end"; absent means serve the whole file.
    let range = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);

    let (start, end) = match range {
        Some((s, e)) => (s.min(total), e.unwrap_or(total - 1).min(total - 1)),
        None => (0, total.saturating_sub(1)),
    };
    if total == 0 || start > end {
        return http::Response::builder()
            .status(416)
            .header(http::header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new())
            .unwrap();
    }

    let len = end - start + 1;
    let mut buf = vec![0u8; len as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
        return not_found();
    }

    let status = if range.is_some() { 206 } else { 200 };
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::ACCEPT_RANGES, "bytes")
        .header(http::header::CONTENT_LENGTH, len.to_string())
        .header(
            http::header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .header("Access-Control-Allow-Origin", "*")
        .body(buf)
        .unwrap()
}

/// Parse a single-range `bytes=start-end` header value.
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end = end.trim();
    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse().ok()?)
    };
    Some((start, end))
}

/// Decode the percent-encoded path segment produced by `encodeURIComponent`.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("stream", stream_protocol)
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = load_recordings_dir(&handle);
            let _ = ensure_dir(&dir);
            app.manage(AppState {
                recordings_dir: Mutex::new(dir),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_recordings_path,
            open_recordings_folder,
            open_feedback_email,
            change_recordings_path,
            save_webm,
            convert_to_mp4,
            convert_file_to_mp4
        ])
        .run(tauri::generate_context!())
        .expect("error while running Multi Screen Recorder");
}
