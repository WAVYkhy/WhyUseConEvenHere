//! Startup (logon) autostart.
//!
//! The app runs elevated (see `windows-app-manifest.xml`), so a registry `Run` entry would
//! trigger a UAC prompt at every logon. A scheduled task registered with
//! `/RL HIGHEST /SC ONLOGON` starts the app silently with an elevated token instead.

use std::os::windows::process::CommandExt;
use std::process::{Command, Output};

/// Scheduled task name. ASCII only so `schtasks` never has to deal with code pages.
const TASK_NAME: &str = "DiscordConApp";

/// Legacy registry `Run` value written by the old `tauri-plugin-autostart` setup.
const LEGACY_RUN_VALUE: &str = "discordcon-desktop";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run(program: &str, args: &[&str]) -> std::io::Result<Output> {
    Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

fn current_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("실행 파일 경로를 확인할 수 없습니다: {}", e))
}

fn create_task() -> Result<(), String> {
    let exe = current_exe()?;
    // schtasks stores the program verbatim; quote it so paths with spaces survive.
    let task_command = format!("\"{}\"", exe);

    let output = run(
        "schtasks",
        &[
            "/Create",
            "/F",
            "/SC",
            "ONLOGON",
            "/RL",
            "HIGHEST",
            "/TN",
            TASK_NAME,
            "/TR",
            &task_command,
        ],
    )
    .map_err(|e| format!("schtasks 실행 실패: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "자동 실행 등록 실패 (schtasks 종료 코드 {})",
            output.status.code().unwrap_or(-1)
        ))
    }
}

fn delete_task() -> Result<(), String> {
    match run("schtasks", &["/Delete", "/F", "/TN", TASK_NAME]) {
        Ok(output) if output.status.success() => Ok(()),
        // Task already absent: treat as success so the toggle never gets stuck.
        Ok(_) => Ok(()),
        Err(e) => Err(format!("schtasks 실행 실패: {}", e)),
    }
}

/// `true` when the logon task exists.
#[tauri::command]
pub fn is_autostart_enabled() -> bool {
    matches!(
        run("schtasks", &["/Query", "/TN", TASK_NAME]),
        Ok(output) if output.status.success()
    )
}

/// Enables/disables silent elevated startup at logon.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        create_task()
    } else {
        delete_task()
    }
}

/// Removes the pre-elevation `Run` entry and adopts its setting into the scheduled task,
/// so users who already had autostart on keep it (without a UAC prompt at logon).
pub fn migrate_legacy_run_key() {
    let mut had_legacy = delete_legacy_run_value(LEGACY_RUN_VALUE);

    // The old plugin used `package_info().name`; also catch a stale product-name entry.
    for extra in ["여기서까지콘을써야겠냐", "DiscordConApp"] {
        if extra != LEGACY_RUN_VALUE && delete_legacy_run_value(extra) {
            had_legacy = true;
        }
    }

    if had_legacy && !is_autostart_enabled() {
        let _ = create_task();
    }
}

fn delete_legacy_run_value(value_name: &str) -> bool {
    // Only drop the entry when it actually launches this executable.
    let Ok(output) = run("reg", &["query", RUN_KEY, "/v", value_name]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "discordcon-desktop.exe".to_string());
    if !text.to_lowercase().contains(&exe_name.to_lowercase()) {
        return false;
    }

    matches!(
        run("reg", &["delete", RUN_KEY, "/v", value_name, "/f"]),
        Ok(result) if result.status.success()
    )
}
