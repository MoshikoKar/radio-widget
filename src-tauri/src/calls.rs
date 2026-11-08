//! Call detection for audio ducking.
//!
//! A call (Teams, Zoom, WhatsApp, Discord…) always has a microphone stream
//! open, so we poll the active capture endpoints for audio sessions in the
//! Active state and tell the UI which apps hold one. This works no matter what
//! the Windows "Communications" ducking setting is, and doesn't touch the mic.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// A mic must be in use this long before it counts (skips quick device probes)…
const START_AFTER: u32 = 2;
/// …and idle this long before the call is over (rides out brief reconnects).
const END_AFTER: u32 = 4;

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CallState {
    pub active: bool,
    /// apps currently holding the microphone, e.g. ["ms-teams"]
    pub apps: Vec<String>,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let me = std::process::id();
        let (mut on_for, mut off_for) = (0u32, 0u32);
        let mut active = false;
        let mut last_apps: Vec<String> = Vec::new();
        loop {
            let apps = mic_users(me).unwrap_or_default();
            if apps.is_empty() {
                on_for = 0;
                off_for += 1;
            } else {
                off_for = 0;
                on_for += 1;
            }
            let was = active;
            if !active && on_for >= START_AFTER {
                active = true;
            } else if active && off_for >= END_AFTER {
                active = false;
            }
            if active != was || (active && !apps.is_empty() && apps != last_apps) {
                if !apps.is_empty() {
                    last_apps = apps.clone();
                }
                let _ = app.emit("call", CallState { active, apps: if active { last_apps.clone() } else { vec![] } });
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Names of the processes (other than us) with an active capture session.
pub fn mic_users(me: u32) -> windows::core::Result<Vec<String>> {
    let mut out = Vec::new();
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let Ok(dev) = devices.Item(i) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(ctl) = sessions.GetSession(j) else { continue };
                if ctl.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let pid = ctl2.GetProcessId().unwrap_or(0);
                if pid == me {
                    continue;
                }
                let name = process_name(pid).unwrap_or_else(|| "app".into());
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
    }
    Ok(out)
}

fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        Some(file.trim_end_matches(".exe").trim_end_matches(".EXE").to_string())
    }
}

#[cfg(test)]
mod tests {
    /// Lists who uses a mic right now: `cargo test mic_users -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn mic_users() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        println!("mic users: {:?}", super::mic_users(std::process::id()).unwrap());
    }
}
