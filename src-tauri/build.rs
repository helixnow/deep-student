fn main() {
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

    tauri_build::build()
}
