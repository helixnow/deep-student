# docs/ 文档导航

> 在线使用指南：https://deepstudent.cn/user-guide/

## 用户指南（面向最终用户）

| 文档 | 说明 |
| :--- | :--- |
| [user-guide/README.md](./user-guide/README.md) | 中文使用指南总目录（覆盖桌面端、移动端与 WebUI） |
| [user-guide/en/README.md](./user-guide/en/README.md) | English User Guide |
| [DEEPSEEK-API.md](./DEEPSEEK-API.md) | DeepSeek 对话功能与独立 API 配置说明 |
| [WEBUI-AND-PWA.md](./WEBUI-AND-PWA.md) | WebUI 与 PWA 的运行方式、安全模型与自托管说明 |

## 开发者与贡献者文档

| 文档 | 说明 |
| :--- | :--- |
| [CODE_STYLE.md](./CODE_STYLE.md) | 代码风格与前端/Host 开发规范 |
| [BUILD-CONFIG.md](./BUILD-CONFIG.md) | 跨平台构建环境配置（签名、证书、环境变量） |
| [README-BUILD.md](./README-BUILD.md) | 构建与本地运行脚本速查 |
| [frontend/README.md](./frontend/README.md) | 前端组件体系、设计令牌与界面模式 |
| [plugins/PLUGIN-V2.md](./plugins/PLUGIN-V2.md) | Plugin v2 三层扩展模型与 `.dspack` 学习包概览 |
| [plugins/ARCHITECTURE.md](./plugins/ARCHITECTURE.md) | 后端 Cordis 插件架构（前端插件化见 [plugins/FRONTEND.md](./plugins/FRONTEND.md)） |
| [plugins/SDK.md](./plugins/SDK.md) | 社区插件开发 SDK 指南（清单、Host 服务与 UI 插槽） |
| [plugins/CAPABILITIES.md](./plugins/CAPABILITIES.md) | 官方服务、命令与事件能力清单（自动生成） |
| [plugins/SECURITY.md](./plugins/SECURITY.md) | 社区插件安全边界、`ds-plugin://` 校验与权限约束 |
| [plugins/UPGRADES.md](./plugins/UPGRADES.md) | 桌面应用升级兼容与用户插件保留机制 |
| [community/good-first-issues.md](./community/good-first-issues.md) | 社区贡献入门参考 |

## 法务与合规

| 文档 | 说明 |
| :--- | :--- |
| [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) | 第三方开源软件许可证清单 |

## 公开仓库文档规范

本仓库仅收录**产品源码本体**与面向最终用户、外部贡献者的**必要公开文档**（由 `npm run check:public-surface` 自动校验）。内部研发方案、过程记录、运维配置与评测集请勿提交至本仓库。
