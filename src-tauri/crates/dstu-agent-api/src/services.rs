//! 服务容器：`TypeId` 映射，域 crate 不依赖具体服务类型。
//!
//! 域 crate 自己定义需要的 service 键（newtype，如 `VfsDb`、`AnkiDb`），app 在
//! 组装时 `insert` 同一份 `Arc`。执行器用
//! `ctx.services.require::<VfsDb>()` 取用，不再吃 `AppState`。

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;

use thiserror::Error;

type ServiceMap = HashMap<TypeId, Arc<dyn Any + Send + Sync>>;

/// `Services::require` 未命中时的错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("service `{type_name}` is not registered in Services")]
pub struct ServiceNotFound {
    /// 请求的类型名（`std::any::type_name::<T>()`）。
    pub type_name: &'static str,
}

/// 服务容器。
#[derive(Default)]
pub struct Services {
    map: ServiceMap,
}

impl Services {
    /// 创建空容器。
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// 插入（或替换）一个服务；返回被替换的旧值。
    pub fn insert<T: Send + Sync + 'static>(&mut self, value: Arc<T>) -> Option<Arc<T>> {
        self.map
            .insert(TypeId::of::<T>(), value)
            .and_then(|previous| previous.downcast::<T>().ok())
    }

    /// 取用服务；未注册时返回 `None`。
    pub fn get<T: Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        self.map
            .get(&TypeId::of::<T>())
            .and_then(|value| value.clone().downcast::<T>().ok())
    }

    /// 取用服务；未注册时报 [`ServiceNotFound`]。
    pub fn require<T: Send + Sync + 'static>(&self) -> Result<Arc<T>, ServiceNotFound> {
        self.get::<T>().ok_or(ServiceNotFound {
            type_name: std::any::type_name::<T>(),
        })
    }

    /// 是否注册了类型 `T`。
    pub fn contains<T: Send + Sync + 'static>(&self) -> bool {
        self.map.contains_key(&TypeId::of::<T>())
    }

    /// 已注册的服务数量。
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services")
            .field("len", &self.map.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct DemoDb(u32);

    #[derive(Debug, PartialEq, Eq)]
    struct OtherDb(&'static str);

    #[test]
    fn insert_get_and_require_round_trip() {
        let mut services = Services::new();
        assert!(services.is_empty());
        let replaced = services.insert(Arc::new(DemoDb(7)));
        assert!(replaced.is_none());
        assert_eq!(services.len(), 1);
        assert!(services.contains::<DemoDb>());
        assert_eq!(services.get::<DemoDb>().map(|db| db.0), Some(7));
        assert_eq!(services.require::<DemoDb>().map(|db| db.0), Ok(7));
    }

    #[test]
    fn require_reports_missing_type_name() {
        let services = Services::new();
        let error = services.require::<OtherDb>().unwrap_err();
        assert!(error.type_name.contains("OtherDb"));
        assert!(error.to_string().contains("OtherDb"));
    }

    #[test]
    fn insert_replaces_same_type_without_touching_others() {
        let mut services = Services::new();
        services.insert(Arc::new(DemoDb(1)));
        services.insert(Arc::new(OtherDb("other")));
        let previous = services.insert(Arc::new(DemoDb(2))).expect("replaced");
        assert_eq!(previous.0, 1);
        assert_eq!(services.get::<DemoDb>().map(|db| db.0), Some(2));
        assert_eq!(services.get::<OtherDb>().map(|db| db.0), Some("other"));
        assert_eq!(services.len(), 2);
    }
}
