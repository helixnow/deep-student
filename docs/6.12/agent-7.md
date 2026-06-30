# 代理 7 —— 平台基座与全局体验

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-7-status.md`。
> 本组是横切组,同时承担三个共享文件(commands.rs、lib.rs、App.tsx)的一致性仲裁,
> 建议与代理 2 同批最先启动。

## 1. 负责域

安全与数据治理、云同步、系统基础设施、应用壳与全局 UI:设置中心、命令面板、
仪表盘统计、待办/番茄钟、基础 UI 组件库、调试工具、i18n。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 数据治理 | `data_governance/`、`backup_common.rs`、`backup_config.rs`、`backup_job_manager.rs`(~44KB)、`batch_operations.rs` | 全量备份/恢复、审计、迁移 |
| 云同步 | `cloud_storage/` | S3 兼容 / WebDAV(实验性);参考 `docs/cloud-sync-*.md` 两份既有分析 |
| 加密安全 | `crypto/`、`secure_store.rs` | AES-256-GCM、双槽位 A/B |
| 应用装配 | `lib.rs`(~127KB)、`commands.rs`(~196KB)架构、`main.rs`、`menu.rs`、`capabilities/` | 命令注册、Tauri 权限能力 |
| 可观测性 | `debug_logger.rs`、`debug_log_service.rs`、`crash_logger.rs`、`anr_watchdog.rs`、`metrics_server.rs`、`error_details.rs`、`error_recovery.rs`、`workflow_error_handler.rs` | 日志、崩溃、看门狗 |
| 配置与开关 | `feature_flags.rs`、`config_recovery.rs`、`json_validator.rs` | 特性开关、配置恢复 |
| 调试命令 | `debug_commands.rs` | 开发用命令 |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 应用壳 | `App.tsx`(~103KB)、`main.tsx`、`src/app/`(shell、navigation)、`components/layout/`、`lazyComponents.tsx` | 路由/布局/懒加载 |
| 设置中心 | `features/settings/` | 模型/密钥/隐私/备份设置、更新检查 |
| 命令面板 | `features/command-palette/`、`src/command-palette/` | 快捷键、拼音搜索 |
| 仪表盘统计 | `components/dashboard/`、`components/stats/`、`LearningHeatmap/`、`components/llm-usage/`、`Dashboard.tsx` | 热力图、用量 |
| 待办番茄钟 | `features/todo/`、`features/pomodoro/` | 待办、计时 |
| 基础 UI 库 | `components/ui/`、`components/shared/`、`components/icons/`、`context-menu/`、`src/shared/` | Radix/shadcn、统一侧栏、Phosphor 图标 |
| 数据导入导出 UI | `components/DataImportExport.tsx`(~90KB)、`ConflictResolutionDialog.tsx`(~38KB)、`ImportConversationDialog.tsx` | 备份恢复界面 |
| 服务与主题 | `src/services/`、`hooks/useTheme.ts`、`useAppUpdater.ts`、`styles/`、`src/locales/`、`i18n.ts` | 更新、审计、主题、i18n |
| 调试面板 | `src/debug-panel/`、`components/dev/`、`system-status/`、`style-lab/` | 开发工具 |

## 3. 不归属本组(别改)
- 各业务特性内部逻辑 → 代理 1–6(本组管壳与公共件,不动业务)。
- 移动端专项适配 → 代理 8(本组负责桌面端体验与公共布局)。

## 4. 审阅重点清单
- [ ] 备份/恢复:备份完整性(SQLite+Lance+Blob 三处)、恢复的原子性(中途失败回滚)、大库性能。
- [ ] 云同步:参照 `docs/cloud-sync-compatibility-analysis-2026-05-23.md` 与 `cloud-sync-remediation-plan.md` 核对整改落实情况、收敛性、冲突处理。
- [ ] 加密:密钥派生与存储、双槽位切换原子性、敏感字段是否全部走 secure_store(排查明文落盘)。
- [ ] commands.rs/lib.rs:命令注册一致性、错误转换规范统一、是否有未注册/僵尸命令。
- [ ] Tauri capabilities 权限最小化(`src-tauri/capabilities/`)。
- [ ] 审计日志覆盖面与隐私(不记录敏感内容)。
- [ ] App.tsx(103KB):启动链路性能、懒加载切分是否合理、全局状态初始化顺序。
- [ ] 基础 UI 库:组件 API 一致性、design tokens 遵循(`docs/design-tokens-and-color-semantics.md`)、可访问性(焦点环、ARIA)。
- [ ] i18n:中英 key 完整性(`npm run check:i18n`)、硬编码文案排查。
- [ ] 更新器(useAppUpdater/plugin-updater)与崩溃恢复(config_recovery)路径。
- [ ] 全局错误边界(ErrorBoundary)覆盖与降级体验。

## 5. 跨组仲裁职责(本组特有)
- 其他组对 `commands.rs`/`lib.rs`/`App.tsx`/`models.rs`(代理 2 主责)的改动登记后,本组定期核查一致性。
- 各组报来的"基础组件问题"由本组统一修复,避免业务组各自 fork 组件。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test backup`、`cargo test cloud`、`cargo test crypto`、
`npm test -- settings`、`npm run check:i18n`、`npm run lint:css`。
