//! 工具注册表构建器：启动时把各 provider 的声明合并成一张显式注册表。
//!
//! build 时校验（任何一条违反都会返回 [`ToolRegistryError`]）：
//! 1. provider id 唯一，且至少注册一个 provider；
//! 2. 每个 descriptor 的 name 与 alias 非空，且跨 provider 不重复（含 name↔alias）；
//! 3. 每个声明的 name/alias 都能通过 `provider.executor(name)` 找到实现；
//! 4. 该实现必须出现在同一 provider 的 `executors()` 花名册里；
//! 5. 非 catch-all provider 的每个花名册 executor 都必须被自己的 descriptor 认领；
//! 6. catch-all provider 至多一个，且必须最后注册。
//!
//! 通过后产出与「provider 注册顺序 + provider 内花名册顺序」一致的有序
//! `Vec<Arc<dyn ToolExecutor>>`，供花名册/顺序快照测试使用。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use thiserror::Error;

use crate::descriptor::ToolDescriptor;
use crate::executor::ToolExecutor;
use crate::provider::{ProviderId, ToolProvider};

/// 注册表构建/校验错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ToolRegistryError {
    /// 没有注册任何 provider。
    #[error("tool registry requires at least one provider")]
    EmptyRegistry,

    /// 同一个 provider id 被注册两次。
    #[error("provider id `{provider}` is registered twice")]
    DuplicateProviderId {
        /// 重复的 provider id。
        provider: String,
    },

    /// provider 声明了空工具名。
    #[error("provider `{provider}` declares an empty tool name")]
    EmptyToolName {
        /// 出错的 provider。
        provider: String,
    },

    /// 工具名/别名在两个 provider 之间冲突。
    #[error("tool name `{name}` is declared by both `{first}` and `{second}`")]
    DuplicateToolName {
        /// 冲突的名字。
        name: String,
        /// 先声明的 provider。
        first: String,
        /// 后声明的 provider。
        second: String,
    },

    /// descriptor 声明了名字，但 provider 找不到 executor。
    #[error("provider `{provider}` declares `{name}` but returns no executor for it")]
    MissingExecutor {
        /// 出错的 provider。
        provider: String,
        /// 缺少实现的工具名。
        name: String,
    },

    /// `executor(name)` 返回的实现不在 `executors()` 花名册里。
    #[error(
        "provider `{provider}` returns an executor for `{name}` that is missing from executors()"
    )]
    ExecutorNotInRoster {
        /// 出错的 provider。
        provider: String,
        /// 触发查询的工具名。
        name: String,
    },

    /// 非 catch-all provider 的花名册里有 descriptor 未认领的 executor。
    #[error("provider `{provider}` returns an executor that none of its descriptors declare")]
    UndeclaredExecutor {
        /// 出错的 provider。
        provider: String,
    },

    /// 多个 provider 声明 catch-all。
    #[error("only one catch-all provider is allowed; `{first}` and `{second}` both claim it")]
    MultipleCatchAllProviders {
        /// 先注册的 catch-all provider。
        first: String,
        /// 后注册的 catch-all provider。
        second: String,
    },

    /// catch-all provider 之后还有 provider。
    #[error("catch-all provider `{provider}` must be registered last (found `{after}` after it)")]
    CatchAllNotLast {
        /// catch-all provider。
        provider: String,
        /// 排在它后面的 provider。
        after: String,
    },
}

/// descriptor 索引（name/alias -> descriptor）。
#[derive(Debug, Default, Clone)]
pub struct DescriptorTable {
    entries: HashMap<String, ToolDescriptor>,
}

impl DescriptorTable {
    /// 按名字/别名查询。
    pub fn get(&self, name: &str) -> Option<&ToolDescriptor> {
        self.entries.get(name)
    }

    /// 是否包含该名字/别名。
    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(name)
    }

    /// 条目数（含别名）。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 遍历所有名字/别名。
    pub fn iter(&self) -> impl Iterator<Item = (&String, &ToolDescriptor)> {
        self.entries.iter()
    }
}

/// 构建完成、已校验的工具注册表。
pub struct ToolRegistry {
    providers: Vec<Arc<dyn ToolProvider>>,
    executors: Vec<Arc<dyn ToolExecutor>>,
    executors_by_name: HashMap<String, Arc<dyn ToolExecutor>>,
    owners: HashMap<String, ProviderId>,
    descriptors: DescriptorTable,
    catch_all: Option<usize>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("providers", &self.providers.len())
            .field("executors", &self.executors.len())
            .field("descriptors", &self.descriptors.len())
            .field("catch_all", &self.catch_all.is_some())
            .finish()
    }
}

