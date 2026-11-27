// Icône de la zone de notification (tray), Windows et Linux.
//
// Le menu suit l'état réel de la fenêtre : une seule entrée, « Ouvrir Chat » quand
// la fenêtre est cachée ou réduite, « Masquer Chat » quand elle est affichée (avant :
// « Afficher Chat » et « Masquer la fenêtre », toujours toutes les deux), puis le
// nombre de conversations non lues, puis « Quitter Chat ».
//
// Sous Linux, l'icône AppIndicator n'envoie aucun événement de clic : le clic gauche
// ouvre ce menu, et rien ne prévient quand il s'ouvre. Le menu est donc recalé à
// chaque changement d'état de la fenêtre (affichage, masquage, réduction, focus).
//
// Sous Windows, le clic gauche bascule la fenêtre : il la masque si elle est au
// premier plan, la ramène sinon (cachée, réduite ou passée derrière une autre).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, WebviewWindow, Window, WindowEvent, Wry};

const TRAY_ID: &str = "main";
const MAIN_WINDOW: &str = "main";

const ID_TOGGLE: &str = "toggle";
const ID_UNREAD: &str = "unread";
const ID_QUIT: &str = "quit";

// Sous Windows, cliquer sur l'icône active la barre des tâches : la fenêtre a déjà
// perdu le focus quand le clic arrive. Perdu depuis moins que ce délai, elle compte
// encore comme « au premier plan » (le clic la masque au lieu de la ramener).
const FOCUS_GRACE: Duration = Duration::from_millis(800);

// Après un affichage ou un masquage, le menu est recalé sur l'état réel de la
// fenêtre après ce délai (GTK applique show/hide plus tard, dans sa boucle).
const RESYNC_DELAY: Duration = Duration::from_millis(250);

struct TrayMenu {
    toggle: MenuItem<Wry>,
    unread: MenuItem<Wry>,
    state: Mutex<TrayState>,
}

#[derive(Default)]
struct TrayState {
    // Ce que dit l'entrée « toggle » : true = « Masquer Chat ».
    shown: bool,
    // Nombre de conversations non lues affiché dans le menu.
    unread: u32,
    // Dernière perte de focus de la fenêtre principale (cf. FOCUS_GRACE).
    focus_lost_at: Option<Instant>,
    // Un double-clic sous Windows émet clic, double-clic, clic : le second clic
    // annulerait le premier, on l'ignore.
    swallow_next_click: bool,
}

fn toggle_label(shown: bool) -> &'static str {
    if shown {
        "Masquer Chat"
    } else {
        "Ouvrir Chat"
    }
}

fn unread_label(count: u32) -> String {
    match count {
        0 => "Aucun message non lu".to_string(),
        1 => "1 conversation non lue".to_string(),
        n => format!("{n} conversations non lues"),
    }
}

fn tooltip(count: u32) -> String {
    if count == 0 {
        "Chat".to_string()
    } else {
        format!("Chat — {}", unread_label(count))
    }
}

fn plain_icon(app: &AppHandle) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    Some(Image::new_owned(base.rgba().to_vec(), base.width(), base.height()))
}

// Repaint a red "unread" dot into the bottom-right corner of the app icon, so
// the tray can show a badge without shipping a second icon asset. Works on the
// raw RGBA buffer (no image-crate dependency).
fn badged_icon(app: &AppHandle) -> Option<Image<'static>> {
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
    Some(Image::new_owned(rgba, w, h))
}

// Crée l'icône et son menu. `shown` : la fenêtre est affichée au démarrage (false
// pour un lancement `--hidden` à l'ouverture de session).
pub fn setup(app: &mut App, shown: bool) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, ID_TOGGLE, toggle_label(shown), true, None::<&str>)?;
    let unread = MenuItem::with_id(app, ID_UNREAD, unread_label(0), false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quitter Chat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &unread, &separator, &quit])?;

    app.manage(TrayMenu {
        toggle,
        unread,
        state: Mutex::new(TrayState {
            shown,
            ..Default::default()
        }),
    });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);
    if let Some(icon) = plain_icon(app.handle()) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        // Fait ce que dit l'entrée au moment du clic.
        ID_TOGGLE => {
            if menu_says_shown(app) {
                hide_main_window(app);
            } else {
                show_main_window(app);
            }
        }
        ID_UNREAD => show_main_window(app),
        ID_QUIT => app.exit(0),
        _ => {}
    }
}

