use std::path::Path;
use crate::cogni_graph::WorkflowLogger;

#[tokio::test]
async fn test_workflow_logger() {
    let temp_dir = std::env::temp_dir();
    let session_id = "test_session_123".to_string();
    
    let mut logger = WorkflowLogger::new(session_id.clone(), &temp_dir).unwrap();
    
    // 测试基础日志记录
    logger.log_info("TEST_STEP", "测试日志记录功能", None);
    logger.log_warning("TEST_STEP", "这是一个警告", None);
    logger.log_error("TEST_STEP", "这是一个错误", None);
    
    // 测试带数据的日志记录
    let test_data = serde_json::json!({
        "test_key": "test_value",
        "number": 42
    });
    logger.log_debug("TEST_STEP", "测试带数据的日志", Some(test_data));
    
    // 测试步骤日志
    logger.log_step_start("STEP1", "开始测试步骤");
    logger.log_step_complete("STEP1", true, "测试步骤完成", None);
    
    // 测试LLM调用日志
    logger.log_llm_call("STEP2", "gpt-4", "这是一个测试prompt", Some("这是LLM的响应"));
    
    // 测试向量操作日志
    logger.log_vector_operation("STEP3", "embedding_generation", 100, Some(500));
    
    // 保存日志文件
    logger.save_to_file().unwrap();
    
    // 验证日志文件是否存在
    assert!(logger.get_log_file_path().exists());
    
    println!("测试完成，日志文件保存到: {:?}", logger.get_log_file_path());
}