impl ToolRegistry {
    /// 按名字/别名解析 executor；未声明时交给 catch-all provider。
    pub fn executor_for(&self, tool_name: &str) -> Option<Arc<dyn ToolExecutor>> {
        if let Some(executor) = self.executors_by_name.get(tool_name) {
            return Some(executor.clone());
        }
        self.catch_all
            .and_then(|index| self.providers[index].executor(tool_name))
    }

    /// 按名字/别名查询 descriptor（catch-all 动态名字没有 descriptor）。
    pub fn descriptor(&self, tool_name: &str) -> Option<&ToolDescriptor> {
        self.descriptors.get(tool_name)
    }

    /// descriptor 索引。
    pub fn descriptor_table(&self) -> &DescriptorTable {
        &self.descriptors
    }

    /// 声明该名字的 provider。
    pub fn owner_of(&self, tool_name: &str) -> Option<ProviderId> {
        self.owners.get(tool_name).copied()
    }

    /// 有序 executor 花名册（provider 注册顺序 + provider 内顺序）。
    pub fn executors(&self) -> &[Arc<dyn ToolExecutor>] {
        &self.executors
    }

    /// 注册的 provider（注册顺序）。
    pub fn providers(&self) -> &[Arc<dyn ToolProvider>] {
        &self.providers
    }

    /// catch-all provider（若存在）。
    pub fn catch_all_provider(&self) -> Option<&Arc<dyn ToolProvider>> {
        self.catch_all.map(|index| &self.providers[index])
    }

    /// 声明的名字/别名数量。
    pub fn len(&self) -> usize {
        self.descriptors.len()
    }

    /// 是否没有任何声明。
    pub fn is_empty(&self) -> bool {
        self.descriptors.is_empty()
    }
}

/// 注册表构建器。
#[derive(Default)]
pub struct ToolRegistryBuilder {
    providers: Vec<Arc<dyn ToolProvider>>,
}

