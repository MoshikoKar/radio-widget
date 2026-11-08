// Radio Widget — Tauri backend.
// One frameless transparent window, resized per mode (expanded / compact /
// logo). Lives in the tray (no taskbar button), runs a local stream proxy for
// ICY song titles, and talks to the radio-browser.info directory.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod proxy;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// ---------- sizes (logical px, scaled per monitor) ----------
fn base_size(mode: &str) -> (f64, f64) {
    match mode {
        "compact" => (372.0, 56.0),
        "logo" => (72.0, 72.0),
        _ => (470.0, 206.0),
    }
}
const DROPDOWN_EXTRA: f64 = 310.0; // extra height while a dropdown list is open
const MARGIN: f64 = 16.0;

#[derive(Clone, Copy, PartialEq, Debug)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Default, Deserialize, Clone)]
struct NowPlaying {
    station: String,
    title: String,
    playing: bool,
}

struct Inner {
    settings: Map<String, Value>,
    mode: String,
    pre_dropdown: Option<Rect>,
    /// the expanded view popped out of the logo is temporary: don't remember its spot
    temp_from_logo: bool,
    proxy_port: u16,
    now_playing: NowPlaying,
    hotkey: Option<&'static str>,
    save_gen: u64,
    logo_gen: u64,
}

/// Last position we set ourselves, so Moved events we caused aren't
/// mistaken for the user dragging the window.
struct LastSet(Mutex<(Option<(i32, i32)>, Instant)>);

type Shared = Mutex<Inner>;

// ---------- settings ----------
fn defaults() -> Map<String, Value> {
    json!({
        "country": "IL",
        "station": null,
        "volume": 0.7,
        "stayOnTop": false,
        "logoOpenOn": "hover",
        "logoPos": null,
        "anchor": null,
        "pos": {},
        "favorites": [],
        "adDuck": true,
        "adLevel": 0.5
    })
    .as_object()
    .cloned()
    .unwrap()
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

fn load_settings(app: &AppHandle) -> Map<String, Value> {
    let mut s = defaults();
    let path = settings_path(app);
    let mut text = std::fs::read_to_string(&path).ok();
    if text.is_none() {
        // import settings from the earlier prototype, if present
        if let Ok(appdata) = std::env::var("APPDATA") {
            text = std::fs::read_to_string(PathBuf::from(appdata).join("radio-widget").join("settings.json")).ok();
        }
    }
    if let Some(Value::Object(saved)) = text.and_then(|t| serde_json::from_str(&t).ok()) {
        for (k, v) in saved {
            s.insert(k, v);
        }
    }
    s
}

fn write_settings(app: &AppHandle, s: &Map<String, Value>) {
    let path = settings_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(s).unwrap_or_default());
}

/// Debounced save (drags fire many move events).
fn schedule_save(app: &AppHandle, inner: &mut Inner) {
    inner.save_gen += 1;
    let gen = inner.save_gen;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let st = app.state::<Shared>();
        let snapshot = {
            let g = st.lock().unwrap();
            if g.save_gen != gen {
                return;
            }
            g.settings.clone()
        };
        write_settings(&app, &snapshot);
    });
}

fn stay_on_top(inner: &Inner) -> bool {
    inner.settings.get("stayOnTop").and_then(Value::as_bool).unwrap_or(false)
}

fn xy(v: Option<&Value>) -> Option<(i32, i32)> {
    let v = v?;
    Some((v.get("x")?.as_f64()? as i32, v.get("y")?.as_f64()? as i32))
}

// ---------- geometry (physical px) ----------
fn bounds(win: &WebviewWindow) -> Rect {
    let p = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let s = win.outer_size().unwrap_or_default();
    Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 }
}

