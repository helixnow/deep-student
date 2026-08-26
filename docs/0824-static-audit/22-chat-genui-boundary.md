model=gpt-5.6-sol-xhigh-fast

# 22 — Step 20 Chat / GenUI 升级边界深挖（对照 v0.9.44）

- 范围：只审 Step 20 的 `rel-chat` 两个提交所声称的 Chat / GenUI 升级边界，并回到当前生产调用链核实；不把同一提交里的 InputBar 与 i18n 扫描扩成本文主结论。
- 方法：只读当前源码、测试与归并记录，并对照 `v0.9.44` 发布树；未执行 Git/gh，未运行测试。
- Step 20 记录：`docs/0824-MERGE-PLAN.md:925-929` 将 `6c9a231f` 落为 `249df98a`，再将测试提交 `8e6d8e8f` 落为 `71a51913`。

## 一、先校正“相对 v0.9.44 升级”的含义

`v0.9.44` 没有 `src/features/generative-ui/`、Chat 的
`plugins/blocks/generativeUI.tsx`、Rust `generative_ui_executor.rs` 或
`src-tauri/src/hpias/`。基线只有通用 `src/utils/guardedListen.ts`，其非聊天
白名单末项是精确的 `stream_error`，没有 `hpias_event`。

因此，Step 20 不是在迁移 v0.9.44 已持久化的 GenUI/HPIAS 数据：

1. v0.9.44 用户没有旧版 GenUI intent 或 HPIAS 会话格式需要自动升级；
2. 这些修改是在 0824 新增能力内部，收紧其进入发布树前的边界；
3. `migrateIntentToV11` 的“v1 → v1.1”指 **GenUI 文档协议版本**，不是应用
   `v0.9.44 → 0824` 的数据库或设置迁移。

这一区分很重要：当前不存在 v0.9.44 升级阻断，但也不能因为“基线没有该功能”
就把新增事件通道和导入格式当成天然全链安全。

## 二、HPIAS `session_id`：定向 handler 已收紧，Chat 生产链仍不是定向 handler

### 2.1 Step 20 实际修复成立

`createHpiasEventBridgeHandler({ sessionId })` 现在先规范化 payload，再对以下三种
情况一律返回：

- 没有 `session_id`；
- `session_id` 不是字符串；
- 字符串与请求的 `sessionId` 不相等。

证据在
`src/features/generative-ui/bridge/hpiasEventBridge.ts:96-121`；对应行为测试在
`tests/vitest/generative-ui/hpiasEventBridge.test.ts:36-62`，同时覆盖异会话、
缺 ID 和数字 ID。相对 Step 20 前“仅当事件恰有字符串 ID 且不等时才拒绝”的
逻辑，这确实堵住了缺失/畸形 ID 穿透**显式定向 handler**的漏洞。

但该公共 API 仍以 `if (options.sessionId)` 判断是否启用定向模式
（`hpiasEventBridge.ts:106`），显式空字符串会退化为不定向。Chat 产品入口的
ID 已先经 `extractResearchSessionId` 的非空、长度和字符集清洗，因此正常产品
调用不会产生空字符串；这仍是公共 helper 的精确边界。

### 2.2 不能外推成“Chat 生产事件全链 fail-closed”

真实 Chat 块在
`src/features/chat/plugins/blocks/generativeUI.tsx:44-65` 提取合法
`researchSessionId`，并把它传给 `useHpiasEventBridge`。然而 hook 只解构
`enabled`，没有消费 `sessionId`：

- `src/features/generative-ui/hooks/useHpiasEventBridge.ts:8-16`：类型保留
  `sessionId`，注释明确共享 listen 不按 session 过滤；
- `useHpiasEventBridge.ts:18-36`：生产 effect 调
  `retainSharedHpiasEventBridge()`；
- `hpiasEventBridge.ts:134-158`：共享桥固定调用
  `startHpiasEventBridge({})`，即创建**不定向** handler。

所以 Step 20 新增的缺 ID/非字符串 ID 拒收分支，在当前 Chat 生产订阅路径上
不会被启用。共享桥依赖 store 分流：

- 合法且不同的 `session_id` 只写对应 `sessions[id]` 切片并提前返回
  （`src/stores/researchStore.ts:241-268`）；
- 缺失、空或非字符串 ID 会得到 `eventSessionId = undefined`，随后进入活跃
  顶层 switch（`:243-278`）；
- `normalizeHpiasEventPayload` 仅确认 payload 是对象且 `type` 是字符串，随后
  直接断言成 `HpiasEvent`（`hpiasEventBridge.ts:75-87`），没有运行时判别联合
  校验。

因此，对任意通道 payload 而言，缺/坏 ID 的 `session_started`、`plan_generated`
等仍可能污染活跃顶层状态。Step 20 修的是“显式 scoped handler”，不是共享
生产路由的完整不可信输入边界。

### 2.3 正常 Rust 自产事件为什么仍可判可用

当前 Rust 正常链以生产者不变量补足上述边界：

