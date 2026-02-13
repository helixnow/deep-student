// 测试向量搜索功能
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🔍 测试向量搜索功能...");
    
    // 1. 创建测试数据库
    let db_path = "./test_vector_search.db";
    let db_manager = Arc::new(DatabaseManager::new(db_path).await?);
    let llm_manager = Arc::new(LLMManager::new().await?);
    
    // 2. 创建SQLite适配器
    let adapter = SQLiteDatabaseAdapter::new(db_path).await?;
    
    // 3. 创建一些测试卡片
    println!("📝 创建测试卡片...");
    for i in 0..10 {
        let card = ProblemCard {
            id: format!("test_card_{}", i),
            content_problem: format!("测试问题 {}", i),
            content_insight: format!("测试见解 {}", i),
            notes: None,
            status: "active".to_string(),
            item_type: KnowledgeItemType::Card,
            origin: Some("vector_search_test".to_string()),
            user_edited: false,
            embedding: Some(vec![0.1 * i as f32; 1024]), // 简单的测试向量
            subject: None,
            created_at: chrono::Utc::now(),
            last_accessed_at: chrono::Utc::now(),
            access_count: 0,
            source_excalidraw_path: None,
            images: None,
            mistake_id: None,
            mistake_status: 0,
            original_image_path: None,
        };
        
        adapter.create_problem_card(&card, vec![]).await?;
        
        // 存储向量到kg_card_embeddings表
        if let Some(embedding) = &card.embedding {
            adapter.store_card_embedding(&card.id, embedding).await?;
        }
    }
    
    // 4. 测试向量搜索
    println!("\n🎯 测试向量搜索...");
    let query_embedding = vec![0.5f32; 1024];
    let results = adapter.vector_search(&query_embedding, 5).await?;
    
    println!("✅ 搜索结果：");
    for (i, result) in results.iter().enumerate() {
        println!("  {}. {} - 分数: {:.4}", i + 1, result.card.id, result.score);
    }
    
    // 5. 验证HNSW索引是否工作
    if results.is_empty() {
        println!("❌ 向量搜索失败：没有返回结果");
    } else if results[0].matched_by.contains(&"vector_hnsw".to_string()) {
        println!("✅ HNSW索引正常工作！");
    } else {
        println!("⚠️ 使用了回退搜索方案");
    }
    
    // 清理
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_dir_all("./indexes");
    
    Ok(())
}