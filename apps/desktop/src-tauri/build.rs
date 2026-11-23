fn main() {
    // Embed a custom Windows application manifest so the exe requires administrator rights
    // (see windows-app-manifest.xml for why).
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
