# 流式卡顿与内存优化方案（2026-09-24）

## 背景

四路代码探索（前端流式链路 / 渲染管线 / Rust 后端 / 前端内存状态）确认：

### 流式卡顿根因链（按贡献度排序）

1. **后端逐 SSE delta 发 IPC**：`chat_v2/events.rs:996` 每个 delta 一次 `window.emit`（JSON 序列化+跨进程+JS 回调），无批处理。工具参数已有 500 字符节流先例（`llm_adapter.rs:1385`），正文/思考没有。多变体 ×N。
2. **活动 markdown 块每 32ms 全量重解析**：`MarkdownRenderer.tsx` 全管线（preprocess 正则 ~10 趟 + remark/rehype），长段落活动块内 O(n²)。
3. **流式 MessageItem 整组件重渲染**：`MessageItem.tsx:185` 按整条消息订阅 block 对象，每次 flush 换引用 → ~30 hooks + 分段归组全重跑。
4. **flowtoken AnimatedMarkdown**：流式期间自带 react-markdown@9 第二份全量渲染 + 逐词 CSS 动画。
5. **跟随滚动**：每 flush 一次 `scrollTop=scrollHeight` 强制布局（标准做法，次因）。

### 内存根因（高严重度）

- M1 附件 `previewUrl` base64 多重副本（前端）
- M2 整 PDF/整图 base64 走 IPC（后端，已有 filestream/pdfstream 协议却绕开）
- M3 `temp_sessions` HashMap 无界（后端）
- M4 PDF 300DPI 位图瞬时尖峰（后端）
- M5 单会话已加载消息无上限（前端）

### 中等：M6 每秒轮询/定时器、M7 parse_document 无 spawn_blocking、M8 生产 logChatV2 存储+裸 console、M9 lance/reranker 新建 Runtime、M11 流式热路径 mutex 链+stdout flush、M12 persist 无 partialize。

## 已确认不是问题的部分

列表已虚拟化（80 条阈值）+ memo 到位；KaTeX 懒加载+LRU；mermaid/vega 等全懒加载；代码块无 hljs/shiki；持久化只在轮次边界写库；chunkBuffer 32ms 批处理、selector 订阅、节流 autosave 均已正确。

## 实施计划（分批，每批独立可测、可回滚）

### 批次 1a：后端 emit_chunk 时间窗合批
- 在 `EventEmitter` 增加 content/thinking chunk 的合批缓冲：同 block 的 content/thinking delta 累积 ~24ms（略低于前端 32ms 窗口）后合并为一个 chunk 事件发出。
- 非文本类事件（工具调用、状态、完成、错误）不缓冲，立即发，保证控制面时序不变；任何"非 chunk 事件"发出前先冲刷对应缓冲，保证事件顺序。
- 关键正确性约束：stream 完成/错误/取消路径必须冲刷缓冲（否则尾部内容丢失）；序列号分配保持单调。
- 测试：Rust 单测验证同块多 delta 合并、跨块不合并、非 chunk 事件触发冲刷、完成时尾部冲刷、顺序保持。

### 批次 1b：前端活动块降频 + flowtoken 降级
- chunkBuffer 的 content/thinking flush 窗口 32ms → ~120ms（保留 4KB 大小冲刷），人眼无感，解析次数降 ~4 倍。
- 流式期间 flowtoken `AnimatedMarkdown` 降级为普通 `MarkdownRenderer`（`isStreaming` 时不走动画路径），完成后再启用动画。
- 测试：chunkBuffer 单测（窗口/大小冲刷）；FlowTokenMarkdownRenderer/StreamingBlockRenderer 相关测试更新。

### 批次 1c：MessageItem 订阅收窄
- 流式消息的 block 订阅改为按 blockId 列表订阅元数据（长度/类型指纹），活动块内容走 BlockRendererWithStore 的单块订阅；分段归组结果按 blockIds+长度指纹 memo。
- 测试：MessageItem/BlockRenderer 现有测试保持绿；新增流式期间父组件不因内容 flush 重渲染的渲染计数测试。

### 批次 2：内存（低风险两项）
- `temp_sessions` 加 LRU（容量上限，如 8）+ 惰性过期（如 30min），clone 改按需。
- `parse_document_from_path`/`parse_document_from_base64` 包 `spawn_blocking`。
- 测试：temp_sessions 容量/过期单测；parse 命令现有测试保持绿。

### 批次 3：减负
- 共享时钟 hook（1s tick 单例），替换 useAllSessionIds/useSessionStats 轮询与组件内 `setInterval(now,1000)`。
- 生产关闭 `logChatV2` 存储（storageEnabled 随 DEV），eventBridge 裸 console 收敛到 debugLog。
- 测试：相关 hook 测试；logger 行为测试。

## 明确不做（本轮）

- base64 IPC 全面改造（M2，涉及协议层，风险大，单独立项）
- 会话消息内存窗口（M5，涉及历史分页交互）
- pdfium DPI 调整（影响 OCR 质量，需实机验证）
- opt-level "s"→3（包体积权衡，单独评估）
