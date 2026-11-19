use rand::Rng;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};

const MAX_CLIPBOARD_BYTES: usize = 50 * 1024 * 1024;
const KEEP_MAX_FILES: usize = 10;
const KEEP_MAX_AGE_SECS: u64 = 10 * 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardMeta {
    pub source: String,
    pub pack_id: String,
    pub item_id: String,
    pub resize: u32,
    pub ext: String,
}

pub fn decode_clipboard_frame(bytes: &[u8]) -> Result<(ClipboardMeta, &[u8]), String> {
    if bytes.len() < 4 {
        return Err("Clipboard frame too short".to_string());
    }
    let meta_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if meta_len == 0 || meta_len > 16 * 1024 {
        return Err("Invalid clipboard metadata length".to_string());
    }
    let payload_offset = 4 + meta_len;
    if bytes.len() <= payload_offset {
        return Err("Clipboard frame missing media payload".to_string());
    }
    let meta_json = std::str::from_utf8(&bytes[4..payload_offset])
        .map_err(|e| format!("Invalid UTF-8 in clipboard metadata: {}", e))?;
    let meta: ClipboardMeta = serde_json::from_str(meta_json)
        .map_err(|e| format!("Invalid JSON in clipboard metadata: {}", e))?;
    let payload = &bytes[payload_offset..];
    if payload.len() > MAX_CLIPBOARD_BYTES {
        return Err("Clipboard media exceeds 50MB limit".to_string());
    }
    Ok((meta, payload))
}

fn is_valid_id(val: &str) -> bool {
    !val.is_empty()
        && val.len() <= 64
        && val
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn validate_clipboard_meta(meta: &ClipboardMeta) -> Result<(), String> {
    if meta.source != "arca" && meta.source != "dc" {
        return Err(format!("Invalid source: {}", meta.source));
    }
    if !is_valid_id(&meta.pack_id) {
        return Err(format!("Invalid packId: {}", meta.pack_id));
    }
    if !is_valid_id(&meta.item_id) {
        return Err(format!("Invalid itemId: {}", meta.item_id));
    }
    let ext = meta.ext.as_str();
    if !matches!(ext, "gif" | "png" | "jpg" | "jpeg" | "webp") {
        return Err(format!("Disallowed extension: {}", meta.ext));
    }
    Ok(())
}

pub fn get_staging_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("DiscordConApp").join("clipboard");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create staging dir: {}", e))?;
    fs::canonicalize(&dir).map_err(|e| format!("Failed to canonicalize staging dir: {}", e))
}

pub fn strip_unc_prefix(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s.into_owned()
    }
}

pub fn cleanup_staging_dir() {
    let Ok(dir) = get_staging_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };

    let now = SystemTime::now();
    let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        files.push((path, modified));
    }

    files.sort_by(|a, b| b.1.cmp(&a.1));

    for (idx, (path, modified)) in files.into_iter().enumerate() {
        let age_secs = now
            .duration_since(modified)
            .map(|d| d.as_secs())
            .unwrap_or(u64::MAX);
        if idx >= KEEP_MAX_FILES && age_secs > KEEP_MAX_AGE_SECS {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
fn set_clipboard_hdrop(file_path: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{GlobalFree, BOOL, HANDLE, HGLOBAL, HWND, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    let normalized = strip_unc_prefix(file_path);
    let mut wide: Vec<u16> = OsStr::new(&normalized).encode_wide().collect();
    wide.push(0); // single null for path
    wide.push(0); // double null terminator for DROPFILES list

    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let path_bytes_len = wide.len() * std::mem::size_of::<u16>();
    let total_bytes = dropfiles_size + path_bytes_len;

    unsafe {
        let h_global: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes)
            .map_err(|e| format!("GlobalAlloc failed: {}", e))?;

        let ptr = GlobalLock(h_global);
        if ptr.is_null() {
            let _ = GlobalFree(h_global);
            return Err("GlobalLock failed".to_string());
        }

        let dropfiles = DROPFILES {
            pFiles: dropfiles_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: BOOL(0),
            fWide: BOOL(1),
        };
        std::ptr::copy_nonoverlapping(&dropfiles, ptr as *mut DROPFILES, 1);

        let dest_wide = (ptr as *mut u8).add(dropfiles_size) as *mut u16;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dest_wide, wide.len());

        let _ = GlobalUnlock(h_global);

        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(HWND::default()).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        if !opened {
            let _ = GlobalFree(h_global);
            return Err("클립보드가 다른 프로그램에 의해 사용 중입니다.".to_string());
        }

        if let Err(e) = EmptyClipboard() {
            let _ = CloseClipboard();
            let _ = GlobalFree(h_global);
            return Err(format!("EmptyClipboard failed: {}", e));
        }

        let res = SetClipboardData(CF_HDROP.0 as u32, HANDLE(h_global.0));
        let _ = CloseClipboard();

        if let Err(e) = res {
            let _ = GlobalFree(h_global);
            return Err(format!("SetClipboardData failed: {}", e));
        }
    }

    Ok(())
}

#[cfg(not(windows))]
fn set_clipboard_hdrop(_file_path: &Path) -> Result<(), String> {
    Err("CF_HDROP clipboard is only supported on Windows".to_string())
}

#[cfg(windows)]
fn is_process_handle_elevated(process: windows::Win32::Foundation::HANDLE) -> Result<bool, ()> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::OpenProcessToken;

    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.is_err() {
        return Err(());
    }

    let mut elevation = TOKEN_ELEVATION::default();
    let mut return_len: u32 = 0;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_len,
        )
    };
    let _ = unsafe { CloseHandle(token) };

    if ok.is_err() {
        return Err(());
    }
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(windows)]
async fn send_ctrl_v() -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_CONTROL, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    {
        let self_elevated = is_process_handle_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false);
        if !self_elevated {
            let fg = unsafe { GetForegroundWindow() };
            let mut pid: u32 = 0;
            unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
            if pid != 0 {
                if let Ok(handle) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
                    let target_elevated = is_process_handle_elevated(handle);
                    let _ = unsafe { CloseHandle(handle) };
                    match target_elevated {
                        Ok(true) | Err(()) => {
                            return Err(
                                "클립보드에 복사되었지만 대상 앱이 관리자 권한으로 실행 중이어서 자동 붙여넣기가 차단되었습니다. Ctrl+V로 직접 붙여넣거나 여기서까지콘을써야겠냐를 관리자 권한으로 실행해 주세요."
                                    .to_string(),
                            );
                        }
                        Ok(false) => {}
                    }
                }
            }
        }
    }

    fn send_key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> Result<(), String> {
        let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent != 1 {
            return Err("자동 붙여넣기(Ctrl+V) 입력 전송에 실패했습니다.".to_string());
        }
        Ok(())
    }

    send_key(VK_CONTROL, KEYBD_EVENT_FLAGS(0))?;
    tokio::time::sleep(Duration::from_millis(20)).await;
    send_key(VK_V, KEYBD_EVENT_FLAGS(0))?;
    tokio::time::sleep(Duration::from_millis(20)).await;
    send_key(VK_V, KEYEVENTF_KEYUP)?;
    tokio::time::sleep(Duration::from_millis(20)).await;
    send_key(VK_CONTROL, KEYEVENTF_KEYUP)?;

    Ok(())
}

