// AIOS Workspace — desktop shell.
//
// A thin Tauri window over the EXISTING local cockpit: it picks a workspace folder,
// launches the Node sidecar (gui/server) on a free localhost port with a shell-set
// session token, waits for it to come up, and points the webview at it. The agent
// runtime, skills, hooks, connectors — everything — live in the sidecar, unchanged.
//
// When the workspace has an encrypted .env, the sidecar is launched under
// `dotenvx run --` so MCP `${ENV}` placeholders resolve for the agent.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Holds the sidecar process so we can kill it when the window closes.
struct Sidecar(Mutex<Option<Child>>);

fn random_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(18790)
}

fn is_workspace(dir: &Path) -> bool {
    ["aios.yaml", "workspace.yaml", "project.yaml", "engagement.yaml"]
        .iter()
        .any(|f| dir.join(f).exists())
        || dir.join(".claude").exists()
}

// GUI apps launched from Finder don't inherit the shell PATH — ask a login shell,
// then fall back to common install locations, then the bare name (dev/terminal path).
fn find_bin(name: &str) -> String {
    if let Ok(out) = Command::new("/bin/sh")
        .arg("-lc")
        .arg(format!("command -v {name}"))
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let cand = format!("{dir}/{name}");
        if Path::new(&cand).exists() {
            return cand;
        }
    }
    name.to_string()
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("config.json"))
}

fn saved_repo(app: &tauri::AppHandle) -> Option<PathBuf> {
    let txt = std::fs::read_to_string(config_path(app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let p = PathBuf::from(v.get("repo")?.as_str()?);
    if is_workspace(&p) {
        Some(p)
    } else {
        None
    }
}

fn save_repo(app: &tauri::AppHandle, repo: &Path) {
    if let Some(p) = config_path(app) {
        let v = serde_json::json!({ "repo": repo.to_string_lossy() });
        let _ = std::fs::write(p, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
}

fn resolve_repo(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(r) = saved_repo(app) {
        return Some(r);
    }
    loop {
        match rfd::FileDialog::new()
            .set_title("Choose your AIOS workspace folder")
            .pick_folder()
        {
            None => return None, // user cancelled → don't launch
            Some(dir) if is_workspace(&dir) => {
                save_repo(app, &dir);
                return Some(dir);
            }
            Some(_) => {
                rfd::MessageDialog::new()
                    .set_title("Not an AIOS workspace")
                    .set_description("That folder isn't an AIOS workspace (no aios.yaml / .claude). Pick a workspace folder.")
                    .show();
            }
        }
    }
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn start_sidecar(app: &tauri::AppHandle, repo: &Path, port: u16, token: &str) -> std::io::Result<Child> {
    let server = app
        .path()
        .resource_dir()
        .expect("resource dir")
        .join("gui/server/index.mjs");
    let node = find_bin("node");

    // Under dotenvx when the workspace has an encrypted .env, so the agent's MCP
    // servers get decrypted provider tokens at spawn.
    let use_dotenvx = repo.join(".env").exists();
    let mut cmd = if use_dotenvx {
        let mut c = Command::new(find_bin("dotenvx"));
        c.arg("run").arg("--").arg(&node);
        c
    } else {
        Command::new(&node)
    };
    cmd.arg(&server)
        .arg("--repo")
        .arg(repo)
        .arg("--port")
        .arg(port.to_string())
        .env("AIOS_GUI_TOKEN", token)
        .current_dir(repo)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
}

fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Sidecar>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            let repo = match resolve_repo(&handle) {
                Some(r) => r,
                None => {
                    handle.exit(0);
                    return Ok(());
                }
            };

            let token = random_token();
            let port = free_port();

            match start_sidecar(&handle, &repo, port, &token) {
                Ok(child) => {
                    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
                }
                Err(e) => {
                    rfd::MessageDialog::new()
                        .set_title("Couldn't start AIOS")
                        .set_description(&format!("Failed to launch the local server (is Node installed?).\n\n{e}"))
                        .show();
                    handle.exit(1);
                    return Ok(());
                }
            }

            if !wait_for_port(port, Duration::from_secs(25)) {
                rfd::MessageDialog::new()
                    .set_title("Couldn't start AIOS")
                    .set_description("The local server didn't come up in time.")
                    .show();
                kill_sidecar(&handle);
                handle.exit(1);
                return Ok(());
            }

            let url = format!("http://127.0.0.1:{port}/?token={token}");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("AIOS Workspace")
                .inner_size(1180.0, 800.0)
                .min_inner_size(880.0, 600.0)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle();
                kill_sidecar(app);
                app.exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AIOS Workspace");
}
