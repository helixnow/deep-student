// 协议版本管理和协商
use log::{info, warn};
use serde_json::Value;

/// 支持的MCP协议版本
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProtocolVersion {
    /// 2025-06-18: 最新版本，支持Streamable HTTP
    V2025_06_18,
    /// 2025-03-26: SSE弃用版本，OAuth 2.1支持
    V2025_03_26,
    /// 2024-11-05: 当前版本（向后兼容）
    V2024_11_05,
}

impl ProtocolVersion {
    /// 获取版本字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::V2025_06_18 => "2025-06-18",
            Self::V2025_03_26 => "2025-03-26",
            Self::V2024_11_05 => "2024-11-05",
        }
    }

    /// 从字符串解析版本
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "2025-06-18" => Some(Self::V2025_06_18),
            "2025-03-26" => Some(Self::V2025_03_26),
            "2024-11-05" => Some(Self::V2024_11_05),
            _ => None,
        }
    }

    /// 获取所有支持的版本（按优先级排序）
    pub fn all_versions() -> Vec<Self> {
        vec![Self::V2025_06_18, Self::V2025_03_26, Self::V2024_11_05]
    }

    /// 检查是否支持SSE传输
    pub fn supports_sse(&self) -> bool {
        match self {
            Self::V2025_06_18 => false, // SSE已弃用
            Self::V2025_03_26 => true,  // 最后支持SSE的版本
            Self::V2024_11_05 => true,  // 支持SSE
        }
    }

    /// 检查是否支持Streamable HTTP
    pub fn supports_streamable_http(&self) -> bool {
        match self {
            Self::V2025_06_18 => true, // 新增支持
            Self::V2025_03_26 => false,
            Self::V2024_11_05 => false,
        }
    }

    /// 检查是否需要OAuth 2.1
    pub fn requires_oauth(&self) -> bool {
        match self {
            Self::V2025_06_18 => true,  // 强制要求
            Self::V2025_03_26 => true,  // 强制要求
            Self::V2024_11_05 => false, // 可选
        }
    }
}

/// 协议版本协商器
pub struct ProtocolNegotiator {
    preferred_versions: Vec<ProtocolVersion>,
}

impl Default for ProtocolNegotiator {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolNegotiator {
    /// 创建新的协商器
    pub fn new() -> Self {
        Self {
            preferred_versions: ProtocolVersion::all_versions(),
        }
    }

    /// 设置首选版本
    pub fn with_preferred_version(mut self, version: ProtocolVersion) -> Self {
        // 将首选版本移到最前
        self.preferred_versions.retain(|v| v != &version);
        self.preferred_versions.insert(0, version);
        self
    }

    /// 协商协议版本
    pub async fn negotiate(&self, server_info: &Value) -> ProtocolVersion {
        // 尝试从多个可能的字段获取服务器支持的版本
        let server_versions = self.extract_server_versions(server_info);

        if server_versions.is_empty() {
            warn!("Server did not provide supported versions, using fallback");
            return self
                .preferred_versions
                .last()
                .cloned()
                .unwrap_or(ProtocolVersion::V2024_11_05);
        }

        // 找到双方都支持的最高版本
        for preferred in &self.preferred_versions {
            if server_versions.contains(&preferred.as_str().to_string()) {
                info!("Negotiated protocol version: {}", preferred.as_str());
                return preferred.clone();
            }
        }

        // 如果没有匹配，尝试使用服务器的第一个版本
        if let Some(server_version) = server_versions.first() {
            if let Some(version) = ProtocolVersion::from_str(server_version) {
                warn!("Using server's version: {}", server_version);
                return version;
            }
        }

        // 最后的fallback
        warn!("No compatible version found, using oldest version for compatibility");
        ProtocolVersion::V2024_11_05
    }

    /// 提取服务器支持的版本
    fn extract_server_versions(&self, server_info: &Value) -> Vec<String> {
        let mut versions = Vec::new();

        // 尝试多个可能的字段名
        let possible_fields = [
            "supportedVersions",
            "supported_versions",
            "protocolVersions",
            "protocol_versions",
            "versions",
        ];

        for field in &possible_fields {
            if let Some(arr) = server_info.get(field).and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        versions.push(s.to_string());
                    }
                }
            }
        }

        // 也检查单个版本字段
        if versions.is_empty() {
            if let Some(version) = server_info
                .get("protocolVersion")
                .or_else(|| server_info.get("protocol_version"))
                .and_then(|v| v.as_str())
            {
                versions.push(version.to_string());
            }
        }

        versions
    }

    /// 根据版本选择合适的传输方式
    pub fn select_transport(
        &self,
        version: &ProtocolVersion,
        available: &[&str],
    ) -> Option<String> {
        // 优先使用Streamable HTTP
        if version.supports_streamable_http() && available.contains(&"streamable_http") {
            return Some("streamable_http".to_string());
        }

        // 其次使用WebSocket
        if available.contains(&"websocket") {
            return Some("websocket".to_string());
        }

        // 然后是SSE（如果版本支持）
        if version.supports_sse() && available.contains(&"sse") {
            return Some("sse".to_string());
        }

        // 最后是stdio
        if available.contains(&"stdio") {
            return Some("stdio".to_string());
        }

        None
    }
}

