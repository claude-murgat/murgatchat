#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

// AppUserModelID de l'app : DOIT être identique à l'identifiant Tauri, à l'app_id
// de la toast Windows et à l'AUMID posé par l'installeur NSIS sur le raccourci —
// sinon Windows ne route pas le clic de notification vers CE process (cf. setup).
#[cfg(windows)]
const APP_ID: &str = "com.example.chat.desktop";

// Schéma URI d'activation par protocole des toasts. Au clic sur une notification,
// Windows lance l'exe avec `murgatchat://channel/<id>` ; single-instance transmet
// cet argv à l'instance en cours (cf. main) → ouverture de la conversation. Le
// schéma est enregistré par l'installeur NSIS (installer-hooks.nsh).
#[cfg(windows)]
const DEEP_LINK_SCHEME: &str = "murgatchat";

// Échappe le texte pour l'insérer dans du XML (contenu de toast + attribut launch).
#[cfg(windows)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// Extrait l'id de salon d'un argument `murgatchat://channel/<id>` (ou None).
#[cfg(windows)]
fn channel_id_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let prefix = format!("{DEEP_LINK_SCHEME}://channel/");
    args.into_iter().find_map(|a| {
        a.strip_prefix(&prefix)
            .map(|id| id.trim_end_matches('/').to_string())
            .filter(|id| !id.is_empty())
    })
}

// Repaint a red "unread" dot into the bottom-right corner of the app icon, so
// the tray can show a badge without shipping a second icon asset. Works on the
// raw RGBA buffer (no image-crate dependency).
fn badged_icon(app: &tauri::AppHandle) -> Option<tauri::image::Image<'static>> {
    let base = app.default_window_icon()?;
    let w = base.width();
    let h = base.height();
    let mut rgba = base.rgba().to_vec();
    let radius = ((w.min(h) as f32) * 0.30) as i32;
    let cx = w as i32 - radius - 1;
    let cy = h as i32 - radius - 1;
    let r2 = radius * radius;
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= r2 {
                let idx = ((y as u32 * w + x as u32) * 4) as usize;
                if idx + 3 < rgba.len() {
                    rgba[idx] = 0xE0; // R
                    rgba[idx + 1] = 0x24; // G
                    rgba[idx + 2] = 0x24; // B
                    rgba[idx + 3] = 0xFF; // A
                }
            }
        }
    }
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

// Called from the frontend (desktop only) when a message arrives while the
// window isn't focused (true) and when it regains focus / is read (false).
#[tauri::command]
fn set_tray_badge(app: tauri::AppHandle, unread: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        if unread {
            if let Some(icon) = badged_icon(&app) {
                let _ = tray.set_icon(Some(icon));
            }
            let _ = tray.set_tooltip(Some("Chat — nouveau message"));
        } else {
            // Rebuild a plain icon from the default icon's RGBA (avoids relying on
            // Image: Clone).
            if let Some(base) = app.default_window_icon() {
                let icon = tauri::image::Image::new_owned(
                    base.rgba().to_vec(),
                    base.width(),
                    base.height(),
                );
                let _ = tray.set_icon(Some(icon));
            }
            let _ = tray.set_tooltip(Some("Chat"));
        }
    }
}

// Toast Windows « protocole » pour un nouveau message (desktop). Un clic sur une
// notification NE peut PAS être reçu en in-process pour une app Win32 non-packagée
// (Windows exigerait un activateur COM) : on émet donc une toast dont l'activation
// est un lancement de protocole `murgatchat://channel/<id>`. Au clic, Windows
// relance l'exe avec cette URI, captée par single-instance (app en cours) ou au
// démarrage (main/setup) → focus + ouverture de la conversation. Construit via
// windows-rs (le builder tauri-winrt-notification ne pose pas launch/activationType).
// Sur le thread principal : les API WinRT exigent l'apartment COM (STA) du process.
#[cfg(windows)]
#[tauri::command]
fn notify_desktop(app: tauri::AppHandle, title: String, body: String, channel_id: Option<String>) {
    let _ = app.run_on_main_thread(move || {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

        let launch = match channel_id {
            Some(id) => format!("{}://channel/{}", DEEP_LINK_SCHEME, id),
            None => format!("{}://open", DEEP_LINK_SCHEME),
        };
        let xml = format!(
            "<toast launch=\"{}\" activationType=\"protocol\"><visual><binding \
             template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding>\
             </visual></toast>",
            xml_escape(&launch),
            xml_escape(&title),
            xml_escape(&body),
        );
        let show = || -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml.as_str()))?;
            let toast = ToastNotification::CreateToastNotification(&doc)?;
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?;
            notifier.Show(&toast)?;
            Ok(())
        };
        if let Err(e) = show() {
            eprintln!("[desktop] toast show failed: {e:?}");
        }
    });
}

// Pas de toast natif hors Windows (les builds desktop sont Windows-only) ; on garde
// la commande présente pour que l'invoke handler et l'appel front compilent partout.
#[cfg(not(windows))]
#[tauri::command]
fn notify_desktop(
    _app: tauri::AppHandle,
    _title: String,
    _body: String,
    _channel_id: Option<String>,
) {
}

fn main() {
    tauri::Builder::default()
        // Single instance: a second launch (e.g. clicking the icon while the app
        // already runs hidden in the tray after autostart) focuses the existing
        // window instead of spawning a new one. Registered first, as recommended.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second lancement : soit l'icône (on ramène juste la fenêtre), soit un
            // clic sur une toast, que Windows relance avec `murgatchat://channel/<id>`
            // en argv (transmis ici). On ramène la fenêtre et, si un deep-link est
            // présent, on demande au webview d'ouvrir la conversation (#169 desktop).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            #[cfg(windows)]
            if let Some(id) = channel_id_from_args(args) {
                let _ = app.emit("desktop:notification-click", Some(id));
            }
            #[cfg(not(windows))]
            let _ = args;
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Start-on-boot. The "--hidden" arg is baked into the autostart command
        // so a login launch starts silently in the tray (handled in setup),
        // unlike a manual launch which shows the window.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        // Auto-update from the signed GitHub release endpoint, plus the process
        // plugin so the updater can relaunch the app after installing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![set_tray_badge, notify_desktop])
        .setup(|app| {
            // Fixe l'AppUserModelID explicite du process = app_id des toasts = AUMID
            // du raccourci NSIS : c'est ce qui attribue la toast à notre app (nom +
            // icône) et fiabilise sa remise, y compris au lancement autostart
            // `--hidden` (exe direct, hors raccourci).
            #[cfg(windows)]
            {
                use windows::core::HSTRING;
                use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
                unsafe {
                    let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID));
                }
            }

            // Démarrage à froid via un clic sur une notification alors que l'app
            // était fermée (rare : elle se replie dans le tray plutôt que de quitter) :
            // l'URI `murgatchat://…` est dans argv. On l'émet après un court délai,
            // le temps que le front s'abonne (best-effort ; le cas « app en cours »
            // passe par single-instance ci-dessus).
            #[cfg(windows)]
            if let Some(id) = channel_id_from_args(std::env::args()) {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let _ = handle.emit("desktop:notification-click", Some(id));
                });
            }

            // Launched at login (autostart) -> stay in the tray instead of
            // popping the window. A manual launch has no "--hidden" arg.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let show_i = MenuItem::with_id(app, "show", "Afficher Chat", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Masquer la fenêtre", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Chat")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
