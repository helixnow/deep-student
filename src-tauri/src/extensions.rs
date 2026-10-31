//! 扩展点注册：低层模块对上层能力的回调统一在这里接线。
//!
//! 低层（llm_manager、vfs 等）不能直接依赖上层模块，只定义注册接口；上层实现在这里
//! 注册进去。`run()` 第一行调用 `register_extensions()`，保证任何业务代码执行前
//! 回调都已就位，与拆分前直接调用的行为一致。单元测试若走到这些回调，也在开头调用它。

use std::sync::Once;

static REGISTER: Once = Once::new();

/// 注册所有扩展点实现。幂等：多次调用只生效一次。
pub fn register_extensions() {
    REGISTER.call_once(|| {
        // llm_manager 的 legacy 回退注入（模型不支持工具调用）使用的 web_search。
        crate::tools::install_web_search_fallback();
        // vfs 的低层回调：memory 笔记删除、media 转写/资源创建、qbank 题目集导出。
        crate::memory::delete_hook::install_vfs_hooks();
        crate::media::transcriber_hook::install_vfs_hooks();
        crate::question_export_service::vfs_hook::install_vfs_hooks();
        // 存储层删除 journal 的笔记资产引用检查（vfs 笔记仓储实现）。
        crate::vfs::repos::note_revision_repo::install_storage_hooks();
    });
}
