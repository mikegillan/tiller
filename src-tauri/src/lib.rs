use std::{env, fs, path::PathBuf, process::{Command, Stdio}, thread, time::{Duration, Instant}};
use tauri::{Manager, RunEvent, Url};

fn home() -> PathBuf {
    env::var_os("O8_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var("HOME").unwrap_or_default()).join(".orchestr8"))
}

fn read(name: &str) -> Option<String> {
    fs::read_to_string(home().join(name)).ok().map(|s| s.trim().to_string())
}

// Same lookup as src/daemon/up.ts daemonPort.
fn port() -> u16 {
    env::var("O8_PORT").ok().or_else(|| read("port")).and_then(|p| p.parse().ok()).unwrap_or(7788)
}

fn alive(port: u16) -> bool {
    reqwest::blocking::Client::new().get(format!("http://127.0.0.1:{port}/health")).timeout(Duration::from_millis(500)).send().is_ok_and(|r| r.status().is_success())
}

// Start bin/o8d detached in its own session, appending to daemon.log, then wait up to 15 s for /health.
fn ensure_daemon(port: u16) -> Result<(), String> {
    if alive(port) { return Ok(()); }
    let repo = option_env!("O8_REPO").map(String::from).or_else(|| read("repo")).ok_or("no ~/.orchestr8/repo (run `o8` once) and O8_REPO not set at build time")?;
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    let log = fs::OpenOptions::new().create(true).append(true).open(home().join("daemon.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(PathBuf::from(repo).join("bin/o8d"));
    cmd.env("O8_HOME", home()).env("O8_PORT", port.to_string()).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd.spawn().map_err(|e| format!("starting bin/o8d: {e}"))?;
    let end = Instant::now() + Duration::from_secs(15);
    while Instant::now() < end {
        if alive(port) { return Ok(()); }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("daemon did not come up on port {port}; see {}", home().join("daemon.log").display()))
}

// Number of nodes that need the human (blocked or waiting), or None if the daemon did not answer.
fn needs_you(port: u16, token: &str) -> Option<i64> {
    let res: serde_json::Value = reqwest::blocking::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/list_nodes"))
        .bearer_auth(token).header("X-O8-Node", "human").json(&serde_json::json!({}))
        .timeout(Duration::from_secs(2)).send().ok()?.json().ok()?;
    let n = res["data"].as_array()?.iter().filter(|n| matches!(n["state"].as_str(), Some("blocked" | "waiting"))).count();
    Some(n as i64)
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window");
            thread::spawn(move || {
                let port = port();
                if let Err(e) = ensure_daemon(port) { eprintln!("orchestr8: {e}"); return; }
                let token = read("admin-token").unwrap_or_default();
                // `o8` launches the app with `--node <id>` so it opens on that node.
                let node = env::args().skip_while(|a| a != "--node").nth(1).map(|n| format!("&node={n}")).unwrap_or_default();
                let _ = win.navigate(Url::parse(&format!("http://127.0.0.1:{port}/?k={token}{node}")).unwrap());
                loop {
                    let count = needs_you(port, &token).filter(|&n| n > 0);
                    let _ = win.set_badge_count(count);
                    thread::sleep(Duration::from_secs(3));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
        }
    });
}