- session/round/plan/retrieval/selection/subagent/synthesis/completed 等 builder
  都要求 `session_id: &str` 并写入 payload
  （`src-tauri/src/hpias/payloads.rs:108-233`）；
- 启动事件同样强制带 ID，且有单测断言
  （`src-tauri/src/hpias/events.rs:30-67`）；
- Chat executor 只有在存在合法 `researchSessionId` 且 intent 含 Research 块时
  才启动 HPIAS（
  `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:424-436`）。

但 `HpiasEventEmitter::emit_raw` 本身接受任意 JSON
（`src-tauri/src/hpias/events.rs:23-27`），前端事件联合也明确允许
`ingestion_progress` 无 ID、`session_failed`/`error` 可选 ID
（`src/stores/researchStore.ts:37-45`）。若未来要把通道提升为严格的不可信边界，
不能简单“一刀切所有无 ID 事件”，而应先区分全局事件和会话事件，再对后者做
运行时 schema + 必填 ID 校验。

结论是：**正常 Rust 自产链可用且跨会话切片成立；任意 payload 全链
fail-closed 不成立。**

## 三、`guardedListen`：精确通道成立，但 Step 20 主要是可测性，不是生产 ACL

当前实现将 `hpias_event` 与 `stream_error` 放入精确集合
`GUARDED_LISTEN_EXACT_NON_CHAT_EVENTS`，并用 `Set.has` 匹配
（`src/utils/guardedListen.ts:26-47`）。测试确认：

- `hpias_event` 放行；
- `hpias_event_private`、`hpias-event`、`prefix_hpias_event` 均不放行；
- 既有平台前缀仍保留。

证据为 `tests/vitest/guardedListenAllowlist.test.ts:8-24`。Step 20 后续测试又从
“源码是否包含字符串”改成直接执行 `isWhitelistedNonChat`
（`tests/vitest/generative-ui/generativeUIModuleIntegration.contract.test.ts:159-162`），
防回退质量更高。

这里有三条必须限定：

1. Step 20 前的 0824 中 `hpias_event` 已用 `n === 'hpias_event'` 精确匹配；
   改成精确集合没有改变 canonical/lookalike 的运行时集合。“只紧不松”是被行为
   测试锁定的约束，不是本步把前缀匹配改成精确匹配的产品修复。
2. 相对 v0.9.44，允许面不是“未变化”，而是为了新增 HPIAS 从零增加了一个
   **精确**通道；基线根本没有 HPIAS。
3. 阻断只在 `DEV && !legacy` 下执行
   （`src/utils/guardedListen.ts:50-67`）。生产构建仍直接调用 Tauri `listen`，
   因而该白名单是开发期架构断言，不是生产安全 ACL。

另需纠正一个容易混淆的口径：Step 20 的 `8e6d8e8f` 是 **HPIAS 事件通道
allowlist 的行为测试**，不是新增 Rust 的 18-block allowlist。18 种 GenUI 块的
入口白名单在当前树当然存在
（`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:19-42,105-118`），但归并
记录也明确说 Step 20 未触及该不变量（`docs/0824-MERGE-PLAN.md:950-955`）。

## 四、GenUI v1 → v1.1：直接 helper 无损，但宿主恢复链与生产接线要另算

### 4.1 直接调用的修复正确

`migrateIntentToV11` 现在：

- 递归复制数组和普通对象，避免迁移结果与源 intent 共享嵌套引用
  （`src/features/generative-ui/utils/migrateIntentToV11.ts:24-34`）；
- 复制整个顶层文档和整个 block，只覆盖 `version`、规范化 `layout`/`span`，
  因而保留未知的加法字段（`:51-77`）；
- 对 layout/列宽/span 仍钳制到既定 `1|2|3`，不把模型 class 透传。

测试覆盖嵌套对象不回写源数据，以及顶层 `vendorDocumentState`、块级
`vendorState` 的保留
（`tests/vitest/generative-ui/migrateIntentToV11.test.ts:72-114`）。
作为**直接 helper 契约**，Step 20 修复成立。

该深拷贝明确以 JSON-compatible intent 为前提；循环引用、`Date`、class 实例等
非 JSON 值不属于承诺面。这与 intent 的传输/导入格式一致，不构成缺陷。

### 4.2 “无损升级”不能覆盖 `normalizeGenerativeUIIntent` 全链

当前 `src/` 内，`migrateIntentToV11` 唯一的非定义调用点是
`normalizeGenerativeUIIntent.ts:155-156`；全产品源码没有直接业务调用
`migrateIntentToV11`，也没有业务调用以 `migrateToV11: true` 启动该路径。
所以它目前是公开且有测试的能力，不是应用启动或聊天记录加载时自动执行的升级器。

即便未来从稳定 normalize 入口调用，恢复步骤也会先丢加法字段：

- `normalizeGenerativeUIIntent.ts:126-156` 先调用
  `coercePartialIntent`/`recoverGenerativeUIIntent`，最后才调用 migrator；
