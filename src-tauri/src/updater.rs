//! Update check against the latest GitHub release (`latest.json`, signed with
//! the project's update key). Runs shortly after launch and once a day after
//! that; the tray menu shows the state and installs the update on click.
//!
//! The installed app downloads the new installer, which updates in place and
//! starts the app again. The portable exe has no installer to update, so its
//! menu item opens the release page instead.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(15);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const RELEASES: &str = "https://github.com/MoshikoKar/radio-widget/releases/latest";

#[derive(Clone, PartialEq)]
pub enum Status {
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Downloading(u32), // percent
    Failed,
}

#[derive(Default)]
pub struct State {
    status: Option<Status>,
    update: Option<Update>,
    announced: Option<String>, // version the widget was already told about
}

pub type Shared = Mutex<State>;

pub fn status(app: &AppHandle) -> Status {
    app.state::<Shared>().lock().unwrap().status.clone().unwrap_or(Status::Idle)
}

/// Tray menu label, and whether the item can be clicked.
pub fn label(app: &AppHandle) -> (String, bool) {
    match status(app) {
        Status::Idle => ("Check for updates".into(), true),
        Status::Checking => ("Checking for updates…".into(), false),
        Status::UpToDate => (format!("Up to date ({})", app.package_info().version), true),
        Status::Available(v) if is_portable() => (format!("Download version {v}…"), true),
        Status::Available(v) => (format!("Update to version {v}"), true),
        Status::Downloading(p) => (format!("Downloading update… {p}%"), false),
        Status::Failed => ("Update check failed — try again".into(), true),
    }
}

/// The tray item was clicked.
pub fn on_click(app: &AppHandle) {
    match status(app) {
        Status::Available(_) if is_portable() => crate::open_url(RELEASES),
        Status::Available(_) => install(app.clone()),
        Status::Checking | Status::Downloading(_) => {}
        _ => check(app.clone(), true),
    }
}

pub fn start(app: AppHandle) {
    app.manage::<Shared>(Mutex::new(State::default()));
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            run_check(&app, false).await;
            tokio_sleep(EVERY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn set(app: &AppHandle, s: Status) {
    app.state::<Shared>().lock().unwrap().status = Some(s);
    crate::update_tray(app);
}

fn check(app: AppHandle, manual: bool) {
    tauri::async_runtime::spawn(async move { run_check(&app, manual).await });
}

async fn run_check(app: &AppHandle, manual: bool) {
    if matches!(status(app), Status::Checking | Status::Downloading(_)) {
        return;
    }
    // a found update stays offered; a background check doesn't flash "Checking…"
    let prev = status(app);
    if manual {
        set(app, Status::Checking);
    }
    let found = async {
        let save = app.clone();
        app.updater_builder()
            // the installer closes the app: write any pending settings first
            .on_before_exit(move || crate::save_settings_now(&save))
            .build()?
            .check()
            .await
    }
    .await;
    match found {
        Ok(Some(update)) => {
            let v = update.version.clone();
            let tell = {
                let st = app.state::<Shared>();
                let mut g = st.lock().unwrap();
                g.update = Some(update);
                let tell = g.announced.as_deref() != Some(&v);
                g.announced = Some(v.clone());
                tell
            };
            set(app, Status::Available(v.clone()));
            if tell || manual {
                if let Some(w) = crate::main_window(app) {
                    let _ = w.emit("update-available", json!({ "version": v, "portable": is_portable() }));
                }
            }
        }
        Ok(None) => set(app, if manual { Status::UpToDate } else { idle_or(prev) }),
        Err(_) => set(app, if manual { Status::Failed } else { idle_or(prev) }),
    }
}

/// After a quiet background check, keep showing what the user last saw,
/// except an old "available" (the release may have been pulled).
fn idle_or(prev: Status) -> Status {
    match prev {
        Status::UpToDate | Status::Failed => prev,
        _ => Status::Idle,
    }
}

fn install(app: AppHandle) {
    let Some(update) = app.state::<Shared>().lock().unwrap().update.clone() else {
        return check(app, true);
    };
    set(&app, Status::Downloading(0));
    tauri::async_runtime::spawn(async move {
        let mut got = 0usize;
        let mut shown = 0u32;
        let progress = app.clone();
        // on success this doesn't return: the installer takes over and restarts the app
        let res = update
            .download_and_install(
                move |chunk, total| {
                    got += chunk;
                    if let Some(t) = total.filter(|&t| t > 0) {
                        let p = ((got as u64 * 100) / t).min(100) as u32;
                        if p >= shown + 10 {
                            shown = p - p % 10;
                            set(&progress, Status::Downloading(shown));
                        }
                    }
                },
                || {},
            )
            .await;
        if res.is_err() {
            set(&app, Status::Failed);
            if let Some(w) = crate::main_window(&app) {
                let _ = w.emit("update-failed", ());
            }
        }
    });
}

/// The installer puts an uninstaller next to the exe; the portable exe has none.
pub fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| !d.join("uninstall.exe").exists()))
        .unwrap_or(true)
}
