use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
};
use tauri::{
    utils::{
        config::{LogicalPosition, WindowConfig, WindowEffectsConfig},
        TitleBarStyle, WindowEffect, WindowEffectState,
    },
    AppHandle, Manager, Runtime, WebviewWindowBuilder,
};

const WINDOW_BACKGROUND_PREFERENCE_FILE_NAME: &str = "window-background-preference.json";
const WINDOWS_WINDOW_EFFECT_FALLBACKS: [WindowEffect; 2] = [WindowEffect::Mica, WindowEffect::Blur];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowBackgroundPreference {
    #[default]
    Translucent,
    Opaque,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPlatform {
    Macos,
    Windows,
    Other,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredWindowBackgroundPreference {
    preference: WindowBackgroundPreference,
}

fn current_desktop_platform() -> DesktopPlatform {
    if cfg!(target_os = "macos") {
        DesktopPlatform::Macos
    } else if cfg!(target_os = "windows") {
        DesktopPlatform::Windows
    } else {
        DesktopPlatform::Other
    }
}

fn window_effects_for_preference(
    preference: WindowBackgroundPreference,
    platform: DesktopPlatform,
) -> Option<WindowEffectsConfig> {
    if preference == WindowBackgroundPreference::Opaque {
        return None;
    }

    match platform {
        DesktopPlatform::Macos => Some(WindowEffectsConfig {
            effects: vec![WindowEffect::WindowBackground],
            state: Some(WindowEffectState::FollowsWindowActiveState),
            radius: None,
            color: None,
        }),
        DesktopPlatform::Windows => Some(WindowEffectsConfig {
            effects: vec![WINDOWS_WINDOW_EFFECT_FALLBACKS[0]],
            state: None,
            radius: None,
            color: None,
        }),
        DesktopPlatform::Other => None,
    }
}

pub fn apply_window_background_preference(
    config: &WindowConfig,
    preference: WindowBackgroundPreference,
    platform: DesktopPlatform,
) -> WindowConfig {
    let mut updated = config.clone();

    updated.window_effects = window_effects_for_preference(preference, platform);

    match platform {
        DesktopPlatform::Macos => {
            updated.transparent = false;
            updated.title.clear();
            updated.decorations = true;
            updated.shadow = true;
            updated.title_bar_style = TitleBarStyle::Overlay;
            updated.hidden_title = true;
            updated.traffic_light_position = Some(LogicalPosition { x: 16.0, y: 17.0 });
        }
        DesktopPlatform::Windows => {
            updated.transparent = preference == WindowBackgroundPreference::Translucent;
            updated.decorations = false;
            updated.shadow = true;
        }
        DesktopPlatform::Other => {
            updated.transparent = preference == WindowBackgroundPreference::Translucent;
        }
    }

    updated
}

fn window_background_preference_path<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<PathBuf, Box<dyn Error>> {
    Ok(app
        .path()
        .app_config_dir()?
        .join(WINDOW_BACKGROUND_PREFERENCE_FILE_NAME))
}

fn read_window_background_preference(
    path: &Path,
) -> Result<WindowBackgroundPreference, Box<dyn Error>> {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<StoredWindowBackgroundPreference>(&content) {
            Ok(stored) => Ok(stored.preference),
            Err(_) => Ok(WindowBackgroundPreference::Translucent),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(WindowBackgroundPreference::Translucent)
        }
        Err(error) => Err(Box::new(error)),
    }
}

fn write_window_background_preference(
    path: &Path,
    preference: WindowBackgroundPreference,
) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_vec_pretty(&StoredWindowBackgroundPreference { preference })?;
    fs::write(path, content)?;

    Ok(())
}

