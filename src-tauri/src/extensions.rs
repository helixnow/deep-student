//! 扩展点组合根：低层模块对上层能力的回调统一在这里接线。
//!
//! 低层（llm_manager、vfs 等）不能直接依赖上层模块，只在自己的模块里声明
//! `dstu-kernel` 的 `Slot` / `HookSet`；上层实现被组织成下面的显式有序插件列表，
//! 由进程级 [`PluginHost`] 依次 apply。`run()` 第一行调用 `register_extensions()`，
//! 保证任何业务代码执行前回调都已就位，与拆分前直接调用的行为一致。单元测试若
//! 走到这些回调，也在开头调用它。
//!
//! 约定：
//! - 插件列表**显式有序**，禁止 `inventory` / `linkme` 等链接期自动收集
//!   （Android staticlib 会被链接器裁剪）。
//! - 进程生命周期内插件不卸载；`PluginHost` 由本模块的 `OnceLock` 持有，插件注入
//!   产生的 `Disposer` 存在各自的 `Scope` 里。
//! - apply 幂等由 `PluginHost` 按插件名保证；重复调用 `register_extensions()` 不会重复注册。

use std::sync::{Arc, Mutex, OnceLock};

use dstu_kernel::{Plugin, PluginError, PluginHost, Scope};

/// llm_manager 的 legacy 回退注入（模型不支持工具调用）使用的 web_search。
///
/// 与 `ChatV2Pipeline::new` 里的兼容入口共用同一个低层 provide：谁先注册谁生效，
/// 后到的一方看到 `SlotOccupied` 即视为已就位。
struct WebSearchFallbackPlugin;

impl Plugin for WebSearchFallbackPlugin {
    fn name(&self) -> &'static str {
        "web_search_fallback"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        match crate::tools::provide_web_search_fallback() {
            Ok(disposer) => {
                scope.add(disposer);
                Ok(())
            }
            Err(_occupied) => Ok(()),
        }
    }
}

/// vfs 的低层回调：memory 笔记删除。
struct MemoryVfsPlugin;

impl Plugin for MemoryVfsPlugin {
    fn name(&self) -> &'static str {
        "memory_vfs"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::memory::delete_hook::install_vfs_hooks(scope);
        Ok(())
    }
}

/// mastery（dstu-learning）的画像回流：memory 学习者画像薄弱点 upsert/remove。
struct MemoryMasteryPlugin;

impl Plugin for MemoryMasteryPlugin {
    fn name(&self) -> &'static str {
        "memory_mastery"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::memory::mastery_hook::install_mastery_hooks(scope);
        Ok(())
    }
}

/// vfs 的低层回调：media 转写与资源创建后的自动转写。
struct MediaVfsPlugin;

impl Plugin for MediaVfsPlugin {
    fn name(&self) -> &'static str {
        "media_vfs"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::media::transcriber_hook::install_vfs_hooks(scope);
        Ok(())
    }
}

/// dstu-media 的 app 侧服务解析：原 `try_state::<AppState>()` / `state::<AppState>()`
/// （B 站出口设置读写、导入后自动转写的 ASR 配置探测）。
struct MediaHostPlugin;

impl Plugin for MediaHostPlugin {
    fn name(&self) -> &'static str {
        "media_host"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::media::install_media_host(scope);
        Ok(())
    }
}

/// vfs 的低层回调：qbank 题目集导出。
struct QbankVfsPlugin;

impl Plugin for QbankVfsPlugin {
    fn name(&self) -> &'static str {
        "qbank_vfs"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::question_export_service::vfs_hook::install_vfs_hooks(scope);
        Ok(())
    }
}

/// qbank 命令薄包装与后台任务读取的 AppState 字段（`vfs_db` / `llm_manager`）。
pub(crate) fn qbank_state(state: &crate::commands::AppState) -> dstu_qbank::runtime::QbankState {
    dstu_qbank::runtime::QbankState {
        vfs_db: state.vfs_db.clone(),
        llm_manager: state.llm_manager.clone(),
    }
}

/// qbank 后台任务（练习截止自动交卷、批改队列）只持有 `AppHandle`：
/// 与拆分前的 `app.state::<AppState>()` 相同地取 AppState。
struct QbankAppStateResolver;

impl dstu_qbank::runtime::QbankStateResolver for QbankAppStateResolver {
    fn resolve(&self, app: &tauri::AppHandle) -> dstu_qbank::runtime::QbankState {
        use tauri::Manager;
        let state = app.state::<crate::commands::AppState>();
        qbank_state(&state)
    }
}

/// qbank 的运行期依赖解析（AppState 定义在 app）。
struct QbankRuntimePlugin;

impl Plugin for QbankRuntimePlugin {
    fn name(&self) -> &'static str {
        "qbank_runtime"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        if let Ok(disposer) =
            dstu_qbank::runtime::provide_state_resolver(Arc::new(QbankAppStateResolver))
        {
            scope.add(disposer);
        }
        Ok(())
    }
}

/// 存储层删除 journal 的笔记资产引用检查（vfs 笔记仓储实现）。
struct StorageNotesPlugin;

impl Plugin for StorageNotesPlugin {
    fn name(&self) -> &'static str {
        "storage_notes"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::vfs::repos::note_revision_repo::install_storage_hooks(scope);
        Ok(())
    }
}

/// browser 的低层回调：Agent 会话下载落盘的 artifact 根目录（chat_v2 runtime_roots）。
struct BrowserArtifactRootPlugin;

