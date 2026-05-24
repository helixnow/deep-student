// src-tauri/src/menu.rs
//
// macOS native menu bar — Phase D2 of the native-feel migration (2026-05-14).
//
// On macOS, every window-bearing application is expected to expose a top-of-
// screen menu bar with at least File / Edit / View / Window / Help. Tauri 2's
// `tauri::menu` module produces a real NSMenu rooted at the application
// (visible in the Apple-style menu strip across the top of the screen), with
// system shortcuts that work even when the window has no input focus.
//
// On Windows / Linux we deliberately do not install a menu — those platforms
// already have window controls and an in-app command palette (Cmd/Ctrl+K),
// so a menu bar would be a duplicate. The whole module is `cfg(target_os =
// "macos")` for that reason.
//
// The menu items emit events on the `AppHandle`; the React side listens via
// @tauri-apps/api/event and dispatches into the existing command palette
// (so a single command implementation backs both the menu and Cmd+K).
//
// Design doc: docs/plans/2026-05-14-native-feel-migration-design.md

#![cfg(target_os = "macos")]

use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

/// Frontend event ids. Keep in sync with `src/menu/menuEvents.ts`.
pub const EVENT_PREFERENCES: &str = "menu://preferences";
pub const EVENT_NEW_SESSION: &str = "menu://new-session";
pub const EVENT_COMMAND_PALETTE: &str = "menu://command-palette";
pub const EVENT_TOGGLE_SIDEBAR: &str = "menu://toggle-sidebar";
pub const EVENT_DOCUMENTATION: &str = "menu://documentation";
pub const EVENT_REPORT_ISSUE: &str = "menu://report-issue";

/// Build and install the macOS menu bar. Call from `setup()`.
pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(handle_menu_event);
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ----- Application menu (left of the menu bar, named after the app) -----
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Deep Student"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("Deep Student contributors"))
        .build();

    let preferences = MenuItem::with_id(
        app,
        "preferences",
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let app_submenu = Submenu::with_items(
        app,
        "Deep Student",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Deep Student"), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &preferences,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ----- File -----
    let new_session = MenuItem::with_id(
        app,
        "new_session",
        "New Conversation",
        true,
        Some("CmdOrCtrl+N"),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // ----- Edit (system-provided, supports the WebView's Cut/Copy/Paste) -----
    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // ----- View -----
    let command_palette = MenuItem::with_id(
        app,
        "command_palette",
        "Command Palette…",
        true,
        Some("CmdOrCtrl+K"),
    )?;

    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle_sidebar",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;

    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &command_palette,
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    // ----- Window -----
    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    // ----- Help -----
    let documentation = MenuItem::with_id(
        app,
        "documentation",
        "Deep Student Documentation",
        true,
        None::<&str>,
    )?;
    let report_issue = MenuItem::with_id(app, "report_issue", "Report Issue…", true, None::<&str>)?;

    let help_submenu = Submenu::with_items(app, "Help", true, &[&documentation, &report_issue])?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

/// Forward our custom menu items to the React side. Predefined items
/// (Cut/Copy/Paste/Quit/etc.) are handled by Tauri / AppKit directly.
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    let event_name = match id {
        "preferences" => Some(EVENT_PREFERENCES),
        "new_session" => Some(EVENT_NEW_SESSION),
        "command_palette" => Some(EVENT_COMMAND_PALETTE),
        "toggle_sidebar" => Some(EVENT_TOGGLE_SIDEBAR),
        "documentation" => Some(EVENT_DOCUMENTATION),
        "report_issue" => Some(EVENT_REPORT_ISSUE),
        _ => None,
    };

    if let Some(name) = event_name {
        // Best-effort emit; failure here means the front-end is gone (closed
        // window) so logging is enough.
        if let Err(e) = app.emit(name, ()) {
            tracing::warn!("[menu] failed to emit {}: {}", name, e);
        }
    }
}
