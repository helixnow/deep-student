# DeepStudent v0.9.35 综合审计报告

**生成时间**：2026-05-16
**项目版本**：v0.9.35（2026-03-14 发布）· AGPL-3.0 · Tauri 2 + React 18 + Rust
**基线对比**：2026-02-08 prior audit（35 天前 · 307 commits · 13 个版本）
**审计方法**：10 个互斥子域并行审计 · ~324k 行 Rust + ~387k 行 TS/TSX

---

## 一、执行摘要

v0.9.35 相较 2026-02-08 基线**显著进步**：CSP `script-src 'self'`、`withGlobalTauri:false`、xlsx 移除、MCP 默认 scope `none`、主库 FK、file_repo SAVEPOINT、MarkdownRenderer memo、MessageList 虚拟化、fallbackLng `en-US`、chat_v2 0 处锁 unwrap —— **prior audit TOP 20 项中 13 FIXED / 3 PARTIAL / 3 OPEN / 1 CHANGED**。

但 10 域并行审计**新发现 17 个 CRITICAL/HIGH 问题**，主要集中在：

1. 审批与敏感度系统失效（Audit 6 C-01/C-02）—— 用户 in-the-loop 防线弱化
2. PDF 处理链未 spawn_blocking（Audit 5 C-1）—— 真实 ANR
3. 数据 URL 缓存可达 50MB（Audit 4 C-1）—— 移动端 OOM
4. 3 处生产 RwLock unwrap（Audit 2 R-2.1）—— 中毒后全模块崩溃
5. 712 处 `as any` + 1142 处 console.log + `strict:false`（Audit 10）—— 类型安全实质关闭

**整体健康度**：7/10。架构正确、模式成熟（虚拟化/memo/useShallow/lazy/事务/取消令牌已全面铺开），剩余债务集中在**安全治理细节、CPU 边界 spawn_blocking、巨型文件拆分**三块。

---

## 二、跨域 CRITICAL/HIGH 汇总（17 项 · 按修复优先级）

| # | 优先级 | 域 | 文件:行 | 问题 | 影响 | 工时 |
|---|--------|----|--------|------|------|------|
| 1 | P0 | Audit 6 | `approval_manager.rs:148-159` | `make_scope_key()` 用整个 arguments JSON 当指纹 | "记住选择"实质失效 | 4h |
| 2 | P0 | Audit 6 | `chatanki_executor.rs:377` | `chatanki_export/sync` = `Low` 敏感度 | LLM 注入即可静默外泄 | 30min |
| 3 | P0 | Audit 6 | `subagent_task.rs:133-177` | `update_status()` 无状态机守卫 | 僵尸任务、重复执行 | 2h |
| 4 | P0 | Audit 5 | `page_rasterizer.rs:65-308` | PDF/DOCX 同步 CPU 渲染未 `spawn_blocking` | 真实 ANR | 30min |
| 5 | P0 | Audit 4 | `MarkdownRenderer.tsx:21-22` | `pdfPageImageCache` 50 个 dataURL ≈ 50MB | 移动端 OOM | 2h |
| 6 | P0 | Audit 2 | `memory/service.rs:433/442/457` | `RwLock::read/write().unwrap()` 生产路径 | 中毒后全模块 panic | 15min |
| 7 | P0 | Audit 4 | `vite.config.ts:218-236` | xyflow/recharts/pdfjs/mermaid 未 manualChunks | 首屏多打包 ~1.2MB | 30min |
| 8 | P1 | Audit 2 | `lance_vector_store.rs:466,3245` | `block_on` 同步函数被 async 调用 | 死锁风险 | 2h |
| 9 | P1 | Audit 5 | `llm_manager/mod.rs:3305-3308` | `reqwest::Client` 每次新建 | 无 TCP 复用 | 20min |
| 10 | P1 | Audit 6 | `chunkBuffer.ts:64,108-109` | `lastSetSessionId` 后备路径残留 | 多会话串话风险 | 1h |
| 11 | P1 | Audit 6 | `manage_session.rs:1115-1128` | branch 会话 `tool_output` 内嵌 ID 未重映射 | 分支会话链接断裂 | 3h |
| 12 | P1 | Audit 2 | DSTU/memory/exam_engine | 11 处 `tokio::spawn` 无 JoinHandle | 关停时清理截断 | 4h |
| 13 | P1 | Audit 5 | `pdf_protocol.rs:227-228` | `read_to_end` 全文件读入 | 阻塞 protocol 线程 | 2h |
| 14 | P1 | Audit 5 | base64 IPC | 100MB PDF → 233MB 瞬态 | 移动端 OOM | 2-4h |
| 15 | P2 | Audit 4 | `InputBarUI.tsx:562` | FileReader 错误分支 Blob URL 不释放 | 持续上传场景泄漏 | 30min |
| 16 | P2 | Audit 4 | `progressiveDisclosure.ts:134` | `loadedSkillsMap` 按 sessionId 累积无上限 | 长会话堆积 | 1h |
| 17 | P2 | Audit 10 | `tsconfig.json` + `eslint.config` | strict:false + no-explicit-any:off + 712 `as any` | 类型安全实质关闭 | sprint 级 |

