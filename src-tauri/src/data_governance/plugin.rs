//! # 数据治理 Tauri 插件（未启用）
//!
//! 当前所有数据治理命令通过 `lib.rs` 的全局 `invoke_handler` 注册，
//! 不经过插件机制。此文件保留仅作为未来迁移到插件模式的参考。
//!
//! ## 为什么不使用插件模式
//!
//! 插件模式下命令名会带 `plugin:data-governance|` 前缀，
//! 而前端 `invoke()` 使用的是无前缀命令名。为保持一致，
//! 目前直接在全局 `invoke_handler` 中注册所有命令。
//!
//! ## 如何迁移到插件模式
//!
//! 1. 在 `lib.rs` 的 `setup` 中调用 `builder.plugin(data_governance::plugin::init())`
//! 2. 前端 `invoke` 调用需加前缀 `plugin:data-governance|<command_name>`
//! 3. 从全局 `invoke_handler` 中移除对应命令
