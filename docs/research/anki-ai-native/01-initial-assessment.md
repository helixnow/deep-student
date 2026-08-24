# 01 — Anki 制卡 AI-Native 初版评估

## 1. 完整生成流程

```
用户输入（PDF/图片/文本/APKG）
    ↓
ChatAnki Skill 激活（LLM Agent）
    ↓
builtin-chatanki_run / start  →  立即返回 documentId + ankiBlockId
    ↓
[后台 Rust 管线 — Agent 不可改写]
    ├─ decide_route() 启发式路由（simple_text / vlm_light / vlm_full）
    ├─ VFS 资源解析 + OCR/VLM 提取
    ├─ DocumentProcessingService 规则分段（+ 可选 LLM 定界）
    ├─ EnhancedAnkiService 并发任务调度
    ├─ StreamingAnkiService LLM 流式生成
    ├─ <<<ANKI_CARD_JSON_END>>> 分隔符解析入库
    └─ anki_generation_event → 前端流式 patch
    ↓
Agent 验收闭环
    ├─ builtin-chatanki_wait
    ├─ builtin-chatanki_get_cards（分页读回）
    ├─ update / delete / add / retemplate 修正
    └─ export / sync / enqueue_review 交付
```

## 2. 架构分层

| 层级 | 组件 | AI-Native 程度 |
|------|------|----------------|
| Agent 编排 | `chatanki` skill, 28 tools | ⭐⭐⭐⭐ 高 |
| 内容理解 | LLM 生成 + VLM 读图 | ⭐⭐⭐⭐ 高 |
| 流程决策 | `decide_route` 启发式 | ⭐⭐ 低 |
| 分段策略 | 规则 + 可选 LLM 定界 | ⭐⭐⭐ 中 |
| 生成执行 | 固定 Rust 管线 | ⭐ 非 script-native |
| 质量保障 | Agent 外部验收循环 | ⭐⭐⭐ 中 |
| 脚本/transform | 不存在 | ❌ |

## 3. 「Agent 现写脚本」对照

### 3.1 项目已有的 script-native 基础设施

```rust
// local_shell_execute + shell_sandbox（macOS Seatbelt / Linux bwrap / Windows AppContainer）
// runtime_roots 授权白名单
// workspace_change_set 可审计回滚
```

```typescript
// CardForge 设计原则（src/components/anki/cardforge/index.ts）
// "任何需要理解或决策的工作，都应该交给 LLM 完成"
// "制卡是 AI Agent 可调用的工具"
```

### 3.2 Anki 路径的实际行为

Agent **可以**：
- 决定何时制卡、选模板、设 goal
- 启动后台管线并等待
- 读回卡片逐张验收修正
- 导出/同步/入队复习

Agent **不能**：
- 改写分段/路由/生成策略
- 提交 Python/JS 脚本做批量文本变换（挖空、格式统一）
- 动态增删 pipeline 步骤
- 在生成时内置 self-critique（依赖外部 get_cards 循环）

### 3.3 结论

**设计理念（CardForge LLM-First）与生产实现（Rust 固定管线）存在 gap。**

项目整体是 AI-native 工作台（VFS + 50+ tools + shell sandbox），但 Anki 制卡模块选择了 **「Agent 编排 + 预编译 Pipeline」** 而非 **「Agent 现写脚本 + 动态 plan」** 路线。这在可靠性/性能上有优势，但在灵活性和 SOTA agent 范式上落后。

## 4. AI-Native 评分：6.5 / 10

### 加分项
- 28 工具完整 CRUD + CAS 乐观锁 + 会话/库双作用域
- 标准 Agent 循环：generate → wait → verify → fix → deliver
- 后台异步 + 流式 UI + 非破坏性取消
- 多模态路由 + 多模板 LLM 自选

### 扣分项
- 核心 pipeline 不可由 Agent 重组
- 路由/分段/analyze 大量启发式规则
- 无 Agent 动态脚本工具
- 质量评估依赖 Agent 外部循环
- JSON 分隔符解析 vs Native Structured Output

## 5. 关键代码位置

| 功能 | 路径 |
|------|------|
| Agent 工具定义 | `src/features/chat/skills/builtin/index.ts` |
| 后台管线 | `src-tauri/src/chat_v2/tools/chatanki_executor.rs` |
| 路由启发式 | `chatanki_executor.rs:7701` `decide_route()` |
| 流式生成 | `src-tauri/src/streaming_anki_service.rs` |
| CardForge 入口 | `src/components/anki/cardforge/engines/CardAgent.ts` |
| 工具契约文档 | `docs/anki-agent-tools.md` |