/// Work area and scale of the monitor that best contains `r`.
fn monitor_for(win: &WebviewWindow, r: Rect) -> (Rect, f64) {
    let cx = r.x + r.w / 2;
    let cy = r.y + r.h / 2;
    let monitors = win.available_monitors().unwrap_or_default();
    let pick = monitors
        .iter()
        .find(|m| {
            let a = m.work_area();
            cx >= a.position.x
                && cx < a.position.x + a.size.width as i32
                && cy >= a.position.y
                && cy < a.position.y + a.size.height as i32
        })
        .cloned()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    match pick {
        Some(m) => {
            let a = m.work_area();
            (
                Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 },
                m.scale_factor(),
            )
        }
        None => (Rect { x: 0, y: 0, w: 1920, h: 1040 }, 1.0),
    }
}

fn size_for(mode: &str, scale: f64) -> (i32, i32) {
    let (w, h) = base_size(mode);
    ((w * scale).round() as i32, (h * scale).round() as i32)
}

fn clamp(win: &WebviewWindow, r: Rect) -> Rect {
    let (wa, _) = monitor_for(win, r);
    let x = r.x.min(wa.x + wa.w - r.w).max(wa.x);
    let y = r.y.min(wa.y + wa.h - r.h).max(wa.y);
    Rect { x, y, ..r }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

/// Move + resize in one step (no flicker between the two).
fn set_bounds(win: &WebviewWindow, r: Rect) {
    if let Some(ls) = win.try_state::<LastSet>() {
        *ls.0.lock().unwrap() = (Some((r.x, r.y)), Instant::now());
    }
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        unsafe { SetWindowPos(hwnd.0 as isize, 0, r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE) };
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(r.w as u32, r.h as u32));
    let _ = win.set_position(PhysicalPosition::new(r.x, r.y));
}

fn remember_pos(win: &WebviewWindow, inner: &mut Inner) {
    if inner.mode == "logo" || inner.temp_from_logo || inner.pre_dropdown.is_some() {
        return;
    }
    let b = bounds(win);
    let mode = inner.mode.clone();
    let pos = inner.settings.entry("pos").or_insert_with(|| json!({}));
    if !pos.is_object() {
        *pos = json!({});
    }
    pos[mode.as_str()] = json!({ "x": b.x, "y": b.y });
}

/// Where a mode opens: its remembered spot, or (first visit) derived from the
/// current window — keeping the bottom-right corner, or the top edge if the
/// window sits nearer the top of the screen.
fn rect_for_mode(win: &WebviewWindow, inner: &Inner, next: &str) -> Rect {
    let b = bounds(win);
    let (wa, scale) = monitor_for(win, b);
    let (w, h) = size_for(next, scale);
    if let Some((x, y)) = xy(inner.settings.get("pos").and_then(|p| p.get(next))) {
        return clamp(win, Rect { x, y, w, h });
    }
    let near_top = b.y - wa.y < wa.y + wa.h - (b.y + b.h);
    let y = if near_top { b.y } else { b.y + b.h - h };
    clamp(win, Rect { x: b.x + b.w - w, y, w, h })
}

fn apply_mode(app: &AppHandle, win: &WebviewWindow, inner: &mut Inner, next: &str) {
    let from = inner.mode.clone();
    restore_dropdown(app, win, inner);
    if from != next {
        remember_pos(win, inner);
    }
    let b = bounds(win);
    let (wa, scale) = monitor_for(win, b);
    let (w, h) = size_for(next, scale);

    let rect = if next == "logo" {
        let (x, y) = xy(inner.settings.get("logoPos")).unwrap_or((b.x + b.w - w, b.y)); // first time: top-right corner of the widget
        let r = clamp(win, Rect { x, y, w, h });
        inner.settings.insert("logoPos".into(), json!({ "x": r.x, "y": r.y }));
        inner.temp_from_logo = false;
        r
    } else if from == "logo" {
        // open next to the logo, so the cursor stays over the widget
        let mut x = b.x;
        let mut y = b.y;
        if x + w > wa.x + wa.w {
            x = b.x + b.w - w;
        }
        if y + h > wa.y + wa.h {
            y = b.y + b.h - h;
        }
        inner.temp_from_logo = true;
        clamp(win, Rect { x, y, w, h })
    } else {
        inner.temp_from_logo = false;
        if from == next {
            clamp(win, Rect { w, h, ..b })
        } else {
            rect_for_mode(win, inner, next)
        }
    };

    inner.mode = next.to_string();
    set_bounds(win, rect);
    remember_pos(win, inner);
    schedule_save(app, inner);
}

