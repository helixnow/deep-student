# Security Policy | 安全政策

## Supported Versions | 支持的版本

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9.0 | :x:                |

## Reporting a Vulnerability | 报告安全漏洞

We take security issues seriously. If you discover a security vulnerability, please follow the process below.

我们非常重视安全问题。如果您发现安全漏洞，请按照以下流程操作。

### Reporting Process | 报告流程

1. **DO NOT** create a public GitHub issue for security vulnerabilities.
   
   **不要**为安全漏洞创建公开的 GitHub Issue。

2. Send an email to: **security@deepstudent.app** (or use GitHub Security Advisories if available)
   
   请发送邮件至：**security@deepstudent.app**（或使用 GitHub Security Advisories，如可用）

3. Include the following information:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
   
   请包含以下信息：
   - 漏洞描述
   - 复现步骤
   - 潜在影响
   - 建议的修复方案（如有）

### Response SLA | 响应时效

| Severity | Initial Response | Resolution Target |
| -------- | ---------------- | ----------------- |
| Critical | 24 hours         | 7 days            |
| High     | 48 hours         | 14 days           |
| Medium   | 7 days           | 30 days           |
| Low      | 14 days          | 90 days           |

### What to Expect | 您可以期待

1. **Acknowledgment**: We will acknowledge receipt of your report within the SLA timeframe.
   
   **确认**：我们将在 SLA 时效内确认收到您的报告。

2. **Investigation**: Our security team will investigate and validate the report.
   
   **调查**：我们的安全团队将调查并验证报告。

3. **Updates**: We will keep you informed of our progress.
   
   **更新**：我们将持续通知您进展情况。

4. **Resolution**: Once resolved, we will notify you and coordinate disclosure.
   
   **解决**：问题解决后，我们将通知您并协调披露事宜。

5. **Credit**: With your permission, we will acknowledge your contribution in the release notes.
   
   **致谢**：经您许可，我们将在发布说明中致谢您的贡献。

## Security Best Practices | 安全最佳实践

### For Users | 用户须知

- Always download releases from official sources (GitHub Releases / Official Website)
- Keep the application updated to the latest version
- Be cautious when importing data from untrusted sources
- Review MCP server configurations before enabling

### For Developers | 开发者须知

- Follow the secure coding guidelines in `CODE_STYLE.md`
- Never commit secrets, API keys, or credentials
- Use the secure store API (`secure_store.rs`) for sensitive data
- Review third-party dependencies before adding

## Scope | 范围

### In Scope | 在范围内

- DeepStudent desktop application (Windows, macOS, Linux)
- DeepStudent mobile application (iOS, Android)
- Official MCP server integrations
- Data storage and encryption mechanisms

### Out of Scope | 不在范围内

- Third-party MCP servers
- User-configured external services
- Issues in upstream dependencies (report to respective projects)

## Security Features | 安全特性

DeepStudent implements the following security measures:

DeepStudent 实现了以下安全措施：

- **Local-first data storage**: All user data stored locally by default
  
  **本地优先数据存储**：所有用户数据默认存储在本地

- **AES-256-GCM encryption**: Sensitive data (API keys) encrypted at rest via `secure_store.rs`
  
  **AES-256-GCM 加密**：敏感数据（API 密钥）通过 `secure_store.rs` 静态加密

- **MCP allow/deny lists**: Configurable tool access controls
  
  **MCP 允许/拒绝列表**：可配置的工具访问控制

### Known Limitations | 已知限制

- **CSP (Content Security Policy)**: The current CSP configuration is permissive (`unsafe-eval`, `unsafe-inline`, wildcard `*` sources) to support MCP tool integrations and dynamic content. This is an area for future hardening.
  
  **CSP（内容安全策略）**：当前 CSP 配置较为宽松（`unsafe-eval`、`unsafe-inline`、通配符 `*` 来源），以支持 MCP 工具集成和动态内容。这是未来需要加固的领域。

- **File system permissions**: The application requests broad file system access (user directories) for resource management. Users should be aware of this when granting permissions.
  
  **文件系统权限**：应用请求较广泛的文件系统访问权限（用户目录），用于资源管理。用户在授权时应注意这一点。

- **withGlobalTauri**: Enabled for frontend-backend communication. This exposes Tauri APIs to the WebView context.
  
  **withGlobalTauri**：已启用以支持前后端通信，这会将 Tauri API 暴露给 WebView 上下文。

---

Thank you for helping keep DeepStudent and our users safe!

感谢您帮助保护 DeepStudent 和我们的用户安全！


