//! System tray support.
//!
//! Provides a tray icon with a small menu and the "minimize to tray" behavior.
//! The user enables/disables minimize-to-tray from Settings -> UI; the frontend
//! notifies us via the `set_minimize_to_tray` command so the Rust side never has
//! to parse the settings store itself.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, Manager, Runtime,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// Runtime UI flags that the frontend keeps in sync with the persisted settings.
#[derive(Default)]
pub struct TrayState {
    pub minimize_to_tray: AtomicBool,
}

/// Whether the main window should hide to the tray when closed.
pub fn minimize_to_tray_enabled(app: &AppHandle<impl Runtime>) -> bool {
    app.state::<TrayState>()
        .minimize_to_tray
        .load(Ordering::Relaxed)
}

/// Bring the main window back on screen and give it focus.
pub fn show_main_window(app: &AppHandle<impl Runtime>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Create the tray icon and register the in-memory setting via a managed state.
pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    app.manage(TrayState::default());

    let show_item = MenuItem::with_id(app, "show", "Show ynoTV", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ynoTV")
        .menu(&menu)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "show" => show_main_window(app_handle),
            // Do NOT touch `minimize_to_tray` here. The exit can be cancelled by the
            // DVR exit-guard dialog ("Keep open"), which would leave the flag cleared
            // against the user's setting. The flag is only mutated via set_minimize_to_tray.
            "quit" => {
                // Persist the window geometry before exiting: app.exit(0) destroys the
                // windows without firing CloseRequested, so save_window_state (which
                // normally runs on close) would otherwise never run and the app would
                // reopen at a stale position/size.
                crate::save_window_state(app_handle);
                app_handle.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Set whether the main window should minimize to the tray on close.
///
/// The frontend calls this whenever the "Minimize to tray" UI setting changes,
/// and once on startup, so this stays in sync with the persisted setting.
#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> bool {
    app.state::<TrayState>()
        .minimize_to_tray
        .store(enabled, Ordering::Relaxed);
    enabled
}
