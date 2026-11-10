//! Windows Action Center toasts (WinRT) for update prompts.
//! Uses the app's AUMID (`com.moshiko.radiowidget`) so notifications show under
//! Radio Widget. Action clicks are handled while the process is still running.

use std::sync::Once;

use windows::core::{IInspectable, Interface, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

/// Same as `tauri.conf.json` `identifier`. Must match the Start Menu shortcut AUMID.
pub const AUMID: &str = "com.moshiko.radiowidget";

static INIT: Once = Once::new();

/// Call once at startup so toasts attribute to Radio Widget.
pub fn init() {
    INIT.call_once(|| {
        let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) };
    });
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub struct ToastActions {
    pub primary: (&'static str, &'static str), // (label, args)
    pub secondary: Option<(&'static str, &'static str)>,
}

/// Shows a toast in the Windows notification center. `on_action` receives the
/// action argument string (or empty / "default" when the body was clicked).
pub fn show(title: &str, body: &str, actions: Option<ToastActions>, on_action: impl Fn(String) + Send + Sync + 'static) {
    init();
    let title = xml_escape(title);
    let body = xml_escape(body);
    let actions_xml = match &actions {
        Some(a) => {
            let mut s = String::from("<actions>");
            s.push_str(&format!(
                r#"<action content="{}" arguments="{}"/>"#,
                xml_escape(a.primary.0),
                xml_escape(a.primary.1)
            ));
            if let Some((label, args)) = a.secondary {
                s.push_str(&format!(
                    r#"<action content="{}" arguments="{}"/>"#,
                    xml_escape(label),
                    xml_escape(args)
                ));
            }
            s.push_str("</actions>");
            s
        }
        None => String::new(),
    };
    let xml = format!(
        r#"<toast launch="default"><visual><binding template="ToastGeneric"><text>{title}</text><text>{body}</text></binding></visual>{actions_xml}</toast>"#
    );

    let result = (|| -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        let _ = toast.SetTag(&HSTRING::from("update"));
        let _ = toast.SetGroup(&HSTRING::from("radio-widget"));
        let handler = TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, insp| {
            let args = insp
                .ok()
                .ok()
                .and_then(|i| i.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|a| a.Arguments().ok())
                .map(|h| h.to_string())
                .unwrap_or_default();
            on_action(args);
            Ok(())
        });
        toast.Activated(&handler)?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?;
        notifier.Show(&toast)?;
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("toast failed: {e}");
    }
}
