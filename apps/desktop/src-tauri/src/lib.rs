mod autostart;
mod commands;
mod tray;
mod window;

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use autostart::{is_autostart_enabled, set_autostart};
use commands::clipboard::{cleanup_staging_dir, copy_media_to_clipboard};
use commands::network::{fetch_arca_pack, fetch_dc_pack, fetch_media, open_external_url};
use window::{hide_overlay_window, set_blur_suppressed, show_overlay_at_cursor, toggle_overlay, WindowGuardState};

#[tauri::command]
fn register_overlay_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowGuardState>,
    shortcut: String,
) -> Result<(), String> {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Err("단축키를 입력해주세요.".to_string());
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let app_handle = app.clone();
    gs.on_shortcut(trimmed, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_overlay(&app_handle, false);
        }
    })
    .map_err(|e| format!("단축키 '{}' 등록 실패 (다른 앱에서 사용 중일 수 있습니다): {}", trimmed, e))?;

    if let Ok(mut guard) = state.current_shortcut.lock() {
        *guard = trimmed.to_string();
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WindowGuardState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_overlay_at_cursor(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            cleanup_staging_dir();
            autostart::migrate_legacy_run_key();
            tray::setup_tray(app.handle())?;

            // Register default Alt+E shortcut on startup; frontend will re-sync saved shortcut if customized.
            let app_handle = app.handle().clone();
            if let Err(err) = app.global_shortcut().on_shortcut("Alt+E", move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_overlay(&app_handle, false);
                }
            }) {
                let _ = app.emit("shortcut-error", format!("기본 단축키(Alt+E) 등록 실패: {}", err));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::Focused(false) = event {
                let state = window.state::<WindowGuardState>();
                if !state.suppress_blur.load(Ordering::SeqCst) {
                    state.record_blur();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            fetch_arca_pack,
            fetch_dc_pack,
            fetch_media,
            copy_media_to_clipboard,
            hide_overlay_window,
            set_blur_suppressed,
            register_overlay_shortcut,
            open_external_url,
            is_autostart_enabled,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