fn open_dropdown(win: &WebviewWindow, inner: &mut Inner) -> &'static str {
    if inner.pre_dropdown.is_some() {
        return "down";
    }
    let b = bounds(win);
    inner.pre_dropdown = Some(b);
    let (wa, scale) = monitor_for(win, b);
    let extra = (DROPDOWN_EXTRA * scale).round() as i32;
    if b.y - extra >= wa.y {
        set_bounds(win, Rect { y: b.y - extra, h: b.h + extra, ..b });
        "up"
    } else {
        set_bounds(win, Rect { h: b.h + extra, ..b });
        "down"
    }
}

fn restore_dropdown(app: &AppHandle, win: &WebviewWindow, inner: &mut Inner) {
    let Some(old) = inner.pre_dropdown.take() else { return };
    let cur = bounds(win);
    // keep any movement the user made while the list was open
    let grew_up = cur.h > old.h && cur.y < old.y - 1;
    let extra = cur.h - old.h;
    let dx = cur.x - old.x;
    let dy = if grew_up { cur.y + extra - old.y } else { cur.y - old.y };
    set_bounds(win, Rect { x: old.x + dx, y: old.y + dy, ..old });
    if dx != 0 || dy != 0 {
        inner.temp_from_logo = false;
        remember_pos(win, inner);
        schedule_save(app, inner);
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

// ---------- widget visibility / tray ----------
fn show_widget(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = win.show();
        let _ = win.emit("wake", ());
    }
    update_tray(app);
}

/// Global hotkey: bring the widget to the front (expanded), or hide it if it
/// already has focus. Briefly going always-on-top beats Windows' focus-steal guard.
fn bring_to_front(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        let _ = win.hide();
        update_tray(app);
        return;
    }
    show_widget(app);
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    let on_top = stay_on_top(&app.state::<Shared>().lock().unwrap());
    if !on_top {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let keep = stay_on_top(&app.state::<Shared>().lock().unwrap());
            if let Some(w) = main_window(&app) {
                let _ = w.set_always_on_top(keep);
            }
        });
    }
}

fn set_stay_on_top(app: &AppHandle, on: bool) {
    {
        let st = app.state::<Shared>();
        let mut g = st.lock().unwrap();
        g.settings.insert("stayOnTop".into(), json!(on));
        schedule_save(app, &mut g);
    }
    if let Some(win) = main_window(app) {
        let _ = win.set_always_on_top(on);
        let _ = win.emit("settings-changed", json!({ "stayOnTop": on }));
    }
    update_tray(app);
}

