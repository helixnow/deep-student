//! Deep Student 音视频学习域 crate。
//!
//! - [`media`]：媒体转写流水线（解码 → VAD → ASR → 字幕段）、字幕导入导出、
//!   「音视频」资源库视图、B 站链接 / 扫码登录 / 播放流 / 传输层、学习台账
//!   （设计契约 `docs/dev/media-learning/README.md`）
//! - [`voice_input`]：受管 ASR（语音输入与媒体转写共用同一配置 / 槽位）
//! - [`cmd::media`]：`compress_image`（上传前图片压缩）
//! - [`host`]：app 侧服务（`AppState` 里的主库 / LLMManager）的注入点
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致。取 `State<'_, AppState>` 的
//! Tauri 命令以同名同签名的薄包装留在 app（`media::commands`、`media::ledger`、
//! `voice_input`），实现体在这里的 `*_with` 函数。

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{models, net_policy, token_source};
use dstu_learning::study_loop;
use dstu_llm::llm_manager;
use dstu_security::secure_store;
use dstu_storage::{database, llm_usage, unified_file_manager};
use dstu_vfs::{dstu, file_stream_protocol, vfs};

pub mod host;
pub mod media; // 音视频学习：转写流水线（解码/VAD/ASR/字幕段，docs/dev/media-learning/README.md）
pub mod voice_input;

/// 原 `deep_student_lib::cmd` 下属于本域的命令子模块（app 的 `cmd` 按原路径重导出）。
pub mod cmd {
    pub mod media;
}