/// 版本兼容性检查器
pub struct CompatibilityChecker;

impl CompatibilityChecker {
    /// 检查客户端和服务器版本是否兼容
    pub fn check_compatibility(
        client_version: &ProtocolVersion,
        server_version: &ProtocolVersion,
    ) -> CompatibilityResult {
        use ProtocolVersion::*;

        match (client_version, server_version) {
            // 相同版本，完全兼容
            (a, b) if a == b => CompatibilityResult::FullyCompatible,

            // 2025-06-18可以向后兼容
            (V2025_06_18, V2025_03_26) | (V2025_06_18, V2024_11_05) => {
                CompatibilityResult::BackwardCompatible(
                    "Client is newer, some features may not be available".to_string(),
                )
            }

            // 旧客户端连接新服务器
            (V2024_11_05, V2025_03_26) | (V2024_11_05, V2025_06_18) => {
                CompatibilityResult::LimitedCompatibility(
                    "Client is older, authentication may be required".to_string(),
                )
            }

            // 其他组合
            _ => CompatibilityResult::BackwardCompatible(
                "Version mismatch, basic features should work".to_string(),
            ),
        }
    }
}

/// 兼容性结果
#[derive(Debug, Clone)]
pub enum CompatibilityResult {
    /// 完全兼容
    FullyCompatible,
    /// 向后兼容（有警告）
    BackwardCompatible(String),
    /// 有限兼容（功能受限）
    LimitedCompatibility(String),
    /// 不兼容
    Incompatible(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_version_ordering() {
        assert!(ProtocolVersion::V2025_06_18 > ProtocolVersion::V2025_03_26);
        assert!(ProtocolVersion::V2025_03_26 > ProtocolVersion::V2024_11_05);
    }

    #[test]
    fn test_version_features() {
        assert!(!ProtocolVersion::V2025_06_18.supports_sse());
        assert!(ProtocolVersion::V2025_06_18.supports_streamable_http());
        assert!(ProtocolVersion::V2025_06_18.requires_oauth());

        assert!(ProtocolVersion::V2024_11_05.supports_sse());
        assert!(!ProtocolVersion::V2024_11_05.supports_streamable_http());
        assert!(!ProtocolVersion::V2024_11_05.requires_oauth());
    }

    #[tokio::test]
    async fn test_version_negotiation() {
        let negotiator = ProtocolNegotiator::new();

        // 服务器支持所有版本
        let server_info = json!({
            "supportedVersions": ["2025-06-18", "2025-03-26", "2024-11-05"]
        });
        let version = negotiator.negotiate(&server_info).await;
        assert_eq!(version, ProtocolVersion::V2025_06_18);

        // 服务器只支持旧版本
        let server_info = json!({
            "supportedVersions": ["2024-11-05"]
        });
        let version = negotiator.negotiate(&server_info).await;
        assert_eq!(version, ProtocolVersion::V2024_11_05);

        // 服务器使用不同的字段名
        let server_info = json!({
            "protocol_version": "2025-03-26"
        });
        let version = negotiator.negotiate(&server_info).await;
        assert_eq!(version, ProtocolVersion::V2025_03_26);
    }

    #[test]
    fn test_transport_selection() {
        let negotiator = ProtocolNegotiator::new();

        // 新版本优先使用Streamable HTTP
        let transport = negotiator.select_transport(
            &ProtocolVersion::V2025_06_18,
            &["stdio", "websocket", "sse", "streamable_http"],
        );
        assert_eq!(transport, Some("streamable_http".to_string()));

        // 旧版本不能使用Streamable HTTP
        let transport = negotiator.select_transport(
            &ProtocolVersion::V2024_11_05,
            &["stdio", "websocket", "sse", "streamable_http"],
        );
        assert_eq!(transport, Some("websocket".to_string()));

        // SSE在新版本中不可用
        let transport =
            negotiator.select_transport(&ProtocolVersion::V2025_06_18, &["stdio", "sse"]);
        assert_eq!(transport, Some("stdio".to_string()));
    }

    #[test]
    fn test_compatibility_check() {
        use ProtocolVersion::*;

        // 相同版本
        let result = CompatibilityChecker::check_compatibility(&V2025_06_18, &V2025_06_18);
        matches!(result, CompatibilityResult::FullyCompatible);

        // 新客户端，旧服务器
        let result = CompatibilityChecker::check_compatibility(&V2025_06_18, &V2024_11_05);
        matches!(result, CompatibilityResult::BackwardCompatible(_));

        // 旧客户端，新服务器
        let result = CompatibilityChecker::check_compatibility(&V2024_11_05, &V2025_06_18);
        matches!(result, CompatibilityResult::LimitedCompatibility(_));
    }
}
