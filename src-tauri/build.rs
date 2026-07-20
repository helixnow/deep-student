use std::collections::BTreeSet;
use std::path::PathBuf;

#[path = "build_support/app_command_parser.rs"]
mod app_command_parser;

const ANDROID_RECORD_AUDIO_PERMISSION: &str = "android.permission.RECORD_AUDIO";
const ANDROID_MODIFY_AUDIO_SETTINGS_PERMISSION: &str = "android.permission.MODIFY_AUDIO_SETTINGS";
const APP_COMMAND_PERMISSION_FILE: &str = "permissions/application-commands.toml";
const BUILD_NUMBER_BASE: u32 = 14633;
const BUILD_NUMBER_BASE_COMMIT: &str = "4d65d159da028a3f476837a30c03b892343e00cc";
const BUILD_NUMBER_MAX: u32 = 2_100_000_000;

fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_ENV");
    println!("cargo:rerun-if-env-changed=DEEP_STUDENT_BUILD_NUMBER");
    println!("cargo:rerun-if-env-changed=SENTRY_DSN");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/AndroidManifest.xml");

    configure_windows_test_runtime();

    // 使用 vendored protoc，自动设置环境变量
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    std::env::set_var(
        "PROTOC_INCLUDE",
        protoc_bin_vendored::include_path().unwrap(),
    );

    // 注入版本元数据（供 Rust 运行时与前端/Sentry 使用）。Numeric build
    // 在分叉上可能相同，因此 Sentry release 还必须包含完整 commit ID。
    let git_revision = resolve_git_revision();
    let git_hash = if git_revision == "unknown" {
        git_revision.as_str()
    } else {
        &git_revision[..8]
    };
    let build_number = resolve_build_number();
    let app_version = verify_application_versions();
    let sentry_release = format!("{app_version}+{build_number}.{git_revision}");
    println!("cargo:rustc-env=GIT_HASH={git_hash}");
    println!("cargo:rustc-env=BUILD_NUMBER={build_number}");
    println!("cargo:rustc-env=SENTRY_RELEASE={sentry_release}");

    emit_git_rerun_paths();

    ensure_android_microphone_permissions();
    verify_application_command_acl();
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new()),
    )
    .unwrap_or_else(|error| panic!("failed to build Tauri application with app ACL: {error:#}"));
    verify_generated_application_acl();
    ensure_android_microphone_permissions();
}

fn resolve_build_number() -> u32 {
    if let Some(overridden) = std::env::var_os("DEEP_STUDENT_BUILD_NUMBER") {
        let overridden = overridden
            .into_string()
            .expect("DEEP_STUDENT_BUILD_NUMBER must be valid UTF-8 decimal digits");
        return validate_build_number(&overridden, "DEEP_STUDENT_BUILD_NUMBER");
    }

    let baseline_spec = format!("{BUILD_NUMBER_BASE_COMMIT}^{{commit}}");
    git_output(&["cat-file", "-e", &baseline_spec]).unwrap_or_else(|error| {
        panic!(
            "Git history does not contain build baseline {BUILD_NUMBER_BASE_COMMIT}: {error}. \
             Fetch full history or set DEEP_STUDENT_BUILD_NUMBER explicitly."
        )
    });
    git_output(&[
        "merge-base",
        "--is-ancestor",
        BUILD_NUMBER_BASE_COMMIT,
        "HEAD",
    ])
    .unwrap_or_else(|error| {
        panic!(
            "HEAD must descend from build baseline {BUILD_NUMBER_BASE_COMMIT}: {error}. \
             Set DEEP_STUDENT_BUILD_NUMBER explicitly for an independent release line."
        )
    });

    let revision_range = format!("{BUILD_NUMBER_BASE_COMMIT}..HEAD");
    let commit_count = git_output(&["rev-list", "--count", &revision_range])
        .unwrap_or_else(|error| panic!("failed to calculate stable build number: {error}"));
    let commit_count = commit_count
        .parse::<u32>()
        .unwrap_or_else(|_| panic!("git returned an invalid commit count: {commit_count:?}"));
    let build_number = BUILD_NUMBER_BASE
        .checked_add(commit_count)
        .expect("generated build number overflowed u32");
    validate_build_number(&build_number.to_string(), "generated BUILD_NUMBER")
}

