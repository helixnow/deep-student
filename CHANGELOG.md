# Changelog | 更新日志

All notable changes to this project will be documented in this file.

本项目的所有重要变更都将记录在此文件中。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.9.18](https://github.com/helixnow/deep-student/compare/v0.9.17...v0.9.18) (2026-02-25)


### Features

* add data visualization APIs for OCR and text chunk management ([d1b7ae4](https://github.com/helixnow/deep-student/commit/d1b7ae4b74f5deb9d5cf564e88c72197e1164083))
* enhance backup functionality with ImportProgress struct and refactor auto backup logic ([a33f2d9](https://github.com/helixnow/deep-student/commit/a33f2d9a5db03e2a467a834cf064d17f0efe890c))
* implement block and message actions for enhanced chat functionality ([e68df84](https://github.com/helixnow/deep-student/commit/e68df84be6dfc0bf9fface0ebfda9929fff25d0e))


### Bug Fixes

* correct field references and add missing impl block in debug logger ([13bb819](https://github.com/helixnow/deep-student/commit/13bb8194c7d12c9f7a4083c4dacb352a83a54c81))
* prevent duplicate text input during IME composition and sync skill whitelist after load_skills ([05be6b5](https://github.com/helixnow/deep-student/commit/05be6b53a1e392174058a3f9afc6e51256bbe942))


### Performance Improvements

* optimize view switching with memoization and ref-based state tracking ([2dc59c2](https://github.com/helixnow/deep-student/commit/2dc59c2b6a0cb15d2a274579ac91d3108fb787f6))

## [0.9.17](https://github.com/helixnow/deep-student/compare/v0.9.16...v0.9.17) (2026-02-23)


### Features

* enhance SiliconFlowSection with new OCR model and improve backup functionality ([f94fef3](https://github.com/helixnow/deep-student/commit/f94fef323f4fdf536bdc4bc02a7628b839a7d97b))


### Bug Fixes

* enhance error handling and performance optimizations in Chat V2 ([bbaf9ec](https://github.com/helixnow/deep-student/commit/bbaf9ec19b92ef8ce5bc9ee240b6d39b9fd26392))
* gate desktop_dir/picture_dir with #[cfg(desktop)] for Android build ([512768f](https://github.com/helixnow/deep-student/commit/512768f1e1fd7b3d0e9bbf866a471f71ad438b50))
* **gemini:** add thought_signature support for Gemini 3 tool calling and enforce role alternation ([aa82ff0](https://github.com/helixnow/deep-student/commit/aa82ff0d7fdefa14d54f12b7565db3b0d7069a10))
* **gemini:** force v1beta for Gemini 3 models and convert unprotected functionCalls to text ([cd35419](https://github.com/helixnow/deep-student/commit/cd35419616fb2b92996438ae08e302f0ef78ece1))
* **memory:** enforce atomic fact storage and prevent knowledge/content leakage ([dab0c78](https://github.com/helixnow/deep-student/commit/dab0c78383d79b1f4fe3951b6b4b63e54423c48d))

## [0.9.16](https://github.com/helixnow/deep-student/compare/v0.9.15...v0.9.16) (2026-02-22)


### Features

* **chat-v2:** add disable_tool_whitelist option to bypass skill whitelist restrictions ([830d1eb](https://github.com/helixnow/deep-student/commit/830d1eb815a8e8bd1386064d06aa97a3e6c04d04))
* 题目集导入断点续导（checkpoint resume） ([6ef1333](https://github.com/helixnow/deep-student/commit/6ef1333e92f6977c6f072223e66ae0a7227a4045))


### Bug Fixes

* address verified P0/P1 issues from code audit ([0dca38e](https://github.com/helixnow/deep-student/commit/0dca38e5761c670a4f5d6681f0a50dadb283239a))
* **chat-v2:** ensure active skills content is always passed to backend for synthetic load_skills injection ([0f791c0](https://github.com/helixnow/deep-student/commit/0f791c074fb7fdaf87c7e39a50747df2531beafc))
* **mcp:** audit compliance fixes - timeout alignment, connection state tracking, and DRY refactor ([4fbb093](https://github.com/helixnow/deep-student/commit/4fbb093ef85ea0fdd0e19e43bc44d9316dac0147))
* **mcp:** sanitize tool names for OpenAI API compatibility and improve memory retrieval ranking ([2bf3d9f](https://github.com/helixnow/deep-student/commit/2bf3d9fd34fed8d569dc0b666e7244c5c1e186cb))
* **web-search:** remove engine/force_engine from schema and add silent fallback for unconfigured engines ([e136ef8](https://github.com/helixnow/deep-student/commit/e136ef8206c9bcc3c933cd0a8c635d70f2cfc407))

## [0.9.15](https://github.com/helixnow/deep-student/compare/v0.9.14...v0.9.15) (2026-02-21)


### Features

* **mindmap:** add rich text formatting toolbar and emoji picker, improve node styling and export ([36981fb](https://github.com/helixnow/deep-student/commit/36981fbe1ee5578355128f7d26c69ae106c5cfbf))


### Bug Fixes

* **essay-grading:** replace description Input with textarea for multi-line mode descriptions ([881bd5e](https://github.com/helixnow/deep-student/commit/881bd5e97c72c4cc82b85e1e2ea302d4b70b00fe))

## [0.9.14](https://github.com/helixnow/deep-student/compare/v0.9.13...v0.9.14) (2026-02-20)


### Features

* **chat-v2:** add session branching and group pinned resources support ([82f359c](https://github.com/helixnow/deep-student/commit/82f359cb9ad3ca77cca01a2082f37b5c4ff747ce))
* **chat-v2:** use dedicated chat_title_model for summary generation with fallback chain ([eb5e14d](https://github.com/helixnow/deep-student/commit/eb5e14d425a49606373de786e8dc6c27fded302b))
* **cloud-sync:** add real-time upload/download progress events and workspace database backup support ([8a2b496](https://github.com/helixnow/deep-student/commit/8a2b496ab3b6c84a59327fce896c721d9545c8c4))
* **essay-grading:** refine grading mode rubrics and implement progressive hedging for OCR fallback ([40f2664](https://github.com/helixnow/deep-student/commit/40f2664c44f3be55fab52c54f6ca69737c8c13fb))
* **ocr:** add FreeOCR fallback chain with circuit breaker and streamline grading mode prompts ([6777d50](https://github.com/helixnow/deep-student/commit/6777d501aa9820d599701faea26114e70608209f))
* **settings:** add vendor model batch import and refactor essay grading settings panel ([b282fdb](https://github.com/helixnow/deep-student/commit/b282fdb451db75717f83e6f4614aa20ab8df310c))
* **sync:** add workspace database and VFS blob file-level cloud sync support ([bccce85](https://github.com/helixnow/deep-student/commit/bccce85b2cee4c4a8147364874ee549c05e4ec94))
* **vfs:** filter deleted/inactive resources in index status queries and add question filtering in exam uploader ([1665d05](https://github.com/helixnow/deep-student/commit/1665d0512a5d2fa0bc93c0fb71142cae3adbac08))


### Bug Fixes

* **android:** replace navigator.clipboard with tauri-plugin-clipboard-manager ([d410dc2](https://github.com/helixnow/deep-student/commit/d410dc2eb08b5f3b1cfff06cdec329f3688ade5d))
* **chat-v2:** fix continue message error handling and builtin model badge display logic ([2b20f3a](https://github.com/helixnow/deep-student/commit/2b20f3a705e014a7ba9422b7ea1c1ec4b1827225))
* **chat-v2:** reorder session branching DB writes to satisfy FK constraints and refactor resource picker UI ([185137c](https://github.com/helixnow/deep-student/commit/185137c1bf9177e44bc3fb88acc588c00705a4ed))
* merge duplicate clipboardUtils import in useMindMapClipboard ([fd71294](https://github.com/helixnow/deep-student/commit/fd712942470c2ece3ab6a877d0e8f0ea68df4764))

## [0.9.13](https://github.com/helixnow/deep-student/compare/v0.9.12...v0.9.13) (2026-02-18)


### Features

* add multi-tab support with LRU eviction, fix cross-tab event pollution, and enhance LaTeX rendering ([8af002c](https://github.com/helixnow/deep-student/commit/8af002cc7d29e53092f70d1441be006597cea394))
* enhance tool handling, sleep wake logic, and crypto key backup/restore ([a477bca](https://github.com/helixnow/deep-student/commit/a477bca302fb8d487a5e43a64b56aaad9450651f))
* **indexing:** 一键索引自动对预处理未完成的教材/PDF文件执行OCR ([83560f7](https://github.com/helixnow/deep-student/commit/83560f7968b7957fe70be62e955a48f4565cfdcc))


### Performance Improvements

* **vfs:** optimize index status query with CTE aggregation and add performance indexes ([07c6e5e](https://github.com/helixnow/deep-student/commit/07c6e5ea479bf9b0f888642572693755d4e17530))

## [0.9.12](https://github.com/helixnow/deep-student/compare/v0.9.11...v0.9.12) (2026-02-18)


### Features

* add backup cancellation support and fix attachment base64 detection ([18bbc22](https://github.com/helixnow/deep-student/commit/18bbc223f3f06e6c447f6b6cd2e5de7a00e8932d))

## [0.9.11](https://github.com/helixnow/deep-student/compare/v0.9.10...v0.9.11) (2026-02-17)


### Features

* enhance progress tracking for backup/restore/import operations with detailed error reporting ([9fb24a4](https://github.com/helixnow/deep-student/commit/9fb24a41147ebdb2ee38819f0821ac8e76894bd6))

## [0.9.10](https://github.com/000haoji/deep-student/compare/v0.9.9...v0.9.10) (2026-02-17)


### Features

* mobile dual download links (R2 mirror + GitHub) ([c9c8f6d](https://github.com/helixnow/deep-student/commit/c9c8f6dc583cf01b652a6b0c5378dcbdc0e41125))
* prioritize R2 mirror for auto-update source ([7e479c8](https://github.com/helixnow/deep-student/commit/7e479c8955bbc820afbfa424472a81cd48138185))
* source image crop, search snippets, remove question_parsing_model ([d41f6c0](https://github.com/helixnow/deep-student/commit/d41f6c09ff6c503194264f6da3048397a4e9877f))


### Bug Fixes

* add --remote flag to wrangler r2 commands ([f7068ef](https://github.com/helixnow/deep-student/commit/f7068ef2911443a4325d98a1c7798cdbfd7b8cc2))
* **backup:** configure git user for annotated snapshot tags in bare repo ([6bc2fb4](https://github.com/helixnow/deep-student/commit/6bc2fb4c6d7735623a2e0deaaf7c023b19b7c09d))
* **ci:** prevent dependabot major bumps + precise semver extraction ([b6396bc](https://github.com/helixnow/deep-student/commit/b6396bc73d2a9c7a9d5d61d785d7934e34565bb4))
* critical review fixes for R2 upload in release workflow ([5f616dc](https://github.com/helixnow/deep-student/commit/5f616dc69929005ca8d4a856f64347826501ac1d))
* **release:** disable component-prefixed tags + robust version extraction ([f4bafa4](https://github.com/helixnow/deep-student/commit/f4bafa4822e19881f6c12167d7aa5df60b2cb0d6))
* switch to rclone for R2 upload (native Cloudflare provider) ([d3aebda](https://github.com/helixnow/deep-student/commit/d3aebdab15fc33108c54e1d0ec46e50fdcfb59b6))
* switch to wrangler CLI for R2 upload (bypass S3 TLS issue) ([0272c39](https://github.com/helixnow/deep-student/commit/0272c3963b7d012b3e8500b88f2b8271c8cb3961))
* **updater:** robust version extraction from tag_name for Android ([4be6c1f](https://github.com/helixnow/deep-student/commit/4be6c1fde614fb44b0d9e3a2bad332e86dfacd80))
* use GitHub API for R2 version cleanup (wrangler has no list command) ([41cedb4](https://github.com/helixnow/deep-student/commit/41cedb4c0d68d82e8dd425308194d6c78c8703f1))
* use path-style addressing for R2 S3 compatibility ([c26433d](https://github.com/helixnow/deep-student/commit/c26433db37c04ae5ac7f1e13c542a9c3d5d7dfe1))


### Performance Improvements

* add cache-control headers and proper content-types for R2 uploads ([333d96d](https://github.com/helixnow/deep-student/commit/333d96dd73b903ead76a07182a43c94bda277617))

## [0.9.9](https://github.com/helixnow/deep-student/compare/deep-student-v0.9.8...deep-student-v0.9.9) (2026-02-17)


### Bug Fixes

* **android:** disable ppt-rs default features to avoid openssl-sys ([6a3acc7](https://github.com/helixnow/deep-student/commit/6a3acc7c278c3a839849e6d4b46a24895067c1ca))

## [0.9.8](https://github.com/helixnow/deep-student/compare/deep-student-v0.9.7...deep-student-v0.9.8) (2026-02-17)


### Features

* add academic search tool with arXiv + OpenAlex integration ([1ae5c24](https://github.com/helixnow/deep-student/commit/1ae5c24534afe33addc0980801bde18869b79e4a))
* add Android build to release workflow + bump VERSION_CODE_BASE to 13000 ([54c0d22](https://github.com/helixnow/deep-student/commit/54c0d22407b305c32df90a9848225637f4c9fe4f))
* add attachment pipeline automated test plugin ([371e5c5](https://github.com/helixnow/deep-student/commit/371e5c5a6f830475cffb70f65480c2c17153495b))
* add database maintenance mode + fix Windows file lock (OS error 32) during restore ([7023510](https://github.com/helixnow/deep-student/commit/7023510b76afcb23149ba0271e9c020c102c9608))
* add orphan OCR engine cleanup + improve file save UX + fix test engine selection ([b080582](https://github.com/helixnow/deep-student/commit/b08058212f4cb360ba87bf96dd41721eb772fc37))
* add paper save + citation formatting tools with VFS integration ([176aae2](https://github.com/helixnow/deep-student/commit/176aae2b49fd03b3d6ed0a4c636fa08e644e5aaf))
* cross-platform pdfium fixes + system OCR adapters + platform-specific resource bundling ([ea87e01](https://github.com/helixnow/deep-student/commit/ea87e015a84e1da8c5ed32b9679de0d7298f9db1))
* improve mobile UI layout + migrate template buttons to NotionButton ([afd62b4](https://github.com/helixnow/deep-student/commit/afd62b4bb278f8790ff9918e0080e6d8cc36939f))
* integrate release-please for automated release management ([69db429](https://github.com/helixnow/deep-student/commit/69db42973bf69849e730f25a61d80129a3b767ce))
* **tools:** add DOCX document read/write tool executor + Excel/PowerPoint dependencies ([2a7546a](https://github.com/helixnow/deep-student/commit/2a7546a942b55d8bbf163f6e22ea9239d1baf988))
* **tools:** add PPTX/XLSX tool executors with full read/write capabilities ([d3f6bc5](https://github.com/helixnow/deep-student/commit/d3f6bc52d5899a7def675f16adb815bd08536421))


### Bug Fixes

* add empty string clearing for group fields + validate group existence + cleanup vector indices on delete/purge ([754da80](https://github.com/helixnow/deep-student/commit/754da807a666d8cf4fe80a901638aa2f3c66999d))
* add generate-version.mjs to all platform builds + update committed version ([2f0cfec](https://github.com/helixnow/deep-student/commit/2f0cfec870d15e29f1ef2ec4082b13ba2109ddc1))
* add process:default capability + harden semver comparison ([78bff18](https://github.com/helixnow/deep-student/commit/78bff1854e0a2c4b1fb8d3373b986013e2885b09))
* add protoc install for macOS (brew) and Windows (choco) in release builds ([69e67f0](https://github.com/helixnow/deep-student/commit/69e67f0113f99ba9410de90d1ef32966d128b085))
* bump VERSION_CODE_BASE to 10000 + Node 22 + memory fix for release builds ([8143f02](https://github.com/helixnow/deep-student/commit/8143f02c424ddf2c59973fea27c97e15f8837662))
* copy custom Android icons after tauri android init in CI ([f69ab56](https://github.com/helixnow/deep-student/commit/f69ab56cb6a45d9d15247c23ea7a13c4725a52a2))
* **deps:** migrate json_validator to jsonschema 0.42 API ([a044d95](https://github.com/helixnow/deep-student/commit/a044d95869a2b3f714693a67b18792139101aed4))
* downgrade pdfium to 7350 + add diagnostic command + repair stale PDF cache + harden ready_modes validation ([92a317c](https://github.com/helixnow/deep-student/commit/92a317c8d6c6c82019d596a38ee3d6df0fa974c2))
* enable createUpdaterArtifacts for Tauri v2 updater ([6ca2e5c](https://github.com/helixnow/deep-student/commit/6ca2e5c0410fddc07f91e09d7c581113b845cd52))
* harden migration backup validation + auto-backfill PDF processing status + improve test plugin model handling ([1e23842](https://github.com/helixnow/deep-student/commit/1e238422f6def557b8b1b498a156eed8b51a3ed4))
* improve tool call argument parsing + add paper save fallback handling + add purge safety checks ([bf94e37](https://github.com/helixnow/deep-student/commit/bf94e3753fbed6c48450424e286d3da629fde6d2))
* improve tool schema parameter formats to reduce LLM confusion ([2b24b1e](https://github.com/helixnow/deep-student/commit/2b24b1ea7248ac25849f3b3db233b0475059957d))
* mobile updater uses semver comparison instead of string inequality ([612c250](https://github.com/helixnow/deep-student/commit/612c25033d623d1eb4a8aef83fe306ee061491d5))
* platform-aware auto-updater for all platforms ([29651ad](https://github.com/helixnow/deep-student/commit/29651ad3c1d58232d50b452fbb6d0e4740e04d7c))
* release workflow critical fixes ([0c3b404](https://github.com/helixnow/deep-student/commit/0c3b404b599af69b5b4cee7ed7a1b1e4c22ae650))
* remove custom OCR prompts + harden attachment test plugin ([7c3e43d](https://github.com/helixnow/deep-student/commit/7c3e43de723620d35675e75b39ab10d03b709727))
* remove default Tauri drawables + restrict mobile.json to mobile platforms ([ca43bb3](https://github.com/helixnow/deep-student/commit/ca43bb3aa1560e1fc95424cd2d06c93a0ff12993))
* remove Gemini OpenAI compat mode special handling + add OCR diagnostic logging ([5063706](https://github.com/helixnow/deep-student/commit/50637067311e65a5ea173a4e57ddae0db2e3ca0b))
* rename macOS .app.tar.gz with arch suffix to prevent overwrite ([a7936cb](https://github.com/helixnow/deep-student/commit/a7936cb77bb6807481371f20be0f7d05a238ac04))
* resolve TypeScript type errors in attachment audit logging ([499a41b](https://github.com/helixnow/deep-student/commit/499a41b5af3d8a34769a6b77cd9db37c5f22b1db))
* **restore:** 恢复备份写入非活跃插槽，避免 Windows OS error 32 ([af6c11f](https://github.com/helixnow/deep-student/commit/af6c11f89a51f47d88035172f83bf0a9f63f44e5))
* restrict desktop capabilities to desktop platforms + misc improvements ([6772c17](https://github.com/helixnow/deep-student/commit/6772c17932d553c8908acc562a8d2e81eaeac817))
* show 'already up to date' feedback after manual update check ([e7b27fe](https://github.com/helixnow/deep-student/commit/e7b27fe2ccb6c44a3f3f6796f761895ec45e9e98))
* use arduino/setup-protoc, fail-fast false, remove redundant frontend build ([1ddf626](https://github.com/helixnow/deep-student/commit/1ddf6268e583e8a9bbda4afd26458ed28d335f34))

## [Unreleased] | 未发布

---

## [0.9.7] - 2026-02-16

### Fixed | 修复
- 修复 v0.9.6 发布构建产物版本号错误的问题（版本文件未正确 bump）

### Changed | 变更
- 规范 release 流程：版本 bump 必须通过 release-please PR 合并，禁止手动 tag

---

## [0.9.6] - 2026-02-15

### Added | 新增
- 数据库维护模式，支持备份恢复期间自动切换
- 英文 README 及双语导航链接
- 翻译工作台功能及截图文档
- Anki 模板截图文档更新 + 最新 LLM 模型（GLM-5, Seed 2.0, M2.5, GPT-5.2 Pro）

### Fixed | 修复
- 修复恢复备份写入非活跃插槽，避免 Windows OS error 32 文件锁问题

### Changed | 变更
- CI 移除 cargo fmt 检查 + 按钮迁移到 NotionButton 组件

---

## [0.9.5] - 2026-02-13

### Added | 新增
- 安全政策文档 (`SECURITY.md`)
- 环境变量示例 (`.env.example`)
- Playwright E2E 测试配置
- CI/CD 流水线配置 (`.github/workflows/ci.yml`)
- 第三方许可证清单 (`THIRD_PARTY_LICENSES.md`)

### Changed | 变更
- 移除贡献者许可协议文档（待议）

### Fixed | 修复
- 修复 `test:e2e` 脚本缺失问题

---

## [0.9.1] - 2026-02-12

### Added | 新增
- ChatAnki 端到端制卡闭环（替代原 CardForge 独立制卡流程）
- Skills 渐进披露架构：工具按需注入，显著减少上下文占用
- 内置技能：`tutor-mode`、`chatanki`、`literature-review`、`research-mode`
- 内置工具组：`knowledge-retrieval`、`canvas-note`、`vfs-memory`、`todo-tools` 等 11 个
- 数据治理面板：集中化备份、同步、审计、迁移管理
- 云同步功能：WebDAV 和 S3 兼容存储支持
- 双槽位数据空间 A/B 切换机制
- 外部搜索引擎：新增智谱 AI 搜索、博查 AI 搜索
- MCP 预置服务器：Context7 文档检索
- 命令面板：支持收藏、自定义快捷键、拼音搜索
- 3D 卡片预览与多风格内置模板（11 种设计风格）
- 多模态精排模型支持
- 子代理工作器（subagent-worker）技能

### Changed | 变更
- 模型分配简化：移除第一模型、深度研究模型、总结生成模型，统一使用对话模型
- 备份设置迁移到数据治理面板
- 底部导航栏改为 5 个直接 Tab（移除"更多"折叠菜单）
- MCP 预置服务器精简为仅 Context7

### Fixed | 修复
- 修复移动端底部导航栏布局
- 修复多个命令面板快捷键冲突

---

## [0.9.0] - 2026-01-31

### Added | 新增
- Chat V2 架构：支持多轮对话、消息编辑、流式响应
- MCP (Model Context Protocol) 工具生态集成
- VFS 统一资源存储系统
- 双槽位数据空间与迁移机制
- AES-256-GCM 安全存储
- 国际化支持 (i18n)
- 深色/浅色主题切换
- PDF/Word/PPT 文档预览
- 知识图谱可视化
- 错题本与 Anki 导出

### Changed | 变更
- 升级 Tauri 至 v2.x
- 重构前端状态管理（Zustand）
- 优化移动端 UI 适配

### Fixed | 修复
- 修复 Android WebView 兼容性问题
- 修复大文件上传内存溢出
- 修复会话切换时的状态泄漏

---

## [0.8.9] - 2024-11-30

### Added | 新增
- 初始公开版本
- 基础聊天功能
- 多模型供应商支持
- 本地优先数据存储

---

[Unreleased]: https://github.com/helixnow/deep-student/compare/v0.9.17...HEAD
[0.9.7]: https://github.com/helixnow/deep-student/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/helixnow/deep-student/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/helixnow/deep-student/compare/v0.9.1...v0.9.5
[0.9.1]: https://github.com/helixnow/deep-student/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/helixnow/deep-student/compare/v0.8.9...v0.9.0
[0.8.9]: https://github.com/helixnow/deep-student/releases/tag/v0.8.9
