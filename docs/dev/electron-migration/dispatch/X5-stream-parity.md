# X5-stream-parity：聊天流式事件全链路对齐

目标：聊天是核心体验。证明从 chat 管线产生的流式事件，经 Host → Electron 事件桥 → 前端 TauriAdapter，事件名、payload 形状、顺序、终止语义与 Rust 版完全一致。

## 交付（只写 `host/e2e/streaming/` 与 `docs/dev/electron-migration/audits/X5-stream-parity.md`）
1. 从 Rust 源码（`src-tauri/` 的 chat_v2 管线与事件发射处，只读）整理权威事件规格：事件名模板、每类事件的 payload 字段与类型、发射顺序（stream_start → block start/chunk/end → stream_complete / error / cancel 等）、取消与错误时的收尾事件。与前端 `src/` 中 TauriAdapter 的消费逻辑交叉核对（前端是事实上的契约）。
2. 端到端测试：在测试宿主中加载真实的 chat-pipeline / chat 及其依赖插件，用一个**确定性的假 LLM 适配器**（只在测试中，经 llmAdapters 的公开注入点替换，产出固定 token 序列、工具调用、思维链、错误、取消）驱动一次完整发送，捕获 Host 发出的全部事件序列，与规格逐项断言（名称、字段、顺序、终止）。覆盖：普通回答、思维链、工具调用往返、出错、用户取消、重试/变体。
3. 若存在前端的事件消费单元测试或 demo 剧本（`src/demo/scriptPlayer.ts` 的事件序列是生产事件的样例），用它们作为额外的对照样本。
4. 不改管线代码：不一致写进报告，按归属 lane（L03/L04 等）分组，附最小复现。

完成后贴出：覆盖场景、事件规格条数、不一致清单。