pub fn create_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .or_else(|| app.config().app.windows.first())
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "main window config missing"))?;
    let preference = read_window_background_preference(&window_background_preference_path(app)?)?;
    let platform = current_desktop_platform();
    let config = apply_window_background_preference(&config, preference, platform);

    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;

    if platform == DesktopPlatform::Macos {
        window.set_title("")?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_window_background_preference(app: AppHandle, preference: String) -> Result<(), String> {
    let preference = match preference.as_str() {
        "opaque" => WindowBackgroundPreference::Opaque,
        "translucent" => WindowBackgroundPreference::Translucent,
        _ => {
            return Err(format!(
                "unsupported window background preference: {preference}"
            ))
        }
    };

    write_window_background_preference(
        &window_background_preference_path(&app).map_err(|error| error.to_string())?,
        preference,
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_preference_path() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();

        std::env::temp_dir()
            .join("study-ui-window-background-tests")
            .join(format!("{timestamp}"))
            .join(WINDOW_BACKGROUND_PREFERENCE_FILE_NAME)
    }

    #[test]
    fn opaque_preference_disables_window_transparency_and_effects() {
        let config = WindowConfig::default();

        let updated = apply_window_background_preference(
            &config,
            WindowBackgroundPreference::Opaque,
            DesktopPlatform::Macos,
        );

        assert!(!updated.transparent);
        assert_eq!(updated.window_effects, None);
        assert!(updated.decorations);
    }

    #[test]
    fn translucent_macos_preference_uses_single_window_background_effect() {
        let config = WindowConfig::default();

        let updated = apply_window_background_preference(
            &config,
            WindowBackgroundPreference::Translucent,
            DesktopPlatform::Macos,
        );

        assert!(!updated.transparent);
        assert_eq!(
            updated.window_effects,
            Some(WindowEffectsConfig {
                effects: vec![WindowEffect::WindowBackground],
                state: Some(tauri::utils::WindowEffectState::FollowsWindowActiveState),
                radius: None,
                color: None,
            })
        );
    }

    #[test]
    fn translucent_macos_preference_keeps_native_overlay_chrome() {
        let mut config = WindowConfig::default();
        config.create = false;
        config.title = "Deep Student".into();
        config.width = 1440.0;

        let updated = apply_window_background_preference(
            &config,
            WindowBackgroundPreference::Translucent,
            DesktopPlatform::Macos,
        );

        assert!(!updated.create);
        assert!(updated.title.is_empty());
        assert_eq!(updated.width, 1440.0);
        assert!(updated.decorations);
        assert!(updated.shadow);
        assert_eq!(updated.title_bar_style, TitleBarStyle::Overlay);
        assert!(updated.hidden_title);
        assert_eq!(
            updated.traffic_light_position,
            Some(LogicalPosition { x: 16.0, y: 17.0 })
        );
        assert!(!updated.transparent);
        assert_eq!(
            updated.window_effects,
            Some(WindowEffectsConfig {
                effects: vec![WindowEffect::WindowBackground],
                state: Some(tauri::utils::WindowEffectState::FollowsWindowActiveState),
                radius: None,
                color: None,
            })
        );
    }

    #[test]
    fn translucent_windows_preference_keeps_frameless_shell() {
        let mut config = WindowConfig::default();
        config.create = false;
        config.width = 1440.0;

        let updated = apply_window_background_preference(
            &config,
            WindowBackgroundPreference::Translucent,
            DesktopPlatform::Windows,
        );

        assert!(!updated.create);
        assert_eq!(updated.width, 1440.0);
        assert!(!updated.decorations);
        assert!(updated.shadow);
        assert_eq!(
            updated.window_effects,
            Some(WindowEffectsConfig {
                effects: vec![WindowEffect::Mica],
                state: None,
                radius: None,
                color: None,
            })
        );
    }

    #[test]
    fn windows_effect_fallback_chain_stays_mica_first() {
        assert_eq!(
            WINDOWS_WINDOW_EFFECT_FALLBACKS,
            [WindowEffect::Mica, WindowEffect::Blur]
        );
    }

    #[test]
    fn missing_preference_file_defaults_to_translucent() {
        let path = temporary_preference_path();

        let preference = read_window_background_preference(&path).expect("preference should load");

        assert_eq!(preference, WindowBackgroundPreference::Translucent);
    }

    #[test]
    fn stored_preference_roundtrips() {
        let path = temporary_preference_path();

        write_window_background_preference(&path, WindowBackgroundPreference::Opaque)
            .expect("preference should be written");

        let preference = read_window_background_preference(&path).expect("preference should load");

        assert_eq!(preference, WindowBackgroundPreference::Opaque);

        let test_root = path
            .parent()
            .and_then(Path::parent)
            .expect("test root should exist");
        let _ = fs::remove_dir_all(test_root);
    }
}
