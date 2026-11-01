//! Deep Student 运行时平台服务 crate。
//!
//! 全局后台任务追踪、启动就绪闸门、tokio 运行时看门狗、调试日志（持久化与
//! 前端调试日志命令）、本地 metrics 端点、包管理器环境探测、一次性密钥句柄。
//! 进程级 static 都定义在这里，app 只按原路径重导出，不会出现第二份。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致，app 通过
//! `pub use dstu_platform::xxx` 保留原路径。

pub mod debug_log_service; // 调试日志持久化服务（JSON 文件 + 多级过滤）
pub mod debug_logger;

pub mod anr_watchdog; // 异步运行时看门狗（检测 tokio runtime 饥饿，非 UI 主线程 ANR，见模块文档）
pub mod background_tasks; // 全局后台任务追踪器（Audit 2 R-2.6：统一管理 fire-and-forget 任务并支持优雅关闭）
pub mod metrics_server;
pub mod package_manager;
pub mod secret_prompt;
pub mod startup_gate;
