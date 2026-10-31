//! 把 app（根包 `deep-student`）的版本号注入 `dstu-core`。
//!
//! 成员 crate 的 `version` 固定为 `0.0.0`（release-please 只认 app 的版本），
//! 所以移动后的代码不能再用 `env!("CARGO_PKG_VERSION")`；统一读
//! `dstu_core::APP_VERSION`，值在编译期从根 `Cargo.toml` 的 `[package] version` 注入。

use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let app_manifest = manifest.join("../../Cargo.toml");
    println!("cargo:rerun-if-changed={}", app_manifest.display());

    let text = fs::read_to_string(&app_manifest)
        .unwrap_or_else(|error| panic!("读取 app Cargo.toml 失败: {error}"));
    let version = parse_package_version(&text)
        .unwrap_or_else(|| panic!("app Cargo.toml 缺少 [package] version"));
    println!("cargo:rustc-env=DSTU_APP_VERSION={version}");
}

/// 只扫描 `[package]` 段里的 `version = "..."`，不引入 toml 依赖。
fn parse_package_version(text: &str) -> Option<String> {
    let mut in_package = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "version" {
            continue;
        }
        let value = value.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}
