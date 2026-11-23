use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

const LOGICAL_WIDTH: f64 = 480.0;
const LOGICAL_HEIGHT: f64 = 500.0;
const BLUR_DEBOUNCE_MS: u64 = 200;

pub struct WindowGuardState {
    pub last_blur_time: Mutex<Option<Instant>>,
    pub suppress_blur: AtomicBool,
    pub current_shortcut: Mutex<String>,
    pub previous_hwnd: Mutex<Option<isize>>,
}

impl Default for WindowGuardState {
    fn default() -> Self {
        Self {
            last_blur_time: Mutex::new(None),
            suppress_blur: AtomicBool::new(false),
            current_shortcut: Mutex::new("Alt+E".to_string()),
            previous_hwnd: Mutex::new(None),
        }
    }
}

impl WindowGuardState {
    pub fn record_blur(&self) {
        if let Ok(mut guard) = self.last_blur_time.lock() {
            *guard = Some(Instant::now());
        }
    }

    pub fn is_within_blur_debounce(&self) -> bool {
        if let Ok(guard) = self.last_blur_time.lock() {
            if let Some(t) = *guard {
                return t.elapsed() < Duration::from_millis(BLUR_DEBOUNCE_MS);
            }
        }
        false
    }
}

pub fn clamp_to_work_area(
    cursor_x: i32,
    cursor_y: i32,
    work_left: i32,
    work_top: i32,
    work_right: i32,
    work_bottom: i32,
    win_w: i32,
    win_h: i32,
) -> (i32, i32) {
    let max_x = (work_right - win_w).max(work_left);
    let max_y = (work_bottom - win_h).max(work_top);
    let x = cursor_x.clamp(work_left, max_x);
    let y = cursor_y.clamp(work_top, max_y);
    (x, y)
}

#[cfg(windows)]
fn compute_clamped_overlay_position(win_w: i32, win_h: i32) -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return None;
        }

        let hmonitor = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmonitor, &mut info).as_bool() {
            return None;
        }

        let rc = info.rcWork;
        Some(clamp_to_work_area(
            pt.x, pt.y, rc.left, rc.top, rc.right, rc.bottom, win_w, win_h,
        ))
    }
}

#[cfg(not(windows))]
fn compute_clamped_overlay_position(_win_w: i32, _win_h: i32) -> Option<(i32, i32)> {
    None
}

#[cfg(windows)]
fn capture_previous_foreground_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return;
    }
    if let Ok(own_hwnd) = window.hwnd() {
        if fg.0 == own_hwnd.0 {
            return;
        }
    }
    let state = app.state::<WindowGuardState>();
    if let Ok(mut guard) = state.previous_hwnd.lock() {
        *guard = Some(fg.0 as isize);
    };
}

#[cfg(not(windows))]
fn capture_previous_foreground_window(_app: &AppHandle, _window: &tauri::WebviewWindow) {}

#[cfg(windows)]
pub fn restore_previous_foreground_window(app: &AppHandle) -> Option<isize> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};

    let prev = {
        let state = app.state::<WindowGuardState>();
        state.previous_hwnd.lock().ok().and_then(|mut g| g.take())
    };
    let raw = prev?;
    let hwnd = HWND(raw as *mut core::ffi::c_void);
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(own_hwnd) = window.hwnd() {
            if hwnd.0 == own_hwnd.0 {
                return None;
            }
        }
    }
    unsafe {
        if IsWindow(hwnd).as_bool() {
            let _ = SetForegroundWindow(hwnd);
            return Some(raw);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn restore_previous_foreground_window(_app: &AppHandle) -> Option<isize> {
    None
}

#[cfg(windows)]
pub fn is_target_foreground(app: &AppHandle, target_hwnd: Option<isize>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(own_hwnd) = window.hwnd() {
            if fg.0 == own_hwnd.0 {
                return false;
            }
        }
    }
    if let Some(target) = target_hwnd {
        return fg.0 as isize == target;
    }
    true
}

#[cfg(not(windows))]
pub fn is_target_foreground(_app: &AppHandle, _target_hwnd: Option<isize>) -> bool {
    false
}

pub fn show_overlay_at_cursor(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    capture_previous_foreground_window(app, &window);

    // The window keeps whatever size the user dragged it to, so clamp the popup
    // position against the live window size instead of the configured default.
    let fallback_scale = window.scale_factor().unwrap_or(1.0);
    let (win_w, win_h) = window
        .outer_size()
        .map(|size| (size.width as i32, size.height as i32))
        .unwrap_or_else(|_| {
            (
                (LOGICAL_WIDTH * fallback_scale).round() as i32,
                (LOGICAL_HEIGHT * fallback_scale).round() as i32,
            )
        });

    if let Some((x, y)) = compute_clamped_overlay_position(win_w.max(1), win_h.max(1)) {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }

    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

pub fn toggle_overlay(app: &AppHandle, from_tray: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
        return;
    }

    if from_tray {
        let guard = app.state::<WindowGuardState>();
        if guard.is_within_blur_debounce() {
            return;
        }
    }

    show_overlay_at_cursor(app);
}

#[tauri::command]
pub fn hide_overlay_window(app: AppHandle) {
    hide_overlay(&app);
}

#[tauri::command]
pub fn set_blur_suppressed(state: tauri::State<'_, WindowGuardState>, suppressed: bool) {
    state.suppress_blur.store(suppressed, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_to_work_area_multi_monitor_and_taskbar() {
        // Secondary monitor on left (-1920..0, 0..1040) with 480x500 window
        let (x, y) = clamp_to_work_area(-100, 900, -1920, 0, 0, 1040, 480, 500);
        assert_eq!(x, -480);
        assert_eq!(y, 540);

        // Cursor near top-left
        let (x2, y2) = clamp_to_work_area(10, 20, 0, 0, 1920, 1040, 480, 500);
        assert_eq!(x2, 10);
        assert_eq!(y2, 20);
    }
}
