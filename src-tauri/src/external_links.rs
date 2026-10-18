use std::process::Command;
use tauri::Url;

fn web_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid web URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS links can be opened".into());
    }
    Ok(url)
}

/// Open a web link in the macOS default browser. The URL is a single argument,
/// never shell input; no file paths, app selectors or other protocols are accepted.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let status = Command::new("/usr/bin/open")
            .arg(url.as_str())
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("The default browser could not open the link".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::web_url;

    #[test]
    fn accepts_only_web_urls() {
        for value in [
            "https://github.com/example/tiller/compare/v1...v2",
            "http://example.com/path?q=a%20b#note",
            "HTTPS://example.com",
        ] {
            assert!(web_url(value).is_ok(), "{value}");
        }
        for value in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "tel:123",
            "//example.com",
            "/tmp/file",
            "--args",
            "https://",
        ] {
            assert!(web_url(value).is_err(), "{value}");
        }
    }
}