- `recoverGenerativeUIIntent` 逐块走 Zod，并在返回值中只重建
  `version/layout/blocks/meta`
  （`src/features/generative-ui/schema.ts:276-339`）；
- `generativeBlockIntentSchema` 只声明 `type/props/id/span`
  （`schema.ts:43-49`），未知块级字段会在 migrator 之前被剥离。

因此 Step 20 测试证明的是“直接 migrator 保留加法字段”，不能证明
“导入/恢复/normalize → migrate 全链保留加法字段”。现有 normalize 测试只比较
迁移后的标准字段
（`tests/vitest/generative-ui/normalizeGenerativeUIIntent.test.ts:134-156`），没有
用 `vendorDocumentState/vendorState` 穿过完整入口。

### 4.3 开放文档迁移与封闭模型入口是有意的两条边界

- 直接 migrator 保留 `future-widget` 和加法字段，前端 renderer 对未注册 type
  显示 warning Alert，不执行未知组件
  （`src/features/generative-ui/GenerativeUIRenderer.tsx:389-401`）；
- Chat 模型工具入口则只接受恰 18 种块，未知 type、缺 type、非对象块均拒绝
  （`generative_ui_executor.rs:23-42,105-118`），并在成功事件发射前完成校验
  （`:79-102`）。

这不是矛盾：持久化/导入侧可以为前向兼容保留未知数据，实时模型执行侧必须
closed-world。问题只在于“无损”一词目前只能用于直接 helper，不能用于整个恢复链。

## 五、相对 v0.9.44 的升级判定

| 边界 | 相对 v0.9.44 | Step 20 后当前态 |
| --- | --- | --- |
| GenUI/HPIAS 能力 | 基线不存在 | 新增能力，不涉及旧 GenUI 数据迁移 |
| `hpias_event` 通道 | 基线未放行 | 新增一个精确通道；lookalike 行为测试锁定 |
| scoped `session_id` | 基线无该桥 | 显式 scoped handler 对缺/坏/错 ID fail-closed |
| Chat 生产订阅 | 基线无该链 | 共享 unscoped listener + store 切片；依赖 Rust producer 不变量 |
| v1 → v1.1 | 基线无 GenUI 文档 | 直接 helper 深拷贝并保留加法字段；尚非自动产品升级 |
| 18-block ingress | 基线无 executor | 当前恰 18 且未知型拒绝；不是 Step 20 新增语义 |

从“v0.9.44 用户能否升级并使用”看，没有发现阻断：旧版没有待迁移 GenUI 状态，
新增 Rust 正常事件带 ID，Chat 对合法 ID 才开启研究面板，未知模型块在后端拒绝。

从“Step 20 是否建立了完整边界”看，原有笼统 `PASS` 口径过强：

1. scoped handler 的 fail-closed 未进入实际共享 Chat 订阅；
2. `guardedListen` 只在开发期断言；
3. migrator 的加法字段保留既未接到产品自动升级，也不能穿过现有 normalize/recover
   全链。

## 风险与是否需要产品修复

1. **中，非 v0.9.44 升级阻断**：若产品目标是“通道 payload 本身不可信”，需要
   后续把全局事件与会话事件分型，并在共享桥/store 前做运行时 schema 校验；不能
   直接删除无 ID 的合法全局事件。
2. **中，契约口径/未来导入风险**：若承诺导入或持久化 GenUI 文档“加法字段无损
   升级”，需要让 recover/normalize 保留这些字段并增加端到端测试，同时明确实际
   产品调用点。若只承诺直接 helper，则应收窄文档措辞，无需改实现。
3. **低**：`guardedListen` 的 dev-only 性质应继续被视为架构断言，生产安全不能
   依赖它。
4. **本次发布升级无需强制产品修复**：v0.9.44 无 GenUI/HPIAS 旧状态，当前正常
   Rust → Chat 链满足 ID 不变量。上述两项中风险属于后续边界加固或契约澄清，不应
   冒充已被 Step 20 全链解决。

## 结论

**WARN（边界口径），不是 v0.9.44 升级 FAIL。**

Step 20 的直接改动本身正确：显式 scoped HPIAS handler 已拒绝缺失、非字符串和
错会话 ID；`hpias_event` 以精确名称加入新增能力的开发期白名单并由行为测试锁定；
直接 `migrateIntentToV11` 已深拷贝且保留加法字段。相对 v0.9.44 没有旧 GenUI
数据迁移阻断，也未发现新增 18-block 入口被放宽。

但不能把这些事实外推为“Chat 生产共享订阅对任意 payload 全链 fail-closed”或
“所有导入/恢复路径均无损升级”：生产 hook 使用 unscoped 共享桥，normalize/recover
会先剥离未知加法字段，且迁移 helper 尚无产品调用点。故总体判为 WARN，要求后续
按目标选择“补全生产边界”或“收窄契约表述”，本次 v0.9.44 升级不要求阻断性修复。

**本轮不改代码**。
