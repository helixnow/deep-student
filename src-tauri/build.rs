use std::path::PathBuf;

const ANDROID_RECORD_AUDIO_PERMISSION: &str = "android.permission.RECORD_AUDIO";
const ANDROID_MODIFY_AUDIO_SETTINGS_PERMISSION: &str = "android.permission.MODIFY_AUDIO_SETTINGS";

fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/AndroidManifest.xml");

    // 使用 vendored protoc，自动设置环境变量
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    std::env::set_var(
        "PROTOC_INCLUDE",
        protoc_bin_vendored::include_path().unwrap(),
    );

    // 注入 Git commit hash 和 build number（供 Rust 运行时使用）
    // 用法：env!("GIT_HASH")、env!("BUILD_NUMBER")
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .output()
    {
        let git_hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !git_hash.is_empty() {
            println!("cargo:rustc-env=GIT_HASH={}", git_hash);
        } else {
            println!("cargo:rustc-env=GIT_HASH=unknown");
        }
    } else {
        println!("cargo:rustc-env=GIT_HASH=unknown");
    }

    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-list", "--all", "--count"])
        .output()
    {
        let commit_count = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Ok(count) = commit_count.parse::<u32>() {
            let build_number = 9000 + count; // 与 generate-version.mjs 保持一致
            println!("cargo:rustc-env=BUILD_NUMBER={}", build_number);
        } else {
            println!("cargo:rustc-env=BUILD_NUMBER=0");
        }
    } else {
        println!("cargo:rustc-env=BUILD_NUMBER=0");
    }

    // 不在 git 仓库变化时反复重新编译
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/");

    ensure_android_microphone_permissions();
    tauri_build::build();
    ensure_android_microphone_permissions();
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