fn auto_start(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn set_auto_start(app: &AppHandle, on: bool) -> bool {
    let al = app.autolaunch();
    let _ = if on { al.enable() } else { al.disable() };
    auto_start(app)
}

fn update_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let (np, on_top, hotkey, ad_duck, ad_level) = {
        let st = app.state::<Shared>();
        let g = st.lock().unwrap();
        (
            g.now_playing.clone(),
            stay_on_top(&g),
            g.hotkey,
            g.settings.get("adDuck").and_then(Value::as_bool).unwrap_or(true),
            g.settings.get("adLevel").and_then(Value::as_f64).unwrap_or(0.5),
        )
    };
    let tip: Vec<&str> = ["Radio Widget", np.station.as_str(), np.title.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let tip: String = tip.join("\n").chars().take(127).collect();
    let _ = tray.set_tooltip(Some(tip));

    let visible = main_window(app).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let play = MenuItem::with_id(app, "toggle-play", if np.playing { "Pause" } else { "Play" }, true, None::<&str>)?;
        let show = MenuItem::with_id(app, "showhide", if visible { "Hide widget" } else { "Show widget" }, true, hotkey)?;
        let top = CheckMenuItem::with_id(app, "stayontop", "Stay on top", true, on_top, None::<&str>)?;
        let auto = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, auto_start(app), None::<&str>)?;
        let duck = CheckMenuItem::with_id(app, "adduck", "Lower volume during ads", true, ad_duck, None::<&str>)?;
        let levels = AD_LEVELS
            .iter()
            .map(|&(id, label, v)| CheckMenuItem::with_id(app, id, label, ad_duck, (ad_level - v).abs() < 0.01, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let level_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = levels.iter().map(|m| m as _).collect();
        let level = Submenu::with_items(app, "Ad volume", ad_duck, &level_refs)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        Menu::with_items(
            app,
            &[
                &play,
                &show,
                &PredefinedMenuItem::separator(app)?,
                &top,
                &auto,
                &PredefinedMenuItem::separator(app)?,
                &duck,
                &level,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Ad volume as a share of the user's own volume.
const AD_LEVELS: [(&str, &str, f64); 3] = [
    ("adlevel-30", "Much quieter (30%)", 0.3),
    ("adlevel-50", "Quieter (50%)", 0.5),
    ("adlevel-70", "A little quieter (70%)", 0.7),
];

fn set_setting(app: &AppHandle, key: &str, v: Value) {
    {
        let st = app.state::<Shared>();
        let mut g = st.lock().unwrap();
        g.settings.insert(key.into(), v.clone());
        schedule_save(app, &mut g);
    }
    if let Some(w) = main_window(app) {
        let _ = w.emit("settings-changed", json!({ key: v }));
    }
    update_tray(app);
}

fn on_menu(app: &AppHandle, id: &str) {
    let win = main_window(app);
    match id {
        "toggle-play" => {
            if let Some(w) = win {
                let _ = w.emit("toggle-play", ());
            }
        }
        "showhide" => {
            if win.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false) {
                if let Some(w) = win {
                    let _ = w.hide();
                }
                update_tray(app);
            } else {
                bring_to_front(app);
            }
        }
        "stayontop" => {
            let cur = stay_on_top(&app.state::<Shared>().lock().unwrap());
            set_stay_on_top(app, !cur);
        }
        "autostart" => {
            let on = set_auto_start(app, !auto_start(app));
            if let Some(w) = win {
                let _ = w.emit("settings-changed", json!({ "autoStart": on }));
            }
            update_tray(app);
        }
        "open-hover" | "open-click" => {
            let v = if id == "open-hover" { "hover" } else { "click" };
            {
                let st = app.state::<Shared>();
                let mut g = st.lock().unwrap();
                g.settings.insert("logoOpenOn".into(), json!(v));
                schedule_save(app, &mut g);
            }
            if let Some(w) = win {
                let _ = w.emit("settings-changed", json!({ "logoOpenOn": v }));
            }
        }
        "adduck" => {
            let cur = app.state::<Shared>().lock().unwrap().settings.get("adDuck").and_then(Value::as_bool).unwrap_or(true);
            set_setting(app, "adDuck", json!(!cur));
        }
        "quit" => app.exit(0),
        _ => {
            if let Some(&(_, _, v)) = AD_LEVELS.iter().find(|(lid, _, _)| *lid == id) {
                set_setting(app, "adLevel", json!(v));
            }
        }
    }
}

/// The user moved the window (drag ended / in progress).
fn on_moved(app: &AppHandle, win: &WebviewWindow, x: i32, y: i32) {
    if let Some(ls) = app.try_state::<LastSet>() {
        let (last, at) = *ls.0.lock().unwrap();
        if last == Some((x, y)) || at.elapsed() < Duration::from_millis(250) {
            return; // our own setBounds
        }
    }
    let st = app.state::<Shared>();
    let Ok(mut g) = st.try_lock() else { return };
    if g.mode == "logo" {
        g.settings.insert("logoPos".into(), json!({ "x": x, "y": y }));
        // once the drag settles, pull the logo back on-screen if needed
        g.logo_gen += 1;
        let gen = g.logo_gen;
        schedule_save(app, &mut g);
        drop(g);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let Some(win) = main_window(&app) else { return };
            {
                let st = app.state::<Shared>();
                let g = st.lock().unwrap();
                if g.logo_gen != gen || g.mode != "logo" {
                    return;
                }
            }
            let b = bounds(&win);
            let r = clamp(&win, b);
            if r != b {
                set_bounds(&win, r);
            }
            let st = app.state::<Shared>();
            let mut g = st.lock().unwrap();
            g.settings.insert("logoPos".into(), json!({ "x": r.x, "y": r.y }));
            schedule_save(&app, &mut g);
        });
    } else if g.pre_dropdown.is_none() {
        g.temp_from_logo = false;
        remember_pos(win, &mut g);
        schedule_save(app, &mut g);
    }
}

// ---------- commands ----------
#[tauri::command]
fn init(app: AppHandle, state: State<Shared>) -> Value {
    let g = state.lock().unwrap();
    json!({ "settings": g.settings, "autoStart": auto_start(&app), "proxyPort": g.proxy_port })
}

#[tauri::command]
fn set_mode(app: AppHandle, state: State<Shared>, next: String) -> String {
    let Some(win) = main_window(&app) else { return next };
    let mut g = state.lock().unwrap();
    apply_mode(&app, &win, &mut g, &next);
    g.mode.clone()
}

#[tauri::command]
fn dropdown(app: AppHandle, state: State<Shared>, open: bool) -> Option<String> {
    let win = main_window(&app)?;
    let mut g = state.lock().unwrap();
    if open {
        Some(open_dropdown(&win, &mut g).to_string())
    } else {
        restore_dropdown(&app, &win, &mut g);
        None
    }
}

#[tauri::command]
fn set_stay_on_top_cmd(app: AppHandle, on: bool) -> bool {
    set_stay_on_top(&app, on);
    on
}

#[tauri::command]
fn set_auto_start_cmd(app: AppHandle, on: bool) -> bool {
    let r = set_auto_start(&app, on);
    update_tray(&app);
    r
}

#[tauri::command]
fn save(app: AppHandle, state: State<Shared>, patch: Map<String, Value>) {
    let mut g = state.lock().unwrap();
    for (k, v) in patch {
        g.settings.insert(k, v);
    }
    schedule_save(&app, &mut g);
}

const API_HOSTS: [&str; 3] = ["de1.api.radio-browser.info", "fi1.api.radio-browser.info", "de2.api.radio-browser.info"];

#[tauri::command]
async fn api(q: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = String::from("no hosts");
        for host in API_HOSTS {
            let url = format!("https://{host}/json/{q}");
            match http::get(&url, &[], Duration::from_secs(8)) {
                Ok(mut r) if r.status == 200 => {
                    let mut text = String::new();
                    if let Err(e) = std::io::Read::read_to_string(&mut r.body, &mut text) {
                        last = e.to_string();
                        continue;
                    }
                    match serde_json::from_str(&text) {
                        Ok(v) => return Ok(v),
                        Err(e) => last = e.to_string(),
                    }
                }
                Ok(r) => last = format!("HTTP {}", r.status),
                Err(e) => last = e.to_string(),
            }
        }
        Err(last)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cursor_inside(app: AppHandle) -> bool {
    let Some(win) = main_window(&app) else { return false };
    let Ok(p) = win.cursor_position() else { return false };
    let b = bounds(&win);
    let (x, y) = (p.x as i32, p.y as i32);
    x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
}

#[tauri::command]
fn logo_menu(app: AppHandle, state: State<Shared>) {
    let Some(win) = main_window(&app) else { return };
    let hover = state.lock().unwrap().settings.get("logoOpenOn").and_then(Value::as_str) != Some("click");
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        Menu::with_items(
            &app,
            &[
                &CheckMenuItem::with_id(&app, "open-hover", "Open on hover", true, hover, None::<&str>)?,
                &CheckMenuItem::with_id(&app, "open-click", "Open on click", true, !hover, None::<&str>)?,
                &PredefinedMenuItem::separator(&app)?,
                &MenuItem::with_id(&app, "quit", "Quit", true, None::<&str>)?,
            ],
        )
    };
    if let Ok(menu) = build() {
        let _ = win.popup_menu(&menu);
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn hide(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
    update_tray(&app);
}

#[tauri::command]
fn now_playing(app: AppHandle, state: State<Shared>, np: NowPlaying) {
    state.lock().unwrap().now_playing = np;
    update_tray(&app);
}

// ---------- startup ----------
fn initial_rect(win: &WebviewWindow, settings: &Map<String, Value>) -> Rect {
    let probe = bounds(win);
    let (wa, scale) = monitor_for(win, probe);
    let (w, h) = size_for("expanded", scale);
    if let Some((x, y)) = xy(settings.get("pos").and_then(|p| p.get("expanded"))) {
        let (_, s2) = monitor_for(win, Rect { x, y, w, h });
        let (w, h) = size_for("expanded", s2);
        return clamp(win, Rect { x, y, w, h });
    }
    let anchor = settings.get("anchor").and_then(|a| Some((a.get("right")?.as_f64()? as i32, a.get("bottom")?.as_f64()? as i32)));
    let margin = (MARGIN * scale).round() as i32;
    let (right, bottom) = anchor.unwrap_or((wa.x + wa.w - margin, wa.y + wa.h - margin));
    clamp(win, Rect { x: right - w, y: bottom - h, w, h })
}

const HOTKEYS: [(&str, Modifiers); 2] = [
    ("Ctrl+Alt+R", Modifiers::CONTROL.union(Modifiers::ALT)),
    ("Ctrl+Shift+Alt+R", Modifiers::CONTROL.union(Modifiers::ALT).union(Modifiers::SHIFT)),
];

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_widget(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        bring_to_front(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            init,
            set_mode,
            dropdown,
            set_stay_on_top_cmd,
            set_auto_start_cmd,
            save,
            api,
            cursor_inside,
            logo_menu,
            quit,
            hide,
            now_playing
        ])
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // × / Alt+F4 hide the widget; quit from the tray
                    api.prevent_close();
                    let _ = window.hide();
                    update_tray(app);
                }
                WindowEvent::Moved(p) => {
                    if let Some(win) = main_window(app) {
                        on_moved(app, &win, p.x, p.y);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            let port = proxy::start(handle.clone());
            let on_top = settings.get("stayOnTop").and_then(Value::as_bool).unwrap_or(false);
            app.manage(LastSet(Mutex::new((None, Instant::now()))));

            let win = main_window(&handle).expect("main window");
            let rect = initial_rect(&win, &settings);
            app.manage::<Shared>(Mutex::new(Inner {
                settings,
                mode: "expanded".into(),
                pre_dropdown: None,
                temp_from_logo: false,
                proxy_port: port,
                now_playing: NowPlaying::default(),
                hotkey: None,
                save_gen: 0,
                logo_gen: 0,
            }));
            set_bounds(&win, rect);
            let _ = win.set_always_on_top(on_top);
            let _ = win.show();
            let _ = win.set_focus();

            for (label, mods) in HOTKEYS {
                if app.global_shortcut().register(Shortcut::new(Some(mods), Code::KeyR)).is_ok() {
                    app.state::<Shared>().lock().unwrap().hotkey = Some(label);
                    break;
                }
            }

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Radio Widget")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        match main_window(app) {
                            Some(w) if w.is_visible().unwrap_or(false) => {
                                let _ = w.emit("wake", ());
                            }
                            _ => show_widget(app),
                        }
                    }
                })
                .build(app)?;
            update_tray(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Radio Widget");
}