---

## 三、与 2026-02-08 基线对比（TOP 20 复核）

| 状态 | 数量 | 代表项 |
|------|------|--------|
| ✅ FIXED | 13 | CSP、withGlobalTauri、xlsx、MCP scope、主库 FK、SAVEPOINT、MarkdownRenderer memo、MessageList 虚拟化、fallbackLng、pdfProcessingStore i18n、chat_v2 锁 unwrap、TauriAdapter 热路径 stringify、useShallow 铺开 |
| ⚠️ PARTIAL | 3 | chunkBuffer per-session（仍有 lastSetSessionId 后备）、approval_manager（M-081 未实施）、createChatStore（已分文件但门面仍大） |
| ❌ OPEN | 3 | TypeScript strict、page_rasterizer spawn_blocking、`https://*/*` HTTP 通配 |
| 🔄 CHANGED | 1 | 主密钥仍 plain Base64（未升级 KMS） |

35 天内项目修复速率 ≈ 65% TOP 20 项 + 13 个版本迭代 = **健康节奏**。

---

## 四、十域分述

### Audit 1：Security & Permissions
- ✅ CSP `script-src 'self'`、`withGlobalTauri:false`、MCP scope 默认 `none`、xlsx 移除
- ❌ `https://*/*` HTTP 通配 OPEN（`tauri.conf.json` capabilities）
- ❌ 主密钥 `master_key.bin` 仅 Base64（无 KMS/Keychain 集成）
- ⚠️ Skill prompt CDATA 缺失（`progressiveDisclosure.ts` 注入面）

### Audit 2：Rust Backend Safety（28 项发现）
| 类别 | 数量 | 代表 |
|------|------|------|
| 生产 unwrap | 3 | `memory/service.rs:433/442/457` RwLock |
| 生产 panic! | 2 | `migration/script_checker.rs` 编译期断言 |
| block_on 死锁风险 | 2 | `lance_vector_store.rs:466,3245` |
| 孤儿 spawn | 11 | DSTU 4 + 回收站 2 + memory 2 + exam_engine 1 |
| println!/eprintln! 生产 | ~220 | `database/mod.rs` 占 ~216 |
| unsafe | 2 | pdfium feature-gated · macOS OCR null-checked（可接受）|
| filter_map(.ok()) 生产 | 5 | coordinator/sync/category_manager |

### Audit 3：DB & Data Integrity
- ✅ vfs/chat_v2/mistakes/llm_usage 全部 FK ON
- ✅ `file_repo` SAVEPOINT 模式、poison ROLLBACK 最佳努力
- ⚠️ 4 库分立但无跨库一致性事务（设计权衡 · 文档化即可）

### Audit 4：Frontend Performance
- 🔴 **CRITICAL**：`MarkdownRenderer.tsx` `pdfPageImageCache` 50 个 dataURL 常驻（25-50MB）
- 🟠 **HIGH**：vite.config `manualChunks` 缺 4 个重型依赖（xyflow/recharts/pdfjs/mermaid · ~1.2MB）
- 🟠 **HIGH**：`InputBarUI.tsx:562` FileReader 错误/取消分支 Blob URL 不释放
- 🟠 **HIGH**：`progressiveDisclosure.ts` `loadedSkillsMap` 按 sessionId 无上限累积
- ✅ MessageList 虚拟化（>80）、ChatV2Page 3170→1498、useShallow 21 文件、44+ memo、50+ lazy
- 巨文件 TOP 7：TauriAdapter 3944 / CrepeEditor 2857 / LearningHubSidebar 2797 / InputBarUI 2556 / QuestionBankEditor 2496 / McpToolsSection 2239 / DataImportExport 2234

### Audit 5：Backend Performance（13 项发现）
- 🔴 **CRITICAL**：`page_rasterizer` 全链路无 `spawn_blocking`（`question_import_service.rs:955-982` 是 async 调用方）
- 🔴 **CRITICAL**：`pdf_protocol.rs:227-228` `read_to_end` 全文件读入 + Tauri protocol 线程阻塞
- 🟠 **HIGH**：`reqwest::Client` 每次新建（`exam_engine.rs:48` 已有正确模式可参考）
- 🟠 **HIGH**：6 处 `unbounded_channel`（MCP/SSE/usage/multimodal）需加上限
- ✅ `pdf_ocr_service.rs` 架构正确（`spawn_blocking` + bounded + semaphore）
- ✅ ANR watchdog 已部署（10s 阈值合理）

