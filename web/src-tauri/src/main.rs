#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

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
        .setup(|app| {
            // Launched at login (autostart) -> stay in the tray instead of
            // popping the window. A manual launch has no "--hidden" arg.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let show_i = MenuItem::with_id(app, "show", "Afficher Chat", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Masquer la fenêtre", true, None::<&str>)?;
            // Checkable: reflects the real OS autostart registration.
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_i = CheckMenuItem::with_id(
                app,
                "autostart",
                "Lancer au démarrage",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit_i = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &autostart_i, &quit_i])?;
            // Cloned handle so the menu-event closure can refresh the checkmark.
            let autostart_item = autostart_i.clone();

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
                        "autostart" => {
                            let mgr = app.autolaunch();
                            let enabled = mgr.is_enabled().unwrap_or(false);
                            let _ = if enabled { mgr.disable() } else { mgr.enable() };
                            // Re-read the OS state so the checkmark stays truthful
                            // even if enable/disable failed.
                            let _ = autostart_item.set_checked(mgr.is_enabled().unwrap_or(!enabled));
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
