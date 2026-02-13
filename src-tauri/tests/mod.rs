//! 测试模块入口
//!
//! 这个文件确保所有测试模块被包含在编译中

mod error_details_tests;
mod secure_store_tests;
mod tools_integration_tests;

// 运行所有测试的集成测试
#[cfg(test)]
mod integration {

    #[tokio::test]
    async fn run_all_core_tests() {
        // 这个测试作为整体测试套件的入口点
        // 验证所有主要模块都能正常工作

        // 测试错误详情系统
        use deep_student_lib::error_details::{ErrorCode, ErrorDetailsBuilder};
        let error = ErrorDetailsBuilder::api_key_missing("Test");
        assert_eq!(error.code, ErrorCode::ApiKeyMissing);

        // 测试工具注册表
        use deep_student_lib::tools::WebSearchTool;
        use deep_student_lib::tools::{Tool, ToolRegistry};
        use std::sync::Arc;

        let registry = ToolRegistry::new_with(vec![Arc::new(WebSearchTool) as Arc<dyn Tool>]);
        // 仅验证创建成功
        let _ = registry;

        println!("✅ All core systems initialized successfully");
    }
}
