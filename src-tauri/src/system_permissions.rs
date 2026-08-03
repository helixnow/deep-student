//! Safe, capability-scoped entry points into operating-system permission settings.
//!
//! The frontend passes a closed enum rather than an arbitrary URL so this command
//! cannot become a general custom-scheme launcher.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemPermissionSettingsTarget {
    Notifications,
    Microphone,
}

#[cfg(any(target_os = "macos", windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DesktopSettingsPlatform {
    #[cfg(any(target_os = "macos", test))]
    MacOSLegacy,
    #[cfg(any(target_os = "macos", test))]
    MacOSModern,
    #[cfg(any(windows, test))]
    Windows,
}

#[cfg(any(target_os = "macos", windows, test))]
fn settings_uri(
    platform: DesktopSettingsPlatform,
    permission: SystemPermissionSettingsTarget,
) -> &'static str {
    match (platform, permission) {
        #[cfg(any(target_os = "macos", test))]
        (DesktopSettingsPlatform::MacOSModern, SystemPermissionSettingsTarget::Notifications) => {
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        }
        #[cfg(any(target_os = "macos", test))]
        (DesktopSettingsPlatform::MacOSModern, SystemPermissionSettingsTarget::Microphone) => {
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone"
        }
        #[cfg(any(target_os = "macos", test))]
        (DesktopSettingsPlatform::MacOSLegacy, SystemPermissionSettingsTarget::Notifications) => {
            "x-apple.systempreferences:com.apple.preference.notifications"
        }
        #[cfg(any(target_os = "macos", test))]
        (DesktopSettingsPlatform::MacOSLegacy, SystemPermissionSettingsTarget::Microphone) => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        #[cfg(any(windows, test))]
        (DesktopSettingsPlatform::Windows, SystemPermissionSettingsTarget::Notifications) => {
            "ms-settings:notifications"
        }
        #[cfg(any(windows, test))]
        (DesktopSettingsPlatform::Windows, SystemPermissionSettingsTarget::Microphone) => {
            "ms-settings:privacy-microphone"
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_settings_platform(major_version: Option<u32>) -> DesktopSettingsPlatform {
    if major_version.is_some_and(|major| major < 13) {
        DesktopSettingsPlatform::MacOSLegacy
    } else {
        DesktopSettingsPlatform::MacOSModern
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_major_version(raw: &[u8]) -> Option<u32> {
    std::str::from_utf8(raw)
        .ok()?
        .trim()
        .split('.')
        .next()?
        .parse::<u32>()
        .ok()
}

#[cfg(target_os = "macos")]
fn open_platform_settings(permission: SystemPermissionSettingsTarget) -> Result<(), String> {
    use std::process::Command;

    let macos_major_version = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_macos_major_version(&output.stdout));

    let status = Command::new("/usr/bin/open")
        .arg(settings_uri(
            macos_settings_platform(macos_major_version),
            permission,
        ))
        .status()
        .map_err(|error| format!("Failed to launch macOS System Settings: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "macOS System Settings launcher exited with status {status}"
        ))
    }
}

#[cfg(windows)]
fn open_platform_settings(permission: SystemPermissionSettingsTarget) -> Result<(), String> {
    use std::path::PathBuf;
    use std::process::Command;

    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Command::new(system_root.join("explorer.exe"))
        .arg(settings_uri(DesktopSettingsPlatform::Windows, permission))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch Windows Settings: {error}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_platform_settings(_permission: SystemPermissionSettingsTarget) -> Result<(), String> {
    Err(
        "This desktop environment does not provide a portable permission-settings shortcut"
            .to_string(),
    )
}

#[tauri::command]
pub async fn open_system_permission_settings(
    permission: SystemPermissionSettingsTarget,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_platform_settings(permission))
        .await
        .map_err(|error| format!("Permission-settings launcher task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{DesktopSettingsPlatform, SystemPermissionSettingsTarget};

    #[test]
    fn maps_modern_macos_targets_to_fixed_system_settings_urls() {
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::MacOSModern,
                SystemPermissionSettingsTarget::Notifications,
            ),
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        );
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::MacOSModern,
                SystemPermissionSettingsTarget::Microphone,
            ),
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone"
        );
    }

    #[test]
    fn maps_legacy_macos_targets_to_fixed_system_preferences_urls() {
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::MacOSLegacy,
                SystemPermissionSettingsTarget::Notifications,
            ),
            "x-apple.systempreferences:com.apple.preference.notifications"
        );
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::MacOSLegacy,
                SystemPermissionSettingsTarget::Microphone,
            ),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
    }

    #[test]
    fn selects_legacy_urls_only_before_macos_ventura() {
        assert_eq!(
            super::macos_settings_platform(Some(12)),
            DesktopSettingsPlatform::MacOSLegacy
        );
        assert_eq!(
            super::macos_settings_platform(Some(13)),
            DesktopSettingsPlatform::MacOSModern
        );
        assert_eq!(
            super::macos_settings_platform(None),
            DesktopSettingsPlatform::MacOSModern
        );
    }

    #[test]
    fn parses_macos_compatibility_versions() {
        assert_eq!(super::parse_macos_major_version(b"12.7.6\n"), Some(12));
        assert_eq!(super::parse_macos_major_version(b"13.0"), Some(13));
        assert_eq!(super::parse_macos_major_version(b"26.0.1"), Some(26));
        assert_eq!(super::parse_macos_major_version(b"unknown"), None);
        assert_eq!(super::parse_macos_major_version(&[0xff]), None);
    }

    #[test]
    fn maps_windows_targets_to_fixed_settings_uris() {
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::Windows,
                SystemPermissionSettingsTarget::Notifications,
            ),
            "ms-settings:notifications"
        );
        assert_eq!(
            super::settings_uri(
                DesktopSettingsPlatform::Windows,
                SystemPermissionSettingsTarget::Microphone,
            ),
            "ms-settings:privacy-microphone"
        );
    }

    #[test]
    fn rejects_unknown_permission_targets() {
        let parsed = serde_json::from_str::<SystemPermissionSettingsTarget>("\"full_disk_access\"");
        assert!(parsed.is_err());
    }
}