fn verify_application_versions() -> String {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"),
    );
    let package_json_path = manifest_dir
        .parent()
        .expect("src-tauri must have a project root")
        .join("package.json");
    let tauri_config_path = manifest_dir.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", package_json_path.display());
    println!("cargo:rerun-if-changed={}", tauri_config_path.display());

    let json_version = |path: &std::path::Path| {
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display())),
        )
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
        value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .filter(|version| !version.is_empty())
            .unwrap_or_else(|| panic!("{} must contain a string version", path.display()))
            .to_owned()
    };

    let package_version = json_version(&package_json_path);
    let cargo_version = std::env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION must be set");
    let tauri_version = json_version(&tauri_config_path);
    assert_eq!(
        package_version, cargo_version,
        "package.json version does not match Cargo.toml version"
    );
    assert_eq!(
        tauri_version, cargo_version,
        "tauri.conf.json version does not match Cargo.toml version"
    );
    cargo_version
}

fn resolve_git_revision() -> String {
    match git_output(&["rev-parse", "HEAD"]) {
        Ok(revision)
            if matches!(revision.len(), 40 | 64)
                && revision.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            revision.to_ascii_lowercase()
        }
        Ok(revision) => {
            println!("cargo:warning=git returned an invalid commit ID: {revision:?}");
            "unknown".to_string()
        }
        Err(error) => {
            println!("cargo:warning=failed to resolve Git commit ID: {error}");
            "unknown".to_string()
        }
    }
}

fn validate_build_number(value: &str, source: &str) -> u32 {
    assert!(
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "{source} must contain decimal digits only, got {value:?}"
    );
    let build_number = value
        .parse::<u32>()
        .unwrap_or_else(|_| panic!("{source} must be a positive integer, got {value:?}"));
    assert!(
        build_number > BUILD_NUMBER_BASE && build_number <= BUILD_NUMBER_MAX,
        "{source} must be greater than {BUILD_NUMBER_BASE} and at most {BUILD_NUMBER_MAX}, got {build_number}"
    );
    build_number
}

