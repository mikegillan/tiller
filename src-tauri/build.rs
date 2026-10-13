fn main() {
  // set_tray is an app command; the UI is a remote URL, so it needs an ACL entry (capabilities/default.json allow-set-tray).
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_tray"]))).expect("tauri build");
}
