use futures_util::StreamExt;
use reqwest::{redirect, Client};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::ipc::Response;
use url::Url;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_MEDIA_BYTES: usize = 50 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

pub fn assert_numeric_id(pack_id: &str) -> Result<String, String> {
    let trimmed = pack_id.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("Invalid pack ID: {}", pack_id));
    }
    Ok(trimmed.to_string())
}

pub fn assert_allowed_url(raw_url: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw_url).map_err(|e| format!("Invalid URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Disallowed protocol: {}", parsed.scheme()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Missing host in URL".to_string())?
        .to_ascii_lowercase();

    let allowed = host == "arca.live"
        || host.ends_with(".arca.live")
        || host == "dcinside.com"
        || host.ends_with(".dcinside.com");

    if !allowed {
        return Err(format!("Disallowed host: {}", host));
    }

    Ok(parsed)
}

fn get_http_client() -> Result<&'static Client, String> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client);
    }

    let policy = redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("Too many redirects");
        }
        if let Err(err) = assert_allowed_url(attempt.url().as_str()) {
            return attempt.error(err);
        }
        attempt.follow()
    });

    let client = Client::builder()
        .redirect(policy)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let _ = HTTP_CLIENT.set(client);
    Ok(HTTP_CLIENT.get().expect("HTTP_CLIENT initialized"))
}

pub fn encode_media_frame(status: u16, content_type: &str, payload: &[u8]) -> Vec<u8> {
    let mime_bytes = content_type.as_bytes();
    let mime_len = mime_bytes.len().min(u16::MAX as usize);
    let mut framed = Vec::with_capacity(4 + mime_len + payload.len());
    framed.extend_from_slice(&status.to_le_bytes());
    framed.extend_from_slice(&(mime_len as u16).to_le_bytes());
    framed.extend_from_slice(&mime_bytes[..mime_len]);
    framed.extend_from_slice(payload);
    framed
}

#[tauri::command]
pub async fn fetch_arca_pack(pack_id: String) -> Result<Value, String> {
    let id = assert_numeric_id(&pack_id)?;
    let url = format!("https://arca.live/api/emoticon2/{}", id);
    assert_allowed_url(&url)?;

    let client = get_http_client()?;
    let res = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", format!("https://arca.live/e/{}", id))
        .send()
        .await
        .map_err(|e| format!("Arca request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Arca API failed ({})", res.status()));
    }

    let data: Value = res
        .json()
        .await
        .map_err(|e| format!("Arca API JSON parse failed: {}", e))?;

    if !data.is_array() {
        return Err("Arca API returned unexpected payload".to_string());
    }

    Ok(data)
}

#[tauri::command]
pub async fn fetch_dc_pack(pack_id: String) -> Result<Value, String> {
    let id = assert_numeric_id(&pack_id)?;
    let url = "https://dccon.dcinside.com/index/package_detail";
    assert_allowed_url(url)?;

    let client = get_http_client()?;
    let res = client
        .post(url)
        .header("User-Agent", USER_AGENT)
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        )
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", "https://dccon.dcinside.com/")
        .header("Origin", "https://dccon.dcinside.com")
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .body(format!("package_idx={}", id))
        .send()
        .await
        .map_err(|e| format!("DCInside request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("DCInside API failed ({})", res.status()));
    }

    let data: Value = res
        .json()
        .await
        .map_err(|e| format!("DCInside API JSON parse failed: {}", e))?;

    if !data.get("detail").map(|d| d.is_array()).unwrap_or(false) {
        return Err("DCInside API returned empty or invalid package".to_string());
    }

    Ok(data)
}

#[tauri::command]
pub async fn fetch_media(url: String, source: String) -> Result<Response, String> {
    let parsed = assert_allowed_url(&url)?;
    let referer = match source.as_str() {
        "dc" => "https://dccon.dcinside.com/",
        "arca" => "https://arca.live/",
        _ => return Err(format!("Invalid source: {}", source)),
    };

    let client = get_http_client()?;
    let res = client
        .get(parsed.as_str())
        .header("User-Agent", USER_AGENT)
        .header("Referer", referer)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| format!("Media request failed: {}", e))?;

    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !res.status().is_success() {
        return Ok(Response::new(encode_media_frame(status, &content_type, &[])));
    }

    if let Some(len) = res.content_length() {
        if len as usize > MAX_MEDIA_BYTES {
            return Err(format!("Media exceeds 50MB limit ({} bytes)", len));
        }
    }

    let mut stream = res.bytes_stream();
    let mut payload = Vec::new();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Stream read error: {}", e))?;
        if payload.len() + chunk.len() > MAX_MEDIA_BYTES {
            return Err("Media stream exceeded 50MB limit".to_string());
        }
        payload.extend_from_slice(&chunk);
    }

    let final_mime = if content_type.is_empty() {
        "application/octet-stream"
    } else {
        content_type.as_str()
    };

    Ok(Response::new(encode_media_frame(status, final_mime, &payload)))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Only http/https URLs are supported".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide_op: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let wide_url: Vec<u16> = OsStr::new(parsed.as_str()).encode_wide().chain(Some(0)).collect();
        let hinst = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(wide_op.as_ptr()),
                PCWSTR(wide_url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if (hinst.0 as isize) <= 32 {
            return Err(format!("Failed to open URL (code {})", hinst.0 as isize));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening external URLs is only supported on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_assert_numeric_id() {
        assert_eq!(assert_numeric_id("53122").unwrap(), "53122");
        assert_eq!(assert_numeric_id(" 123 ").unwrap(), "123");
        assert!(assert_numeric_id("").is_err());
        assert!(assert_numeric_id("53122/../../etc").is_err());
        assert!(assert_numeric_id("abc").is_err());
    }

    #[test]
    fn test_assert_allowed_url() {
        assert!(assert_allowed_url("https://arca.live/api/emoticon2/53122").is_ok());
        assert!(assert_allowed_url("https://ac-p2.namu.la/foo").is_err());
        assert!(assert_allowed_url("https://cdn.arca.live/test.mp4").is_ok());
        assert!(assert_allowed_url("https://dcimg5.dcinside.com/dccon.php?no=123").is_ok());
        assert!(assert_allowed_url("http://arca.live/e/53122").is_err());
        assert!(assert_allowed_url("https://127.0.0.1/secret").is_err());
        assert!(assert_allowed_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(assert_allowed_url("https://arca.live.evil.com/x").is_err());
    }

    #[test]
    fn test_encode_media_frame() {
        let frame = encode_media_frame(200, "image/gif", b"GIF89a");
        assert_eq!(u16::from_le_bytes([frame[0], frame[1]]), 200);
        let mime_len = u16::from_le_bytes([frame[2], frame[3]]) as usize;
        assert_eq!(mime_len, 9);
        assert_eq!(&frame[4..4 + mime_len], b"image/gif");
        assert_eq!(&frame[4 + mime_len..], b"GIF89a");
    }
}
