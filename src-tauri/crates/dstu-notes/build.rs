// dstu-notes 依赖 tauri（并经 dstu-vfs 引入 tauri 及 dialog 插件的传递依赖）。Windows MSVC 下它的单元测试程序会链接到
// comctl32 v6 才有的入口（TaskDialogIndirect），缺少清单依赖时启动即报
// STATUS_ENTRYPOINT_NOT_FOUND。与 app 的 build.rs `configure_windows_test_runtime` 相同：
// 只追加链接参数；本 crate 编译为 rlib，参数只作用于测试等需要链接的产物。
fn main() {
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
