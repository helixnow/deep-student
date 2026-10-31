//! Unit Builder 注册表

use super::builders::*;
use super::trait_def::{UnitBuildInput, UnitBuildOutput, UnitBuilder};
use std::collections::HashMap;
use std::sync::Arc;

/// Unit Builder 注册表
///
/// 管理所有资源类型对应的 Builder
pub struct UnitBuilderRegistry {
    builders: HashMap<String, Arc<dyn UnitBuilder>>,
}

impl UnitBuilderRegistry {
    /// 创建新的注册表并注册所有 Builder
    pub fn new() -> Self {
        let mut registry = Self {
            builders: HashMap::new(),
        };

        // 注册所有 Builder
        registry.register(Arc::new(NoteBuilder));
        registry.register(Arc::new(TextbookBuilder));
        registry.register(Arc::new(ImageBuilder));
        registry.register(Arc::new(ExamBuilder));
        registry.register(Arc::new(TranslationBuilder));
        registry.register(Arc::new(EssayBuilder));
        registry.register(Arc::new(MindmapBuilder));
        registry.register(Arc::new(FileBuilder));
        registry.register(Arc::new(AttachmentBuilder));

        registry
    }

    /// 注册 Builder
    pub fn register(&mut self, builder: Arc<dyn UnitBuilder>) {
        self.builders
            .insert(builder.resource_type().to_string(), builder);
    }

    /// 获取指定类型的 Builder
    pub fn get(&self, resource_type: &str) -> Option<Arc<dyn UnitBuilder>> {
        self.builders.get(resource_type).cloned()
    }

    /// 构建 Units
    pub fn build(&self, input: &UnitBuildInput) -> Option<UnitBuildOutput> {
        self.get(&input.resource_type).map(|b| b.build(input))
    }

    /// 列出所有支持的资源类型
    pub fn supported_types(&self) -> Vec<&str> {
        self.builders.keys().map(|s| s.as_str()).collect()
    }
}

impl Default for UnitBuilderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_creation() {
        let registry = UnitBuilderRegistry::new();
        assert!(registry.get("note").is_some());
        assert!(registry.get("textbook").is_some());
        assert!(registry.get("image").is_some());
        assert!(registry.get("unknown").is_none());
    }
}
