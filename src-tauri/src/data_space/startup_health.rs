//! 受治理数据库与审计子系统的启动健康状态（迁移协调器写入，恢复报告/状态命令读取）。
//!
//! 从 `data_governance` 下沉到存储层；`data_governance` 按原路径重导出。

/// Stable startup status for a governed component.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupComponentStatus {
    Healthy,
    Degraded,
    Blocked,
}

/// Startup health entry for one stable governed component.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StartupComponentIssue {
    pub component: String,
    pub status: StartupComponentStatus,
    pub reason: Option<String>,
    /// The failed direct dependency when this component was skipped.
    pub dependency: Option<String>,
}

/// Complete startup health for the governed databases and audit subsystem.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StartupComponentHealth {
    pub components: Vec<StartupComponentIssue>,
}

impl Default for StartupComponentHealth {
    fn default() -> Self {
        Self {
            components: ["vfs", "mistakes", "chat_v2", "llm_usage", "audit"]
                .into_iter()
                .map(|component| StartupComponentIssue {
                    component: component.to_string(),
                    status: StartupComponentStatus::Healthy,
                    reason: None,
                    dependency: None,
                })
                .collect(),
        }
    }
}

impl StartupComponentHealth {
    pub fn is_blocked(&self, component: &str) -> bool {
        self.components.iter().any(|entry| {
            entry.component == component && entry.status == StartupComponentStatus::Blocked
        })
    }

    pub fn blocked_components(&self) -> Vec<String> {
        self.components
            .iter()
            .filter(|entry| entry.status == StartupComponentStatus::Blocked)
            .map(|entry| entry.component.clone())
            .collect()
    }

    pub fn requires_core_recovery(&self) -> bool {
        self.is_blocked("vfs") || self.is_blocked("mistakes")
    }

    pub fn issues(&self) -> Vec<StartupComponentIssue> {
        self.components
            .iter()
            .filter(|entry| entry.status != StartupComponentStatus::Healthy)
            .cloned()
            .collect()
    }

    pub(crate) fn mark_degraded(&mut self, component: &str, reason: impl Into<String>) {
        self.set(
            component,
            StartupComponentStatus::Degraded,
            reason.into(),
            None,
        );
    }

    pub(crate) fn mark_blocked(&mut self, component: &str, reason: impl Into<String>) {
        self.set(
            component,
            StartupComponentStatus::Blocked,
            reason.into(),
            None,
        );
    }

    pub(crate) fn mark_dependency_blocked(
        &mut self,
        component: &str,
        dependency: &str,
        reason: impl Into<String>,
    ) {
        self.set(
            component,
            StartupComponentStatus::Blocked,
            reason.into(),
            Some(dependency.to_string()),
        );
    }

    pub(crate) fn apply_database_dependency_closure(&mut self) {
        if !self.is_blocked("vfs") {
            return;
        }
        for dependent in ["chat_v2", "mistakes"] {
            let is_healthy = self.components.iter().any(|entry| {
                entry.component == dependent && entry.status == StartupComponentStatus::Healthy
            });
            if is_healthy {
                self.mark_dependency_blocked(
                    dependent,
                    "vfs",
                    "Skipped because dependency 'vfs' is blocked",
                );
            }
        }
    }

    fn set(
        &mut self,
        component: &str,
        status: StartupComponentStatus,
        reason: String,
        dependency: Option<String>,
    ) {
        if let Some(entry) = self
            .components
            .iter_mut()
            .find(|entry| entry.component == component)
        {
            entry.status = status;
            entry.reason = Some(reason);
            entry.dependency = dependency;
        }
    }
}

/// Clonable Tauri state holder for startup component health.
#[derive(Clone, Default)]
pub struct StartupComponentHealthState {
    inner: std::sync::Arc<std::sync::RwLock<StartupComponentHealth>>,
}

impl StartupComponentHealthState {
    pub fn new(health: StartupComponentHealth) -> Self {
        Self {
            inner: std::sync::Arc::new(std::sync::RwLock::new(health)),
        }
    }

    pub fn snapshot(&self) -> StartupComponentHealth {
        match self.inner.read() {
            Ok(health) => health.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn replace(&self, health: StartupComponentHealth) {
        match self.inner.write() {
            Ok(mut current) => *current = health,
            Err(poisoned) => *poisoned.into_inner() = health,
        }
    }
}
