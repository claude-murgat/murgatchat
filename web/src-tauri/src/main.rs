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

// Toast natif Windows pour un nouveau message (desktop). On construit la toast en
// Rust plutôt que via tauri-plugin-notification : le chemin desktop du plugin est
// « fire-and-forget » (il jette la toast et ne câble aucun callback d'activation),
// si bien qu'un clic sur la notification Windows ne remonte JAMAIS à l'app (les
// événements JS onAction/actionPerformed sont mobile-only). Ici `on_activated`
// ramène la fenêtre au premier plan et émet `desktop:notification-click` avec l'id
// du salon, pour que le webview ouvre la bonne conversation. Exécuté sur le thread
// principal : les API WinRT de toast exigent l'apartment COM (STA) du process.
#[cfg(windows)]
#[tauri::command]
fn notify_desktop(app: tauri::AppHandle, title: String, body: String, channel_id: Option<String>) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri_winrt_notification::Toast;
        let on_click = app_handle.clone();
        // app_id = APP_ID (identifiant Tauri) = AUMID fixé au démarrage (cf. setup)
        // = AUMID du raccourci NSIS ; c'est ce qui route le clic vers ce process.
        let toast = Toast::new(APP_ID)
            .title(&title)
            .text1(&body)
            .on_activated(move |_action| {
                if let Some(win) = on_click.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = on_click.emit("desktop:notification-click", channel_id.clone());
                Ok(())
            });
        if let Err(e) = toast.show() {
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
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
            // Fixe l'AppUserModelID explicite du process = app_id des toasts (et
            // AUMID du raccourci NSIS). Sans ça, Windows ne route pas le clic d'une
            // notification vers CE process (le callback on_activated in-process),
            // notamment au lancement autostart `--hidden` (exe direct, hors raccourci).
            #[cfg(windows)]
            {
                use windows::core::HSTRING;
                use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
                unsafe {
                    let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID));
                }
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
