//! 只读 executor 的 `concurrency_class` 覆写声明测试（step 10 §3.3）。
//!
//! 从 `chat_v2::pipeline::parallel_exec_tests` 原样搬来（函数名不变）：用例同时
//! 覆盖 app 域执行器（retrieval / academic / resource / memory），chat_v2 搬入
//! dstu-agent 后只能在 app 侧组装。

#[test]
fn read_only_executors_declare_read_only_class() {
    use crate::chat_v2::tools::executor::{ToolConcurrency, ToolExecutor};
    use crate::chat_v2::tools::{
        AcademicSearchExecutor, BuiltinResourceExecutor, BuiltinRetrievalExecutor, FetchExecutor,
        MemoryToolExecutor, SkillsExecutor,
    };

    // 全只读 executor
    let retrieval = BuiltinRetrievalExecutor::new();
    assert_eq!(
        retrieval.concurrency_class("builtin-rag_search"),
        ToolConcurrency::ReadOnly
    );
    let fetch = FetchExecutor::new();
    assert_eq!(
        fetch.concurrency_class("builtin-web_fetch"),
        ToolConcurrency::ReadOnly
    );
    let academic = AcademicSearchExecutor::new();
    assert_eq!(
        academic.concurrency_class("builtin-arxiv_search"),
        ToolConcurrency::ReadOnly
    );

    // 混合读写 executor：按工具名细分
    let resource = BuiltinResourceExecutor::new();
    assert_eq!(
        resource.concurrency_class("builtin-resource_read"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        resource.concurrency_class("builtin-folder_list"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        resource.concurrency_class("builtin-mindmap_create"),
        ToolConcurrency::Serial
    );
    let memory = MemoryToolExecutor::new();
    assert_eq!(
        memory.concurrency_class("builtin-memory_search"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_read"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_write"),
        ToolConcurrency::Serial
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_delete"),
        ToolConcurrency::Serial
    );

    // 未覆写的 executor 沿用默认 Serial（load_skills 会改会话技能状态，非只读）
    let skills = SkillsExecutor::new();
    assert_eq!(
        skills.concurrency_class("builtin-load_skills"),
        ToolConcurrency::Serial
    );
}
