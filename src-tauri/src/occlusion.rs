//! Detect when the main widget window is fully covered by other top-level
//! windows (or hidden / minimized). Used to pause the EQ while the widget
//! is not visible to the user.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetParent, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, IsIconic,
    IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT, WS_POPUP, WS_VISIBLE,
};

static LAST: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);

/// Poll occlusion every 500 ms and emit `widget-occlusion` on change.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let occluded = is_main_occluded(&app);
            let prev = LAST.swap(occluded, Ordering::SeqCst);
            if prev != occluded {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("widget-occlusion", json!({ "occluded": occluded }));
                }
            }
        }
    });
}

fn is_main_occluded(app: &AppHandle) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return true;
    };
    if !win.is_visible().unwrap_or(false) {
        return true;
    }
    let Ok(hwnd) = win.hwnd() else {
        return true;
    };
    let hwnd = HWND(hwnd.0);
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return true;
        }
        let mut mine = RECT::default();
        if GetWindowRect(hwnd, &mut mine).is_err() {
            return true;
        }
        if mine.right <= mine.left || mine.bottom <= mine.top {
            return true;
        }
        fully_covered(hwnd, mine)
    }
}

/// True when every pixel of `mine` is covered by at least one window above us.
unsafe fn fully_covered(hwnd: HWND, mine: RECT) -> bool {
    let covers: Mutex<Vec<RECT>> = Mutex::new(Vec::new());
    let state = EnumState {
        target: hwnd,
        mine,
        covers: &covers,
    };
    let _ = EnumWindows(Some(enum_proc), LPARAM(std::ptr::from_ref(&state) as isize));
    let rects = covers.into_inner().unwrap_or_default();
    if rects.is_empty() {
        return false;
    }
    let mut uncovered = vec![mine];
    for c in rects {
        let mut next = Vec::new();
        for u in uncovered {
            next.extend(subtract_rect(u, c));
        }
        uncovered = next;
        if uncovered.is_empty() {
            return true;
        }
    }
    false
}

struct EnumState<'a> {
    target: HWND,
    mine: RECT,
    covers: &'a Mutex<Vec<RECT>>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &*(lparam.0 as *const EnumState);
    if hwnd == state.target {
        return BOOL(0); // stop: later windows are below us
    }
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    // "visible" but not drawn: windows on another virtual desktop, suspended store apps
    let mut cloaked = 0u32;
    let asked = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, std::ptr::from_mut(&mut cloaked).cast(), 4);
    if asked.is_ok() && cloaked != 0 {
        return BOOL(1);
    }
    if GetParent(hwnd).is_ok() {
        return BOOL(1);
    }
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_TRANSPARENT.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 {
        return BOOL(1);
    }
    if style & WS_VISIBLE.0 == 0 {
        return BOOL(1);
    }
    let titled = GetWindowTextLengthW(hwnd) > 0;
    let has_chrome = style & WS_CAPTION.0 != 0 || style & WS_POPUP.0 != 0;
    if !titled && !has_chrome {
        return BOOL(1);
    }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() {
        return BOOL(1);
    }
    if !rects_intersect(state.mine, r) {
        return BOOL(1);
    }
    if let Ok(mut g) = state.covers.lock() {
        g.push(r);
    }
    BOOL(1)
}

fn rects_intersect(a: RECT, b: RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// Rectangle difference: `a` minus `b`, as up to 4 leftover rects.
fn subtract_rect(a: RECT, b: RECT) -> Vec<RECT> {
    if !rects_intersect(a, b) {
        return vec![a];
    }
    let ix0 = a.left.max(b.left);
    let iy0 = a.top.max(b.top);
    let ix1 = a.right.min(b.right);
    let iy1 = a.bottom.min(b.bottom);
    let mut out = Vec::new();
    if a.top < iy0 {
        out.push(RECT {
            left: a.left,
            top: a.top,
            right: a.right,
            bottom: iy0,
        });
    }
    if iy1 < a.bottom {
        out.push(RECT {
            left: a.left,
            top: iy1,
            right: a.right,
            bottom: a.bottom,
        });
    }
    if a.left < ix0 {
        out.push(RECT {
            left: a.left,
            top: iy0,
            right: ix0,
            bottom: iy1,
        });
    }
    if ix1 < a.right {
        out.push(RECT {
            left: ix1,
            top: iy0,
            right: a.right,
            bottom: iy1,
        });
    }
    out
}
