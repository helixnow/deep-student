# Security Policy | 安全政策

## Supported Versions | 支持的版本

Only the latest minor release line receives security fixes.

仅当前最新的次版本系列接收安全更新。

| Version | Supported          |
| ------- | ------------------ |
| 0.20.x  | :white_check_mark: |
| < 0.20  | :x:                |

## Reporting a Vulnerability | 报告安全漏洞

We take security issues seriously. **Please DO NOT open a public GitHub issue for security vulnerabilities.**

我们非常重视安全问题。**请不要为安全漏洞创建公开的 GitHub Issue。**

### Preferred Channel | 首选渠道

1. **GitHub Private Vulnerability Reporting** (Recommended): submit a confidential report directly via [Security Advisories](https://github.com/helixnow/deep-student/security/advisories/new).
2. **Email**: send details to **support@deepstudent.cn**.

Please include:
- Description of the vulnerability and affected component (Desktop / Mobile / WebUI / Host Plugin / MCP)
- Minimal reproduction steps or PoC
- Potential impact and suggested fix (if any)

### Response SLA | 响应时效

| Severity | Initial Response | Target Resolution |
| -------- | ---------------- | ----------------- |
| Critical | 24 hours         | 7 days            |
| High     | 48 hours         | 14 days           |
| Medium   | 7 days           | 30 days           |
| Low      | 90 days          | 90 days           |

## Security Architecture & Boundaries | 安全架构与边界

- **Local-first storage**: user notes, study data, and SQLite databases stay local by default.
- **Encrypted secrets**: API keys and sensitive credentials are protected via OS keyring and AES-256-GCM encryption in `host/platform/secrets/`.
- **IPC & capability isolation**: renderer-to-host commands are governed by explicit IPC contracts (`contracts/ipc/`) and permission manifests (`resources/app/permissions/`).
- **Electron hardening**: production builds enforce Electron Fuses (`electron/scripts/app-hardening.cjs`) and ASAR integrity checks (`electron/scripts/verify-fuses.mjs`).
- **CSP & sandboxing**: HTML/Markdown previews sanitize untrusted content (`rehype-sanitize` / DOMPurify) and enforce strict URL scheme allowlists.
- **Supply-chain hygiene**: automated Dependabot vulnerability alerts & security updates, secret scanning with push protection, pinned GitHub Actions commit SHAs, and AGPL-3.0 license compliance checks (`npm run licenses:check`).

## Scope | 范围

- **In Scope**: DeepStudent desktop app (macOS/Windows/Linux Electron), mobile app (Capacitor Android/iOS), self-hosted WebUI/PWA, official Host plugins, and official Plugin v2 SDK security guarantees (`docs/plugins/SECURITY.md`).
- **Out of Scope**: third-party community plugins, external MCP servers, and user-configured remote LLM endpoints.

Thank you for helping keep DeepStudent and our users safe!