// Seulement sous Windows : l'icône AppIndicator de Linux n'émet pas ces événements.
fn on_tray_icon_event(tray: &TrayIcon, event: TrayIconEvent) {
    let app = tray.app_handle();
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            let swallow = app.try_state::<TrayMenu>().is_some_and(|menu| {
                std::mem::take(&mut menu.state.lock().unwrap().swallow_next_click)
            });
            if swallow {
                return;
            }
            if window_in_front(app) {
                hide_main_window(app);
            } else {
                show_main_window(app);
            }
        }
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => {
            if let Some(menu) = app.try_state::<TrayMenu>() {
                menu.state.lock().unwrap().swallow_next_click = true;
            }
        }
        _ => {}
    }
}

fn menu_says_shown(app: &AppHandle) -> bool {
    app.try_state::<TrayMenu>()
        .is_some_and(|menu| menu.state.lock().unwrap().shown)
}

// Affichée = visible et pas réduite (réduite, elle reste « visible » pour l'OS).
fn is_displayed(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

fn window_in_front(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return false;
    };
    if !is_displayed(&window) {
        return false;
    }
    if window.is_focused().unwrap_or(false) {
        return true;
    }
    app.try_state::<TrayMenu>().is_some_and(|menu| {
        menu.state
            .lock()
            .unwrap()
            .focus_lost_at
            .is_some_and(|at| at.elapsed() < FOCUS_GRACE)
    })
}

// Met l'entrée « toggle » d'accord avec l'état de la fenêtre. Aucun appel Tauri sous
// le verrou : set_text repasse par le thread principal.
fn set_shown(app: &AppHandle, shown: bool) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    let changed = {
        let mut state = menu.state.lock().unwrap();
        std::mem::replace(&mut state.shown, shown) != shown
    };
    if changed {
        let _ = menu.toggle.set_text(toggle_label(shown));
    }
}

fn sync_with_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        set_shown(app, is_displayed(&window));
    }
}

// Recale le menu sur l'état réel une fois show/hide appliqués. Sous Linux, redemande
// aussi le focus d'une fenêtre qu'on vient d'afficher : set_focus ignore une fenêtre
// encore cachée ou réduite, et GTK n'applique show/unminimize que plus tard, dans sa
// boucle. La fenêtre revenait alors sans passer au premier plan.
fn resync_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(RESYNC_DELAY);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            if menu_says_shown(&handle) {
                if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
                    if !window.is_focused().unwrap_or(false) {
                        let _ = window.set_focus();
                    }
                }
            }
            sync_with_window(&handle);
        });
    });
}

// Ramène la fenêtre au premier plan (cachée, réduite ou derrière une autre). Depuis
// n'importe quel thread (clic de notification D-Bus, single-instance…).
pub fn show_main_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        set_shown(&handle, true);
        resync_later(&handle);
    });
}

// Replie la fenêtre dans le tray (l'app continue de tourner).
pub fn hide_main_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
            let _ = window.hide();
        }
        set_shown(&handle, false);
        resync_later(&handle);
    });
}

// Changements d'état venus d'ailleurs : réduction ou restauration par la barre de
// titre ou la barre des tâches, focus. Réduite, la fenêtre émet Resized (taille
// nulle sous Windows, Moved + Resized sous Linux) et perd le focus.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        WindowEvent::Focused(focused) => {
            if !focused {
                if let Some(menu) = window.app_handle().try_state::<TrayMenu>() {
                    menu.state.lock().unwrap().focus_lost_at = Some(Instant::now());
                }
            }
            sync_with_window(window.app_handle());
        }
        WindowEvent::Resized(_) => sync_with_window(window.app_handle()),
        _ => {}
    }
}

// Called from the frontend (desktop only) with the number of conversations that
// have unread messages: red dot on the icon, menu line, tooltip (Windows only, the
// AppIndicator icon has none). The frontend calls this on every channel list
// change: only touch the tray when something changed — under Linux every icon
// change writes a new PNG and reloads the indicator icon.
#[tauri::command]
pub fn set_tray_badge(app: AppHandle, count: u32) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    let previous = std::mem::replace(&mut menu.state.lock().unwrap().unread, count);
    if previous == count {
        return;
    }
    let _ = menu.unread.set_text(unread_label(count));
    let _ = menu.unread.set_enabled(count > 0);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(count)));
        if (previous > 0) != (count > 0) {
            let icon = if count > 0 {
                badged_icon(&app)
            } else {
                plain_icon(&app)
            };
            if let Some(icon) = icon {
                let _ = tray.set_icon(Some(icon));
            }
        }
    }
}
