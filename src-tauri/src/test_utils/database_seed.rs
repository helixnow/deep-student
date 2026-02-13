/// 测试数据库播种工具
/// 用于创建固定的测试数据，确保测试环境的可重复性
use crate::database::Database;
use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

/// 种子数据配置
pub struct SeedConfig {
    /// 是否创建基础错题数据
    pub create_basic_mistakes: bool,
    /// 是否创建带聊天历史的错题
    pub create_mistakes_with_chat: bool,
    /// 是否创建带附件的错题
    pub create_mistakes_with_attachments: bool,
    /// 是否创建多样化测试错题
    pub create_diverse_mistakes: bool,
}

impl Default for SeedConfig {
    fn default() -> Self {
        Self {
            create_basic_mistakes: true,
            create_mistakes_with_chat: true,
            create_mistakes_with_attachments: true,
            create_diverse_mistakes: true,
        }
    }
}

/// 播种测试数据库
pub fn seed_test_database(_db: &Database, _config: SeedConfig) -> Result<SeedResult> {
    // 错题模块已废弃，播种操作不再执行
    Ok(SeedResult {
        mistakes_created: 0,
        messages_created: 0,
        errors: Vec::new(),
    })
}

/// 播种结果
#[derive(Debug, Clone)]
pub struct SeedResult {
    pub mistakes_created: usize,
    pub messages_created: usize,
    pub errors: Vec<String>,
}