impl ToolRegistryBuilder {
    /// 创建空构建器。
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
        }
    }

    /// 按注册顺序追加一个 provider。
    pub fn register(&mut self, provider: Arc<dyn ToolProvider>) -> &mut Self {
        self.providers.push(provider);
        self
    }

    /// 链式注册。
    pub fn with_provider(mut self, provider: Arc<dyn ToolProvider>) -> Self {
        self.providers.push(provider);
        self
    }

    /// 校验并构建注册表。
    pub fn build(self) -> Result<ToolRegistry, ToolRegistryError> {
        if self.providers.is_empty() {
            return Err(ToolRegistryError::EmptyRegistry);
        }

        // catch-all 约束先全局检查，保证「重复」与「不在最后」都能被稳定命中。
        let catch_all_indices: Vec<usize> = self
            .providers
            .iter()
            .enumerate()
            .filter(|(_, provider)| provider.is_catch_all())
            .map(|(index, _)| index)
            .collect();
        if catch_all_indices.len() > 1 {
            return Err(ToolRegistryError::MultipleCatchAllProviders {
                first: self.providers[catch_all_indices[0]].id().as_str().to_string(),
                second: self.providers[catch_all_indices[1]].id().as_str().to_string(),
            });
        }
        if let Some(&index) = catch_all_indices.first() {
            if index + 1 != self.providers.len() {
                return Err(ToolRegistryError::CatchAllNotLast {
                    provider: self.providers[index].id().as_str().to_string(),
                    after: self.providers[index + 1].id().as_str().to_string(),
                });
            }
        }
        let catch_all = catch_all_indices.first().copied();

        let mut seen_provider_ids: HashSet<String> = HashSet::new();
        let mut name_owner: HashMap<String, String> = HashMap::new();
        let mut executors_by_name: HashMap<String, Arc<dyn ToolExecutor>> = HashMap::new();
        let mut owners: HashMap<String, ProviderId> = HashMap::new();
        let mut descriptors = DescriptorTable::default();
        let mut executors: Vec<Arc<dyn ToolExecutor>> = Vec::new();

        for provider in self.providers.iter() {
            let provider_id = provider.id();
            let provider_name = provider_id.as_str().to_string();
            if !seen_provider_ids.insert(provider_name.clone()) {
                return Err(ToolRegistryError::DuplicateProviderId {
                    provider: provider_name,
                });
            }

            let mut claimed: Vec<(String, Arc<dyn ToolExecutor>)> = Vec::new();
            for descriptor in provider.descriptors() {
                for name in descriptor.names() {
                    if name.trim().is_empty() {
                        return Err(ToolRegistryError::EmptyToolName {
                            provider: provider_name,
                        });
                    }
                    if let Some(first) = name_owner.get(name) {
                        return Err(ToolRegistryError::DuplicateToolName {
                            name: name.to_string(),
                            first: first.clone(),
                            second: provider_name,
                        });
                    }
                    let executor =
                        provider
                            .executor(name)
                            .ok_or_else(|| ToolRegistryError::MissingExecutor {
                                provider: provider_name.clone(),
                                name: name.to_string(),
                            })?;
                    name_owner.insert(name.to_string(), provider_name.clone());
                    owners.insert(name.to_string(), provider_id);
                    descriptors
                        .entries
                        .insert(name.to_string(), descriptor);
                    executors_by_name.insert(name.to_string(), executor.clone());
                    claimed.push((name.to_string(), executor));
                }
            }

            let roster = provider.executors();
            for (name, executor) in &claimed {
                if !roster
                    .iter()
                    .any(|candidate| Arc::ptr_eq(candidate, executor))
                {
                    return Err(ToolRegistryError::ExecutorNotInRoster {
                        provider: provider_name,
                        name: name.clone(),
                    });
                }
            }

            if !provider.is_catch_all() {
                for roster_executor in &roster {
                    if !claimed
                        .iter()
                        .any(|(_, executor)| Arc::ptr_eq(executor, roster_executor))
                    {
                        return Err(ToolRegistryError::UndeclaredExecutor {
                            provider: provider_name,
                        });
                    }
                }
            }

            for executor in roster {
                if !executors
                    .iter()
                    .any(|existing| Arc::ptr_eq(existing, &executor))
                {
                    executors.push(executor);
                }
            }
        }

        Ok(ToolRegistry {
            providers: self.providers,
            executors,
            executors_by_name,
            owners,
            descriptors,
            catch_all,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::ToolDescriptor;
    use crate::executor::ToolFuture;
    use crate::provider::ProviderId;
    use dstu_core::agent::ToolCall;

    struct MockExecutor {
        name: &'static str,
    }

    impl MockExecutor {
        fn new(name: &'static str) -> Arc<dyn ToolExecutor> {
            Arc::new(Self { name })
        }
    }

    impl ToolExecutor for MockExecutor {
        fn can_handle(&self, tool_name: &str) -> bool {
            tool_name == self.name
        }

        fn execute<'a>(
            &'a self,
            _call: &'a ToolCall,
            _ctx: &'a crate::context::ExecutionContext,
        ) -> ToolFuture<'a> {
            Box::pin(async { unimplemented!("mock executor does not execute") })
        }
    }

    struct MockProvider {
        id: ProviderId,
        descriptors: Vec<ToolDescriptor>,
        routes: Vec<(&'static str, Arc<dyn ToolExecutor>)>,
        roster: Vec<Arc<dyn ToolExecutor>>,
        catch_all: bool,
    }

    impl MockProvider {
        fn new(
            id: &'static str,
            descriptors: Vec<ToolDescriptor>,
            routes: Vec<(&'static str, Arc<dyn ToolExecutor>)>,
            roster: Vec<Arc<dyn ToolExecutor>>,
            catch_all: bool,
        ) -> Arc<dyn ToolProvider> {
            Arc::new(Self {
                id: ProviderId::new(id),
                descriptors,
                routes,
                roster,
                catch_all,
            })
        }

        /// 每个名字都路由到同一个 executor，roster 也只含它。
        fn simple(
            id: &'static str,
            descriptors: Vec<ToolDescriptor>,
            executor: Arc<dyn ToolExecutor>,
        ) -> Arc<dyn ToolProvider> {
            let routes = descriptors
                .iter()
                .flat_map(|descriptor| descriptor.names())
                .map(|name| (name, executor.clone()))
                .collect();
            Self::new(id, descriptors, routes, vec![executor], false)
        }
    }

    impl ToolProvider for MockProvider {
        fn id(&self) -> ProviderId {
            self.id
        }

        fn descriptors(&self) -> Vec<ToolDescriptor> {
            self.descriptors.clone()
        }

        fn executor(&self, tool_name: &str) -> Option<Arc<dyn ToolExecutor>> {
            if let Some((_, executor)) = self
                .routes
                .iter()
                .find(|(name, _)| *name == tool_name)
            {
                return Some(executor.clone());
            }
            if self.catch_all {
                return self.roster.first().cloned();
            }
            None
        }

        fn executors(&self) -> Vec<Arc<dyn ToolExecutor>> {
            self.roster.clone()
        }

        fn is_catch_all(&self) -> bool {
            self.catch_all
        }
    }

    #[test]
    fn duplicate_tool_name_across_providers_fails_with_conflict() {
        let shared = MockExecutor::new("shared_tool");
        let first = MockProvider::simple(
            "first",
            vec![ToolDescriptor::new("shared_tool")],
            shared.clone(),
        );
        let second = MockProvider::simple(
            "second",
            vec![ToolDescriptor::new("shared_tool")],
            shared.clone(),
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(first)
            .with_provider(second)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::DuplicateToolName {
                name: "shared_tool".to_string(),
                first: "first".to_string(),
                second: "second".to_string(),
            }
        );
        assert!(error.to_string().contains("shared_tool"));
    }

    #[test]
    fn duplicate_alias_across_providers_fails_with_conflict() {
        let first = MockProvider::simple(
            "first",
            vec![ToolDescriptor::new("note_read").with_aliases(&["builtin-note_read"])],
            MockExecutor::new("note_read"),
        );
        let second = MockProvider::simple(
            "second",
            vec![ToolDescriptor::new("other_tool").with_aliases(&["builtin-note_read"])],
            MockExecutor::new("other_tool"),
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(first)
            .with_provider(second)
            .build()
            .unwrap_err();

        assert!(matches!(
            error,
            ToolRegistryError::DuplicateToolName { ref name, .. } if name == "builtin-note_read"
        ));
    }

    #[test]
    fn descriptor_without_executor_fails() {
        let provider = MockProvider::new(
            "broken",
            vec![ToolDescriptor::new("missing_tool")],
            Vec::new(),
            vec![MockExecutor::new("missing_tool")],
            false,
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(provider)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::MissingExecutor {
                provider: "broken".to_string(),
                name: "missing_tool".to_string(),
            }
        );
    }

    #[test]
    fn executor_missing_from_roster_fails() {
        let noted = MockExecutor::new("noted_tool");
        let provider = MockProvider::new(
            "drifting",
            vec![ToolDescriptor::new("noted_tool")],
            vec![("noted_tool", noted.clone())],
            vec![MockExecutor::new("something_else")],
            false,
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(provider)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::ExecutorNotInRoster {
                provider: "drifting".to_string(),
                name: "noted_tool".to_string(),
            }
        );
    }

    #[test]
    fn undeclared_executor_in_non_catch_all_provider_fails() {
        let noted = MockExecutor::new("noted_tool");
        let rogue = MockExecutor::new("rogue_tool");
        let provider = MockProvider::new(
            "overreaching",
            vec![ToolDescriptor::new("noted_tool")],
            vec![("noted_tool", noted.clone())],
            vec![noted, rogue],
            false,
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(provider)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::UndeclaredExecutor {
                provider: "overreaching".to_string(),
            }
        );
    }

    #[test]
    fn duplicate_catch_all_provider_fails() {
        let general = MockExecutor::new("general");
        let first = MockProvider::new(
            "general_first",
            vec![ToolDescriptor::new("general")],
            vec![("general", general.clone())],
            vec![general.clone()],
            true,
        );
        let second = MockProvider::new(
            "general_second",
            Vec::new(),
            Vec::new(),
            vec![general],
            true,
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(first)
            .with_provider(second)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::MultipleCatchAllProviders {
                first: "general_first".to_string(),
                second: "general_second".to_string(),
            }
        );
    }

    #[test]
    fn catch_all_provider_must_be_last() {
        let general = MockExecutor::new("general");
        let catch_all = MockProvider::new(
            "general",
            Vec::new(),
            Vec::new(),
            vec![general],
            true,
        );
        let later = MockProvider::simple(
            "later",
            vec![ToolDescriptor::new("later_tool")],
            MockExecutor::new("later_tool"),
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(catch_all)
            .with_provider(later)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::CatchAllNotLast {
                provider: "general".to_string(),
                after: "later".to_string(),
            }
        );
    }

    #[test]
    fn provider_order_and_roster_order_are_preserved() {
        let meta = MockExecutor::new("meta_tool");
        let alpha = MockExecutor::new("alpha_tool");

        let first = MockProvider::simple(
            "first",
            vec![ToolDescriptor::new("meta_tool")],
            meta.clone(),
        );
        let second = MockProvider::simple(
            "second",
            vec![
                ToolDescriptor::new("alpha_tool"),
                ToolDescriptor::new("beta_tool"),
            ],
            alpha.clone(),
        );

        let registry = ToolRegistryBuilder::new()
            .with_provider(first)
            .with_provider(second)
            .build()
            .expect("registry");

        assert_eq!(registry.executors().len(), 2);
        assert!(Arc::ptr_eq(&registry.executors()[0], &meta));
        assert!(Arc::ptr_eq(&registry.executors()[1], &alpha));
        assert_eq!(registry.providers().len(), 2);
        assert_eq!(registry.providers()[0].id().as_str(), "first");
        assert_eq!(registry.providers()[1].id().as_str(), "second");

        assert_eq!(registry.owner_of("meta_tool"), Some(ProviderId::new("first")));
        assert_eq!(
            registry.owner_of("alpha_tool"),
            Some(ProviderId::new("second"))
        );
        assert_eq!(registry.len(), 3);
    }

    #[test]
    fn registry_resolves_names_aliases_and_catch_all() {
        let note = MockExecutor::new("note_read");
        let general = MockExecutor::new("general");

        let notes = MockProvider::simple(
            "notes",
            vec![ToolDescriptor::new("note_read").with_aliases(&["builtin-note_read"])],
            note.clone(),
        );
        let general_provider = MockProvider::new(
            "general",
            Vec::new(),
            Vec::new(),
            vec![general.clone()],
            true,
        );

        let registry = ToolRegistryBuilder::new()
            .with_provider(notes)
            .with_provider(general_provider)
            .build()
            .expect("registry");

        let by_name = registry.executor_for("note_read").expect("name");
        let by_alias = registry.executor_for("builtin-note_read").expect("alias");
        assert!(Arc::ptr_eq(&by_name, &note));
        assert!(Arc::ptr_eq(&by_alias, &note));
        assert_eq!(
            registry
                .descriptor("builtin-note_read")
                .map(|descriptor| descriptor.name),
            Some("note_read")
        );

        let dynamic = registry.executor_for("mcp_unknown_tool").expect("catch-all");
        assert!(Arc::ptr_eq(&dynamic, &general));
        assert!(registry.descriptor("mcp_unknown_tool").is_none());
        assert!(registry.catch_all_provider().is_some());
        assert!(registry.owner_of("mcp_unknown_tool").is_none());
    }

    #[test]
    fn duplicate_provider_id_fails() {
        let first = MockProvider::simple(
            "same_id",
            vec![ToolDescriptor::new("a_tool")],
            MockExecutor::new("a_tool"),
        );
        let second = MockProvider::simple(
            "same_id",
            vec![ToolDescriptor::new("b_tool")],
            MockExecutor::new("b_tool"),
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(first)
            .with_provider(second)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::DuplicateProviderId {
                provider: "same_id".to_string(),
            }
        );
    }

    #[test]
    fn empty_registry_fails() {
        let error = ToolRegistryBuilder::new().build().unwrap_err();
        assert_eq!(error, ToolRegistryError::EmptyRegistry);
    }

    #[test]
    fn empty_descriptor_name_fails() {
        let provider = MockProvider::new(
            "empty",
            vec![ToolDescriptor::new("  ")],
            vec![("  ", MockExecutor::new("  "))],
            vec![MockExecutor::new("  ")],
            false,
        );

        let error = ToolRegistryBuilder::new()
            .with_provider(provider)
            .build()
            .unwrap_err();

        assert_eq!(
            error,
            ToolRegistryError::EmptyToolName {
                provider: "empty".to_string(),
            }
        );
    }

    #[test]
    fn builder_does_not_require_concrete_executors() {
        // mock provider/executor 已证明 builder 只依赖 trait 对象。
        let executor: Arc<dyn ToolExecutor> = MockExecutor::new("demo_tool");
        let provider: Arc<dyn ToolProvider> = MockProvider::simple(
            "demo",
            vec![ToolDescriptor::new("demo_tool")],
            executor.clone(),
        );
        let mut builder = ToolRegistryBuilder::new();
        builder.register(provider);
        let registry = builder.build().expect("registry");
        assert!(Arc::ptr_eq(
            &registry.executor_for("demo_tool").expect("resolved"),
            &executor
        ));
    }
}
