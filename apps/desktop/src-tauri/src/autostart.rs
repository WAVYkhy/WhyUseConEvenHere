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
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

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
    let Some(exe_path) = std::env::current_exe()
        .ok()
        .map(|p| normalize_path(&p.display().to_string()))
    else {
        return;
    };

    // The old plugin used `package_info().name`; also catch a stale product-name entry.
    let mut had_legacy = false;
    for (name, value) in query_run_values() {
        if !normalize_path(&value).contains(&exe_path) {
            // Belongs to another executable (e.g. a debug build): leave it alone.
            continue;
        }
        if delete_run_value(&name) {
            had_legacy = true;
        }
    }

    if had_legacy && !is_autostart_enabled() {
        let _ = create_task();
    }
}

/// Lowercases and unifies separators/quotes so a registry value and `current_exe()` compare equal.
fn normalize_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .replace('/', "\\")
        .to_lowercase()
}

/// Reads every known legacy `Run` value in one go.
///
/// `reg query` writes its output in the console code page, which mangles non-ASCII install
/// paths, so the values are read through PowerShell with UTF-8 output instead.
fn query_run_values() -> Vec<(String, String)> {
    let names = format!(
        "'{}','{}','{}'",
        LEGACY_RUN_VALUE, "여기서까지콘을써야겠냐", "DiscordConApp"
    );
    let script = format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
         $run = Get-ItemProperty 'HKCU:\\{RUN_KEY_PATH}' -ErrorAction SilentlyContinue; \
         foreach ($n in @({names})) {{ $v = $run.$n; if ($v) {{ \"$n`t$v\" }} }}"
    );

    let Ok(output) = run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
    ) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once('\t')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn delete_run_value(value_name: &str) -> bool {
    let script = format!(
        "Remove-ItemProperty -Path 'HKCU:\\{RUN_KEY_PATH}' -Name '{}' -ErrorAction Stop",
        value_name.replace('\'', "''")
    );
    matches!(
        run(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        ),
        Ok(result) if result.status.success()
    )
}
