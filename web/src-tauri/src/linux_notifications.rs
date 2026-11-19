// Notifications de bureau Linux (spécification freedesktop, sur le bus D-Bus de
// session) : l'équivalent des toasts Windows de main.rs.
//  - une seule notification par conversation, remplacée à chaque nouveau message
//    (`replaces_id`), et retirée une fois la conversation lue (CloseNotification) ;
//  - un clic (action « default ») ramène la fenêtre et ouvre la conversation.
//
// Une seule connexion D-Bus pour toute la session, et un seul fil qui écoute les
// signaux. GNOME n'envoie ActionInvoked qu'à la connexion qui a créé la
// notification : avec une connexion par notification (notify-rust), chaque
// notification remplacée garderait la sienne ouverte jusqu'à sa fermeture.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::Value;

const BUS_NAME: &str = "org.freedesktop.Notifications";
const OBJECT_PATH: &str = "/org/freedesktop/Notifications";
const INTERFACE: &str = "org.freedesktop.Notifications";

// Nom affiché par le serveur de notifications, et entrée .desktop posée par le
// paquet (`<productName>.desktop`) : GNOME et KDE y prennent l'icône de l'appli.
const APP_NAME: &str = "Chat";
const DESKTOP_ENTRY: &str = "Chat";

type OnClick = Box<dyn Fn(Option<String>) + Send + Sync>;

// Notifications affichées par cette session : id ↔ conversation.
#[derive(Default)]
struct Shown {
    by_channel: HashMap<String, u32>,
    by_id: HashMap<u32, Option<String>>,
}

impl Shown {
    // Oublie une notification. None si elle n'est pas à nous : le serveur peut
    // diffuser à tout le bus les signaux des notifications des autres applis.
    fn forget(&mut self, id: u32) -> Option<Option<String>> {
        let channel = self.by_id.remove(&id)?;
        if let Some(c) = &channel {
            if self.by_channel.get(c) == Some(&id) {
                self.by_channel.remove(c);
            }
        }
        Some(channel)
    }
}

fn lock(shown: &Mutex<Shown>) -> MutexGuard<'_, Shown> {
    shown.lock().unwrap_or_else(|e| e.into_inner())
}

// Le texte du corps peut être lu comme du balisage (capacité « body-markup »,
// celle de GNOME, KDE, dunst…) : un « < » ou un « & » d'un message ne doit ni
// casser l'affichage ni mettre en forme.
fn escape_markup(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub struct Notifier {
    proxy: Proxy<'static>,
    shown: Arc<Mutex<Shown>>,
}

impl Notifier {
    pub fn connect(on_click: OnClick) -> zbus::Result<Self> {
        let connection = Connection::session()?;
        let proxy = Proxy::new(&connection, BUS_NAME, OBJECT_PATH, INTERFACE)?;
        let shown = Arc::new(Mutex::new(Shown::default()));
        let signals = proxy.receive_all_signals()?;
        let listener_shown = Arc::clone(&shown);
        std::thread::Builder::new()
            .name("notifications".into())
            .spawn(move || {
                for msg in signals {
                    let header = msg.header();
                    match header.member().map(|m| m.as_str()) {
                        Some("ActionInvoked") => {
                            let Ok((id, action)) = msg.body().deserialize::<(u32, String)>()
                            else {
                                continue;
                            };
                            if action != "default" {
                                continue;
                            }
                            let channel = lock(&listener_shown).forget(id);
                            if let Some(channel) = channel {
                                on_click(channel);
                            }
                        }
                        Some("NotificationClosed") => {
                            if let Ok((id, _reason)) = msg.body().deserialize::<(u32, u32)>() {
                                lock(&listener_shown).forget(id);
                            }
                        }
                        _ => {}
                    }
                }
            })
            .map_err(|e| zbus::Error::Failure(format!("notification listener: {e}")))?;
        Ok(Self { proxy, shown })
    }

    pub fn notify(&self, title: &str, body: &str, channel_id: Option<String>) -> zbus::Result<()> {
        // Verrou gardé pendant l'appel : deux messages simultanés d'une même
        // conversation doivent remplacer la même notification, pas en créer deux.
        let mut shown = lock(&self.shown);
        let replaces_id = channel_id
            .as_ref()
            .and_then(|c| shown.by_channel.get(c).copied())
            .unwrap_or(0);
        let mut hints: HashMap<&str, Value> = HashMap::new();
        hints.insert("desktop-entry", Value::from(DESKTOP_ENTRY));
        hints.insert("category", Value::from("im.received"));
        let id: u32 = self.proxy.call(
            "Notify",
            &(
                APP_NAME,
                replaces_id,
                "",
                title,
                escape_markup(body),
                vec!["default", "Ouvrir"],
                hints,
                -1i32,
            ),
        )?;
        if replaces_id != 0 && id != replaces_id {
            shown.forget(replaces_id);
        }
        if let Some(c) = &channel_id {
            shown.by_channel.insert(c.clone(), id);
        }
        shown.by_id.insert(id, channel_id);
        Ok(())
    }

    pub fn clear(&self, channel_ids: &[String]) {
        let ids: Vec<u32> = {
            let mut shown = lock(&self.shown);
            let ids: Vec<u32> = channel_ids
                .iter()
                .filter_map(|c| shown.by_channel.get(c).copied())
                .collect();
            for id in &ids {
                shown.forget(*id);
            }
            ids
        };
        for id in ids {
            if let Err(e) = self.proxy.call::<_, _, ()>("CloseNotification", &id) {
                eprintln!("[desktop] close notification {id} failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forget_ignores_other_apps_notifications() {
        let mut shown = Shown::default();
        shown.by_channel.insert("c1".into(), 7);
        shown.by_id.insert(7, Some("c1".into()));
        assert_eq!(shown.forget(8), None);
        assert_eq!(shown.forget(7), Some(Some("c1".into())));
        assert!(shown.by_channel.is_empty());
    }

    #[test]
    fn forget_keeps_the_newer_notification_of_a_conversation() {
        let mut shown = Shown::default();
        shown.by_id.insert(7, Some("c1".into()));
        shown.by_id.insert(9, Some("c1".into()));
        shown.by_channel.insert("c1".into(), 9);
        shown.forget(7);
        assert_eq!(shown.by_channel.get("c1"), Some(&9));
    }

    #[test]
    fn escape_markup_neutralises_tags_and_entities() {
        assert_eq!(escape_markup("a < b && <i>c</i>"), "a &lt; b &amp;&amp; &lt;i&gt;c&lt;/i&gt;");
    }
}