#[cfg(not(windows))]
async fn send_ctrl_v() -> Result<(), String> {
    Err("Auto-paste is only supported on Windows".to_string())
}

#[tauri::command]
pub async fn copy_media_to_clipboard(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<(), String> {
    let bytes = match request.body() {
        InvokeBody::Raw(raw) => raw.as_slice(),
        InvokeBody::Json(_) => return Err("Expected raw binary body".to_string()),
    };

    let (meta, payload) = decode_clipboard_frame(bytes)?;
    validate_clipboard_meta(&meta)?;

    let staging_root = get_staging_dir()?;
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand_hex: u32 = rand::thread_rng().gen();

    let filename = format!(
        "{}_{}_{}_{}_{}_{:08x}.{}",
        meta.source, meta.pack_id, meta.item_id, meta.resize, timestamp_ms, rand_hex, meta.ext
    );

    let target = staging_root.join(&filename);
    if !target.starts_with(&staging_root) {
        return Err("Path traversal detected".to_string());
    }

    fs::write(&target, payload).map_err(|e| format!("Failed to write staging file: {}", e))?;
    let canonical_target = fs::canonicalize(&target)
        .map_err(|e| format!("Failed to canonicalize staging file: {}", e))?;
    if !canonical_target.starts_with(&staging_root) {
        let _ = fs::remove_file(&canonical_target);
        return Err("Path traversal detected after canonicalize".to_string());
    }

    set_clipboard_hdrop(&canonical_target)?;
    cleanup_staging_dir();

    let target_hwnd = crate::window::restore_previous_foreground_window(&app);
    crate::window::hide_overlay(&app);

    for _ in 0..30 {
        if crate::window::is_target_foreground(&app, target_hwnd) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    send_ctrl_v().await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_and_validate_clipboard_frame() {
        let meta_json = br#"{"source":"arca","packId":"53122","itemId":"101","resize":120,"ext":"gif"}"#;
        let mut frame = Vec::new();
        frame.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
        frame.extend_from_slice(meta_json);
        frame.extend_from_slice(b"GIF89a...");

        let (meta, payload) = decode_clipboard_frame(&frame).unwrap();
        assert_eq!(meta.source, "arca");
        assert_eq!(meta.pack_id, "53122");
        assert_eq!(meta.item_id, "101");
        assert_eq!(meta.resize, 120);
        assert_eq!(meta.ext, "gif");
        assert_eq!(payload, b"GIF89a...");
        assert!(validate_clipboard_meta(&meta).is_ok());
    }

    #[test]
    fn test_validate_rejects_traversal_and_bad_ext() {
        let bad_id = ClipboardMeta {
            source: "arca".into(),
            pack_id: "../etc".into(),
            item_id: "1".into(),
            resize: 120,
            ext: "gif".into(),
        };
        assert!(validate_clipboard_meta(&bad_id).is_err());

        let bad_ext = ClipboardMeta {
            source: "dc".into(),
            pack_id: "123".into(),
            item_id: "1".into(),
            resize: 120,
            ext: "exe".into(),
        };
        assert!(validate_clipboard_meta(&bad_ext).is_err());

        let bad_source = ClipboardMeta {
            source: "http".into(),
            pack_id: "123".into(),
            item_id: "1".into(),
            resize: 120,
            ext: "png".into(),
        };
        assert!(validate_clipboard_meta(&bad_source).is_err());
    }

    #[test]
    fn test_strip_unc_prefix() {
        let p = Path::new(r"\\?\C:\Users\user\AppData\Local\DiscordConApp\clipboard\test.gif");
        assert_eq!(
            strip_unc_prefix(p),
            r"C:\Users\user\AppData\Local\DiscordConApp\clipboard\test.gif"
        );
    }
}
