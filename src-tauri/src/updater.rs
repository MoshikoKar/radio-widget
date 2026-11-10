//! Update check against the latest GitHub release (`latest.json`, signed with
//! the project's update key). Runs shortly after launch and once a day after
//! that. A found update puts a green dot on the tray icon and asks once per
//! version, in a small dialog, whether to install it now. A check started from
//! the tray menu always answers in a dialog (update / up to date / failed).
//! The widget's settings panel shows the same state and runs the same steps,
//! without dialogs (it has its own status line).
//!
//! The installed app downloads the new installer, which updates in place and
//! starts the app again. The portable exe has no installer to update, so it
//! opens the release page instead.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(15);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const RELEASES: &str = "https://github.com/MoshikoKar/radio-widget/releases/latest";
/// Settings key: the last version the user was asked about (survives restarts).
const ASKED_KEY: &str = "updateAsked";

/// Only one update dialog at a time.
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

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
    badged: bool, // the tray icon currently shows the update dot
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
        Status::UpToDate => (format!("Up to date ({}) — check again", app.package_info().version), true),
        Status::Available(v) if is_portable() => (format!("● Download version {v}…"), true),
        Status::Available(v) => (format!("● Update now to version {v}"), true),
        Status::Downloading(p) => (format!("Downloading update… {p}%"), false),
        Status::Failed => ("Update check failed — try again".into(), true),
    }
}

/// Extra tray tooltip line while an update is offered or downloading.
pub fn tooltip(app: &AppHandle) -> Option<String> {
    match status(app) {
        Status::Available(v) => Some(format!("Update available: {v}")),
        Status::Downloading(p) => Some(format!("Downloading update… {p}%")),
        _ => None,
    }
}

/// Who started a check: decides which dialogs answer it.
#[derive(Clone, Copy, PartialEq)]
enum Origin {
    Auto,  // background: asks once per version, silent otherwise
    Tray,  // tray menu: always answers in a dialog
    Panel, // settings panel: answers in the panel, no dialogs
}

/// The tray item (or "Yes" in the dialog) was clicked.
pub fn on_click(app: &AppHandle) {
    click(app, Origin::Tray);
}

/// The button in the widget's settings panel was clicked.
pub fn on_panel_click(app: &AppHandle) {
    click(app, Origin::Panel);
}

fn click(app: &AppHandle, origin: Origin) {
    match status(app) {
        Status::Available(_) if is_portable() => crate::open_url(RELEASES),
        Status::Available(_) => install(app.clone()),
        Status::Checking | Status::Downloading(_) => {}
        _ => check(app.clone(), origin),
    }
}

/// The update state for the settings panel.
pub fn info(app: &AppHandle) -> Value {
    let (state, version, percent) = match status(app) {
        Status::Idle => ("idle", None, 0),
        Status::Checking => ("checking", None, 0),
        Status::UpToDate => ("uptodate", None, 0),
        Status::Available(v) => ("available", Some(v), 0),
        Status::Downloading(p) => ("downloading", None, p),
        Status::Failed => ("failed", None, 0),
    };
    json!({
        "state": state,
        "version": version,
        "percent": percent,
        "current": app.package_info().version.to_string(),
        "portable": is_portable(),
    })
}

