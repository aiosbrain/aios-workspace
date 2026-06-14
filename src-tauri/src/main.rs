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

// Locate the toolkit (the dir containing gui/, scripts/, scaffold/). Bundled builds
// have it in the resource dir; `tauri dev` doesn't copy resources, so walk up from
// the executable to the repo root.
fn toolkit_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(r) = app.path().resource_dir() {
        if r.join("gui/server/index.mjs").exists() {
            return r;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(p) = cur {
            if p.join("gui/server/index.mjs").exists() {
                return p;
            }
            cur = p.parent().map(|x| x.to_path_buf());
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

// A PATH that includes Node + the Claude Code CLI locations (GUI apps don't inherit
// the shell PATH), prepended to whatever PATH we did inherit. The agent runtime spawns
// the `claude` CLI (often in ~/.local/bin), so it must be findable.
fn enriched_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if let Some(p) = Path::new(&find_bin("node")).parent() {
        dirs.insert(0, p.to_string_lossy().to_string());
    }
    let base = std::env::var("PATH").unwrap_or_default();
    if base.is_empty() { dirs.join(":") } else { format!("{}:{}", dirs.join(":"), base) }
}

// Turn an empty folder into a workspace by running scaffold-project.sh. Asks the one
// onboarding question (consultant vs employee) and uses sensible defaults the user can
// edit later in workspace.yaml.
fn scaffold_into(app: &tauri::AppHandle, dir: &Path) -> bool {
    let consultant = matches!(
        rfd::MessageDialog::new()
            .set_title("Set up your workspace")
            .set_description("How do you work?\n\n• Yes — Consultant (you work with clients)\n• No — Employee (inside a company)")
            .set_buttons(rfd::MessageButtons::YesNo)
            .show(),
        rfd::MessageDialogResult::Yes
    );
    let context = if consultant { "consultant" } else { "employee" };
    let owner = std::env::var("USER").unwrap_or_else(|_| "me".to_string());
    let slug = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());
    let toolkit = toolkit_dir(app);
    let script = toolkit.join("scripts/scaffold-project.sh");

    let status = Command::new("bash")
        .arg(&script)
        .arg("--context").arg(context)
        .arg("--slug").arg(&slug)
        .arg("--owner").arg(&owner)
        .arg("--stakeholder").arg(if consultant { "My Client" } else { "My Company" })
        .arg("--team").arg(&owner)
        .arg("--output").arg(dir)
        .current_dir(&toolkit)
        .env("PATH", enriched_path())
        .status();

    matches!(status, Ok(s) if s.success()) && is_workspace(dir)
}

fn resolve_repo(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(r) = saved_repo(app) {
        return Some(r);
    }
    loop {
        match rfd::FileDialog::new()
            .set_title("Choose or create your AIOS workspace folder")
            .pick_folder()
        {
            None => return None, // user cancelled → don't launch
            Some(dir) if is_workspace(&dir) => {
                save_repo(app, &dir);
                return Some(dir);
            }
            Some(dir) => {
                let empty = std::fs::read_dir(&dir)
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false);
                if empty {
                    // New, empty folder → set it up in place.
                    if scaffold_into(app, &dir) {
                        save_repo(app, &dir);
                        return Some(dir);
                    }
                    rfd::MessageDialog::new()
                        .set_title("Couldn't set up workspace")
                        .set_description("Setting up that folder failed. Try another folder.")
                        .show();
                } else {
                    rfd::MessageDialog::new()
                        .set_title("Pick an empty folder")
                        .set_description("That folder has files but isn't an AIOS workspace. Choose an existing workspace, or an empty folder to create a new one.")
                        .show();
                }
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
    let server = toolkit_dir(app).join("gui/server/index.mjs");
    let node = find_bin("node");

    // Log the sidecar (and the agent runtime it spawns) to a file so failures are
    // diagnosable instead of vanishing into /dev/null.
    let logdir = repo.join(".aios");
    let _ = std::fs::create_dir_all(&logdir);
    let log = std::fs::File::create(logdir.join("gui-server.log"))?;
    let log_err = log.try_clone()?;

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
        .env("PATH", enriched_path())
        .current_dir(repo)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
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