fn git_output(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git {} exited with {}{}",
            args.join(" "),
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn emit_git_rerun_paths() {
    for git_path in ["HEAD", "packed-refs"] {
        if let Ok(path) = git_output(&["rev-parse", "--git-path", git_path]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }

    if let Ok(head_ref) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        if let Ok(path) = git_output(&["rev-parse", "--git-path", &head_ref]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// Tauri only enforces ACLs for application commands when an app manifest exists.
/// Keep the checked-in permission synchronized with `generate_handler!`; otherwise a
/// newly registered command would either be unusable in `main` or accidentally tempt
/// a future developer to remove the app ACL entirely.
fn verify_application_command_acl() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"),
    );
    let lib_path = manifest_dir.join("src/lib.rs");
    let permission_path = manifest_dir.join(APP_COMMAND_PERMISSION_FILE);

    println!("cargo:rerun-if-changed={}", lib_path.display());
    println!("cargo:rerun-if-changed={}", permission_path.display());

    let source = std::fs::read_to_string(&lib_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", lib_path.display()));
    let permission = std::fs::read_to_string(&permission_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", permission_path.display()));

    let registered = app_command_parser::extract_registered_commands(&source)
        .unwrap_or_else(|error| panic!("failed to parse app command registry: {error}"));
    let allowed = extract_allowed_commands(&permission);
    let missing: Vec<_> = registered.difference(&allowed).cloned().collect();
    let stale: Vec<_> = allowed.difference(&registered).cloned().collect();

    assert!(
        !registered.is_empty(),
        "app ACL check could not find the tauri::generate_handler! command list"
    );
    assert!(
        missing.is_empty() && stale.is_empty(),
        "{APP_COMMAND_PERMISSION_FILE} is out of sync with src/lib.rs; missing={missing:?}, stale={stale:?}"
    );
}

fn extract_allowed_commands(permission: &str) -> BTreeSet<String> {
    let body = permission
        .split_once("commands.allow = [")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.split_once('\n').map(|(_, body)| body))
        .and_then(|body| body.split_once("\n]").map(|(body, _)| body))
        .expect("application command permission must contain commands.allow = [...] ");

    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.strip_prefix('"')
                .and_then(|line| line.strip_suffix("\","))
                .unwrap_or_else(|| panic!("invalid app ACL command entry: {line}"))
                .to_owned()
        })
        .collect()
}

/// Assert the exact security property in Tauri's generated build artifacts: the
/// app manifest is active, while only the trusted local `main` webview receives
/// desktop app commands. Mobile remains a single-webview window and is scoped by
/// its `main` window label.
fn verify_generated_application_acl() {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR must be set"));
    let manifests_path = out_dir.join("acl-manifests.json");
    let capabilities_path = out_dir.join("capabilities.json");
    let manifests: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifests_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {error}", manifests_path.display())
        }))
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", manifests_path.display()));
    let capabilities: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&capabilities_path).unwrap_or_else(|error| {
            panic!("failed to read {}: {error}", capabilities_path.display())
        }))
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", capabilities_path.display()));

    let app_manifest = manifests
        .get("__app-acl__")
        .expect("generated ACL is missing __app-acl__; app commands would bypass authorization");
    let app_commands = app_manifest
        .pointer("/permissions/allow-application-commands/commands/allow")
        .and_then(serde_json::Value::as_array)
        .expect("generated app ACL is missing allow-application-commands");
    assert!(
        app_commands
            .iter()
            .any(|command| command.as_str() == Some("test_mcp_connection")),
        "generated app ACL must cover the process-spawning test_mcp_connection command"
    );
    let browser_input_commands = app_manifest
        .pointer("/permissions/allow-browser-content-user-input/commands/allow")
        .and_then(serde_json::Value::as_array)
        .expect("generated app ACL is missing allow-browser-content-user-input");
    assert_eq!(
        browser_input_commands,
        &[serde_json::Value::String(
            "browser_content_user_input".into()
        )],
        "browser content permission must expose only the trusted-input command"
    );

    let capabilities = capabilities
        .as_object()
        .expect("generated capabilities must be a JSON object");
    let browser = capabilities
        .get("browser-content")
        .expect("generated capabilities are missing browser-content isolation");
    assert_eq!(
        browser
            .get("webviews")
            .and_then(serde_json::Value::as_array),
        Some(&vec![serde_json::Value::String("browser-content".into())]),
        "browser-content capability must target only the browser-content webview"
    );
    assert!(
        browser.get("windows").is_none()
            || browser
                .get("windows")
                .and_then(serde_json::Value::as_array)
                .is_some_and(Vec::is_empty),
        "browser-content capability must not inherit permissions by window label"
    );
    assert_eq!(
        browser
            .get("permissions")
            .and_then(serde_json::Value::as_array),
        Some(&vec![serde_json::Value::String(
            "allow-browser-content-user-input".into()
        )]),
        "browser-content must receive only its nonce-authenticated input permission"
    );
    assert_eq!(
        browser.get("local").and_then(serde_json::Value::as_bool),
        Some(false),
        "browser-content permission is intended only for loaded remote pages"
    );

    let mut app_command_capabilities = Vec::new();
    for (identifier, capability) in capabilities {
        let has_app_commands = capability
            .get("permissions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|permissions| {
                permissions
                    .iter()
                    .any(|permission| permission.as_str() == Some("allow-application-commands"))
            });
        if has_app_commands {
            assert_eq!(
                capability.get("local").and_then(serde_json::Value::as_bool),
                Some(true),
                "{identifier} must allow app commands only for the local app origin"
            );
            assert!(
                capability.get("remote").is_none() || capability.get("remote").unwrap().is_null(),
                "{identifier} must not grant app commands to remote origins"
            );
            let selector = if identifier == "default" {
                assert!(
                    capability.get("windows").is_none()
                        || capability
                            .get("windows")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(Vec::is_empty),
                    "desktop app commands must not be inherited by every webview in main"
                );
                "webviews"
            } else {
                "windows"
            };
            assert!(
                capability
                    .get(selector)
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|targets| {
                        !targets.is_empty()
                            && targets.iter().all(|target| target.as_str() == Some("main"))
                    }),
                "{identifier} must grant app commands only to the trusted main {selector} selector"
            );
            app_command_capabilities.push(identifier.as_str());
        }
    }
    app_command_capabilities.sort_unstable();
    assert_eq!(
        app_command_capabilities,
        ["default", "mobile"],
        "only desktop/mobile main capabilities may grant application commands"
    );
}