impl Plugin for BrowserArtifactRootPlugin {
    fn name(&self) -> &'static str {
        "browser_artifact_root"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        let resolver: Arc<dyn crate::browser::hooks::DownloadArtifactRoot> =
            Arc::new(ChatV2DownloadArtifactRoot);
        match crate::browser::hooks::register_download_artifact_root(resolver) {
            Ok(disposer) => {
                scope.add(disposer);
                Ok(())
            }
            Err(_occupied) => Ok(()),
        }
    }
}

/// 与拆分前 `browser::service` 直接调用的 `artifact_root(app, session_id, true)` 相同。
struct ChatV2DownloadArtifactRoot;

impl crate::browser::hooks::DownloadArtifactRoot for ChatV2DownloadArtifactRoot {
    fn artifact_root(
        &self,
        app: &tauri::AppHandle,
        chat_session_id: &str,
    ) -> Result<std::path::PathBuf, String> {
        crate::chat_v2::runtime_roots::artifact_root(app, chat_session_id, true)
            .map(|root| root.path)
    }
}

/// dstu-sync 的低层回调：云配置 hydrate 读取主设置库（app 的 `AppState.database`）。
struct SyncSettingsDatabasePlugin;

impl Plugin for SyncSettingsDatabasePlugin {
    fn name(&self) -> &'static str {
        "sync_settings_database"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        let provider: Arc<dyn dstu_sync::cloud_credentials::SettingsDatabaseProvider> =
            Arc::new(AppStateSettingsDatabase);
        match dstu_sync::cloud_credentials::register_settings_database_provider(provider) {
            Ok(disposer) => {
                scope.add(disposer);
                Ok(())
            }
            Err(_occupied) => Ok(()),
        }
    }
}

/// 与拆分前 `secure_store::hydrate_cloud_config` 直接 `app.try_state::<AppState>()`
/// 后取 `state.database` 相同。
struct AppStateSettingsDatabase;

impl dstu_sync::cloud_credentials::SettingsDatabaseProvider for AppStateSettingsDatabase {
    fn settings_database(&self, app: &tauri::AppHandle) -> Option<Arc<crate::database::Database>> {
        use tauri::Manager;
        app.try_state::<crate::commands::AppState>()
            .map(|state| state.database.clone())
    }
}

/// dstu-sync 同步引擎的字段级合并：`resources.data` 学习者画像（memory 实现）。
struct MemorySyncFieldMergerPlugin;

impl Plugin for MemorySyncFieldMergerPlugin {
    fn name(&self) -> &'static str {
        "memory_sync_field_merger"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        let merger: Arc<dyn dstu_sync::hooks::SyncFieldMerger> =
            Arc::new(MemoryLearnerProfileMerger);
        match dstu_sync::hooks::register_sync_field_merger(merger) {
            Ok(disposer) => {
                scope.add(disposer);
                Ok(())
            }
            Err(_occupied) => Ok(()),
        }
    }
}

/// 与拆分前 `field_merge::merge_learner_profile_data` 直接调用的
/// `memory::learner_profile::merge_profile_json_for_sync` 相同。
struct MemoryLearnerProfileMerger;

impl dstu_sync::hooks::SyncFieldMerger for MemoryLearnerProfileMerger {
    fn merge_profile_json_for_sync(&self, local_json: &str, remote_json: &str) -> Option<String> {
        crate::memory::learner_profile::merge_profile_json_for_sync(local_json, remote_json)
/// chat_v2（agent）对 chatanki 域的回调：会话删除前的僵尸 anki 块回收
/// （`manage_session` 槽位）与紧急停止时取消脱管制卡管线（`kill_switch` 钩子集）。
/// 未注册时两者分别等价于“没有可回收的块”和“没有活跃管线”。
struct ChatAnkiAgentPlugin;

impl Plugin for ChatAnkiAgentPlugin {
    fn name(&self) -> &'static str {
        "chatanki_agent"
    }

    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
        crate::chat_v2::tools::chatanki_executor::install_agent_hooks(scope);
        Ok(())
    }
}

/// 组合根唯一的插件列表（顺序即 apply 顺序）。
fn plugins() -> Vec<Arc<dyn Plugin>> {
    vec![
        Arc::new(WebSearchFallbackPlugin) as Arc<dyn Plugin>,
        Arc::new(MemoryVfsPlugin),
        Arc::new(MemoryMasteryPlugin),
        Arc::new(MediaVfsPlugin),
        Arc::new(MediaHostPlugin),
        Arc::new(QbankVfsPlugin),
        Arc::new(QbankRuntimePlugin),
        Arc::new(StorageNotesPlugin),
        Arc::new(BrowserArtifactRootPlugin),
        Arc::new(SyncSettingsDatabasePlugin),
        Arc::new(MemorySyncFieldMergerPlugin),
        Arc::new(ChatAnkiAgentPlugin),
        // Insight 被动提示（agent 侧 Slot，研究域实现）；缺失时提示为 None。
        Arc::new(crate::agent_wiring::plugins::InsightHintPlugin),
    ]
}

/// 进程级插件宿主：插件不卸载，`Scope` 随进程存活。
static HOST: OnceLock<Mutex<PluginHost>> = OnceLock::new();

/// 注册所有扩展点实现。幂等：同名插件只 apply 一次。
pub fn register_extensions() {
    let host = HOST.get_or_init(|| Mutex::new(PluginHost::new()));
    let mut host = host.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = host.apply_all(plugins()) {
        // 现有插件不会失败；失败时保留已成功的插件，后续调用可重试剩余插件。
        log::error!("[extensions] plugin apply failed: {}", error);
    }
}