pub fn start(app: AppHandle) {
    app.manage::<Shared>(Mutex::new(State::default()));
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            run_check(&app, Origin::Auto).await;
            tokio_sleep(EVERY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn set(app: &AppHandle, s: Status) {
    let want_badge = matches!(s, Status::Available(_) | Status::Downloading(_));
    let change_badge = {
        let st = app.state::<Shared>();
        let mut g = st.lock().unwrap();
        g.status = Some(s);
        let change = g.badged != want_badge;
        g.badged = want_badge;
        change
    };
    if change_badge {
        set_badge(app, want_badge);
    }
    crate::update_tray(app);
    if let Some(w) = crate::main_window(app) {
        let _ = w.emit("update-state", info(app));
    }
}

fn check(app: AppHandle, origin: Origin) {
    tauri::async_runtime::spawn(async move { run_check(&app, origin).await });
}

async fn run_check(app: &AppHandle, origin: Origin) {
    let manual = origin != Origin::Auto;
    let dialogs = origin == Origin::Tray;
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
            app.state::<Shared>().lock().unwrap().update = Some(update);
            set(app, Status::Available(v.clone()));
            // background checks ask once per version; a tray check always answers;
            // the settings panel shows it itself
            let new = asked(app).as_deref() != Some(v.as_str());
            if manual || new {
                remember_asked(app, &v);
            }
            if dialogs || (origin == Origin::Auto && new) {
                dialog(app, Ask::Update(v));
            }
        }
        Ok(None) => {
            set(app, if manual { Status::UpToDate } else { idle_or(prev) });
            if dialogs {
                dialog(app, Ask::UpToDate);
            }
        }
        Err(_) => {
            set(app, if manual { Status::Failed } else { idle_or(prev) });
            if dialogs {
                dialog(app, Ask::Failed);
            }
        }
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
        return check(app, Origin::Tray);
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
            // keep offering the same update: the dot and menu item let the user retry
            let v = app.state::<Shared>().lock().unwrap().update.as_ref().map(|u| u.version.clone());
            set(&app, v.map(Status::Available).unwrap_or(Status::Failed));
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

// ---------- tray badge ----------
fn set_badge(app: &AppHandle, on: bool) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let Some(base) = app.default_window_icon() else { return };
    let icon = if on { with_dot(base) } else { base.clone().to_owned() };
    let _ = tray.set_icon(Some(icon));
}

/// The icon with a green dot (dark ring) in its bottom-right corner.
fn with_dot(base: &Image<'_>) -> Image<'static> {
    let (w, h) = (base.width() as usize, base.height() as usize);
    let mut px = base.rgba().to_vec();
    let size = w.min(h) as f32;
    let r = size * 0.24; // dot radius, ring included (stays visible at 16 px)
    let ring = (size * 0.06).max(1.0);
    let (cx, cy) = (w as f32 - r - size * 0.01, h as f32 - r - size * 0.01);
    const FILL: [f32; 3] = [34.0, 197.0, 94.0]; // green
    const EDGE: [f32; 3] = [16.0, 20.0, 24.0];
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let cover = (r + 0.5 - d).clamp(0.0, 1.0); // anti-aliased edge
            if cover <= 0.0 {
                continue;
            }
            let inner = (r - ring + 0.5 - d).clamp(0.0, 1.0);
            let i = (y * w + x) * 4;
            for c in 0..3 {
                let col = EDGE[c] * (1.0 - inner) + FILL[c] * inner;
                px[i + c] = (px[i + c] as f32 * (1.0 - cover) + col * cover).round() as u8;
            }
            px[i + 3] = (px[i + 3] as f32 * (1.0 - cover) + 255.0 * cover).round() as u8;
        }
    }
    Image::new_owned(px, w as u32, h as u32)
}

// ---------- dialogs ----------
enum Ask {
    Update(String),
    UpToDate,
    Failed,
}

/// Native message box on its own thread (it blocks until answered).
fn dialog(app: &AppHandle, ask: Ask) {
    if DIALOG_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDRETRY, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_RETRYCANCEL, MB_SETFOREGROUND,
            MB_TOPMOST, MB_YESNO,
        };
        let cur = app.package_info().version.to_string();
        let (text, flags) = match &ask {
            Ask::Update(v) if is_portable() => (
                format!("Radio Widget {v} is available (you have {cur}).\n\nOpen the download page now?"),
                MB_YESNO | MB_ICONINFORMATION,
            ),
            Ask::Update(v) => (
                format!(
                    "Radio Widget {v} is available (you have {cur}).\n\nUpdate now? The widget restarts by itself when it's done.\n\nChoose No to update later from the tray icon."
                ),
                MB_YESNO | MB_ICONINFORMATION,
            ),
            Ask::UpToDate => (format!("You have the latest version ({cur})."), MB_OK | MB_ICONINFORMATION),
            Ask::Failed => (
                "Couldn't check for updates. Check your internet connection and try again.".to_string(),
                MB_RETRYCANCEL | MB_ICONERROR,
            ),
        };
        let res = unsafe {
            MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("Radio Widget"), flags | MB_TOPMOST | MB_SETFOREGROUND)
        };
        DIALOG_OPEN.store(false, Ordering::SeqCst);
        match ask {
            Ask::Update(_) if res == IDYES => on_click(&app),
            Ask::Failed if res == IDRETRY => check(app, Origin::Tray),
            _ => {}
        }
    });
}

fn asked(app: &AppHandle) -> Option<String> {
    let st = app.state::<crate::Shared>();
    let g = st.lock().unwrap();
    g.settings.get(ASKED_KEY).and_then(Value::as_str).map(str::to_string)
}

fn remember_asked(app: &AppHandle, v: &str) {
    let st = app.state::<crate::Shared>();
    let mut g = st.lock().unwrap();
    g.settings.insert(ASKED_KEY.into(), json!(v));
    crate::schedule_save(app, &mut g);
}