/// Tauri 只把 Common Controls v6 manifest 资源链接到应用 bin；Cargo 的 lib-test
/// harness 默认没有该资源。Windows/MSVC 会因此绑定到 comctl32 v5，并在加载
/// `TaskDialogIndirect` 时以 STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) 退出。
///
/// 通用 link arg 会覆盖 lib-test harness；主应用已有相同依赖，link.exe 会去重合并。
fn configure_windows_test_runtime() {
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc");
    if !is_windows_msvc {
        return;
    }

    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

fn ensure_android_microphone_permissions() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("android") {
        return;
    }

    let manifest_path = android_manifest_path();
    if !manifest_path.exists() {
        println!(
            "cargo:warning=Android manifest not found at {}, skipping microphone permission injection",
            manifest_path.display()
        );
        return;
    }

    let Ok(mut manifest) = std::fs::read_to_string(&manifest_path) else {
        println!(
            "cargo:warning=Failed to read Android manifest at {}, skipping microphone permission injection",
            manifest_path.display()
        );
        return;
    };

    let mut changed = false;
    changed |= inject_android_permission(&mut manifest, ANDROID_RECORD_AUDIO_PERMISSION);
    changed |= inject_android_permission(&mut manifest, ANDROID_MODIFY_AUDIO_SETTINGS_PERMISSION);

    if !changed {
        return;
    }

    if let Err(error) = std::fs::write(&manifest_path, manifest) {
        println!(
            "cargo:warning=Failed to update Android manifest at {}: {}",
            manifest_path.display(),
            error
        );
        return;
    }

    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!(
        "cargo:warning=Injected Android microphone permissions into {}",
        manifest_path.display()
    );
}

fn android_manifest_path() -> PathBuf {
    if let Some(project_path) = std::env::var_os("TAURI_ANDROID_PROJECT_PATH") {
        return PathBuf::from(project_path).join("app/src/main/AndroidManifest.xml");
    }

    PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("gen/android/app/src/main/AndroidManifest.xml")
}

fn inject_android_permission(manifest: &mut String, permission: &str) -> bool {
    if manifest.contains(permission) {
        return false;
    }

    let permission_line = format!("    <uses-permission android:name=\"{permission}\" />\n");
    let insert_at = manifest
        .find("<manifest")
        .and_then(|start| manifest[start..].find('>').map(|offset| start + offset + 1));

    if let Some(index) = insert_at {
        manifest.insert_str(index, &format!("\n{permission_line}"));
    } else if let Some(index) = manifest.find("</manifest>") {
        manifest.insert_str(index, &permission_line);
    } else {
        if !manifest.ends_with('\n') {
            manifest.push('\n');
        }
        manifest.push_str(&permission_line);
    }

    true
}