### Audit 6：Chat V2 + LLM Pipeline（28 项发现）
- 🔴 **CRITICAL**：approval `scope_key` 用整 JSON、`chatanki_export/sync` 敏感度过低、`subagent_task` 状态机无守卫
- 🟠 **HIGH**：`chunkBuffer` 后备路径、`showParallelView` 死代码、`variants_json` 无字节限、branch 内嵌 ID 未重映射、persistence 逐块写入
- 12 LLM 适配器无统一流式测试夹具
- `chatanki_executor.rs:run_chatanki_pipeline_background` 单函数 3193 行（最高 ROI 拆分点）

### Audit 7：VFS + RAG Indexing
- `vfs/indexing.rs` 4632 行 · `vfs/handlers.rs` 7431 行（项目最大 Rust 文件）
- ❌ `cleanup_orphan` 无条件触发（应有 dry-run 或软阈值）
- ⚠️ 嵌入维度切换迁移路径文档不足

### Audit 8：Content Sub-applications（6 学习子应用）
- AnkiCardGeneration.tsx 4053 行 · QuestionBankEditor 2496 行
- ChatAnki/Mindmap/QuestionBank 工具链已成熟
- 错题/IREC 系统标记 deprecated 自 2026-01 但残留 ~500 行（86 处过期清理标记）

### Audit 9：i18n / a11y / UX
- ✅ fallbackLng `en-US`、pdfProcessingStore i18n 完成
- ⚠️ `check-i18n.mjs` 报告若干缺失键
- ⚠️ 自定义 `no-native-button` 规则 `warn` 而非 `error`

### Audit 10：Tech Debt
- 巨文件 ≥1500 行：25 个（vfs/handlers 7431 居首）
- 类型安全：712 `as any` + 81 `as unknown as` + `strict:false` + `no-explicit-any:off`
- console.log 生产代码：1142 处 + 无 `no-console` 规则
- 86 处过期清理标记（2026-01/02）
- 依赖：reqwest 0.11（unmaintained）、hyper 0.14（legacy）、rusqlite 0.29
- 测试覆盖：FE 14% / Rust 53%（按文件计）
- 重复代码：4 处 `max_tokens_per_chunk=6000` + 3 处 `segment_document` 实现 + dnd-kit/hello-pangea 双拖拽库

---

## 五、修复路线图

### P0 · 本周必修（CRITICAL · ~10h）
1. `memory/service.rs` 3 处 `.unwrap()` → `unwrap_or_else(|p| p.into_inner())`
2. `chatanki_export/sync` 敏感度 `Low → Medium`
3. `page_rasterizer` 全链路包 `spawn_blocking`
4. `approval_manager` `scope_key` 按工具提取关键字段
5. `subagent_task` 状态机加 `valid_transitions()` 守卫
6. `MarkdownRenderer pdfPageImageCache` → Blob URL 或降到 10
7. `vite.config manualChunks` 加 4 行（xyflow/recharts/pdfjs/mermaid）

### P1 · 本月（HIGH · ~20h）
8. `lance_vector_store` `block_on` → `block_in_place + Handle::try_current`
9. `LLMManager` 全局 `reqwest::Client` 单例
10. `chunkBuffer` 移除 `lastSetSessionId` 后备
11. branch session `tool_output` ID 重映射
12. 11 处孤儿 `tokio::spawn` 接入 `TaskTracker`
13. 6 处 `unbounded_channel` 改 bounded
14. `pdf_protocol read_to_end` 流式或限块
15. base64 IPC → file path

### P2 · 下季度（MEDIUM · sprint 级）
16. TypeScript strict 渐进开启
17. 巨文件拆分 TOP 5
18. 依赖升级（reqwest/hyper/rusqlite）
19. 错题/IREC dead code 清理
20. dnd-kit / hello-pangea 二选一
21. `no-console` ESLint rule
22. `database/mod.rs` 216 处 println! → tracing
23. `InputBarUI` Blob URL 错误分支释放
24. `loadedSkillsMap` LRU 上限
25. AnkiCardGeneration 4053 行 + LearningHubSidebar 2797 行 拆分

### P3 · 持续（LOW）
- 主密钥升级 KMS/Keychain
- `https://*/*` 通配收敛
- skill CDATA / 模板注入加固
- 12 LLM 适配器统一流式测试夹具
- 重复 chunking 逻辑提取共享 service

---

## 六、终审结论

v0.9.35 处于"准生产就绪"阶段：
- 架构正确性已稳固，过去 35 天 307 commits 修复了 prior audit 65% 的 TOP 项
- 剩余 17 个 CRITICAL/HIGH 集中、定位明确、修复成本低（P0 共 ~10h、P1 共 ~20h）
- v1.0 GA 路径清晰：完成 P0+P1（共 ~30h）即可消除所有当前已知严重风险

**关键观察**：
- 安全防线已多重加固，但用户 in-the-loop 审批系统出现两层弱化叠加
- CPU 异步化（page_rasterizer · base64 IPC）是单一最高 ROI 后端改造
- 类型安全治理（712 `as any`）是 sprint 级长期工作，不影响 v1.0
