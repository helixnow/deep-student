# X2 定向复核移交：契约正确性与 Host 差异分开

基线：main `9c13dfc39` 已通过 merge `3dd266634` 集成本分支；旧全量 JSON 标注 `e139c9716`（首份移交误写成工具提交 `5e55a95f9`，本条订正），本轮不全量重扫。编号和完整证据见同目录 `reviewed.json`。不改前端，不改独立验收勾选。

## X2-R04 → F5 / L10（扫描器误报修复，不要求修改契约）

`CanvasAIEditRequest` 的 content/search/replace/isRegex/section：Rust `src-tauri/src/chat_v2/tools/canvas_executor.rs:77-90` 都有 skip_serializing_if=None。契约 `contracts/ipc/L10-notes.json:4213-4288` 已标 x-option=omit，同时 anyOf 包含 null 以接受 Deserialize 输入。旧 X2 错把输入可接受 null 当成 Rust 一定能输出 null，导致 5 条 payload-mismatch。

本轮修复只在 `compareShapes` 的 **source/producer** 侧遵守 x-option=omit，不缩窄 target/consumer；F5 无需把双向契约强改为不能接收 null。其余真实契约问题仍需逐一核 Rust，未新增“F5 已修全部契约”的结论。

Canvas emitter：已读 L10 SPEC/LANE 并独立查源码。Rust execute_write_frontend 仅剩声明（:1647），当前 execute 写入通过 probe/apply_ops（:704-711,:1529）。Host `CanvasToolExecutor.tryFrontendDelegate → acrBridgeCall('apply_ops')`（canvas-tool.ts:644-768）同路线。纯构造器、旧 Rust 发射函数、前端监听器的存在不构成“Host 必须发 canvas:ai-edit-request”。这个旧 unproven 不能分发为新增 emitter 的任务；其他路径未验证仍如实保留。

## X2-R02/R03 → L10 / C1

- notes_save_asset：前端 imageUpload.ts:161-169 同时传正确 camelCase 与 snake 别名；保持 redundant-alias，不是 Host 缺陷。
- notes_list_deleted：前端 notesApi.ts:260 只有 page_size；原 Rust 无 rename_all 覆盖，Tauri 默认读取 pageSize，Option 缺失使用 20（notes.rs:1782-1798）；契约和 Host index.ts:259-260 都正确。是既有前端键名/分页行为问题，不要求 Host 新增别名，也不把它写成 invoke 必然失败。本 lane 不修改前端。

## X2-R05 → F5 / L18 / F1 / F7

- HEIC 契约正确标 Request 注入和 result.x-binary=true（L18 JSON:210-235），不是漏掉 args 对象字段，也不是普通 JSON 返回。
- 前端 invoke<ArrayBuffer>('convert_heic_to_jpeg', bytes) 仅在 Android Tauri 分支可达（heicConversion.ts:187-203）。Rust 验证 raw bytes 后：Android 返回 raw JPEG；其他平台返回 HEIC_UNSUPPORTED_PLATFORM（heic_decoder.rs:53-83,130-140）。
- 当前 media 插件不注册该命令；F7 nativeHeic helper 有桌面拒绝分支但不是注册命令，F1 返回路径仍经 toWireJson（commands.ts:204-216）。这是 Host 接线/二进制传输边界，不是要求改前端传对象或要求 F5 把 binary 改成 JSON。
- Linux 本轮没有 Android codec、macOS/iOS WebView 或 Windows 原生运行验证；也没有执行 raw 成功 invoke，不能签收跨平台等价。

完整旧全量统计仅作历史；当前定向修订不应据局部问题消除而重新计算全局“通过率”。

## R06 派工更正（C1 补证，纯文档续作）

preview 命令已在 `inventory/unassigned.txt:36` 和本 lane 外的历史审计 `host/plugins/integration/audit/commands.json:4,330-337`（undefinedCommands）归为未定义历史命令。
`NoTagTreeShadPanel.tsx:180` await 前置 invoke，not-found 经 graphApi.ts:817-819 重抛后进入 :210 catch，不会到达 :187 的订阅。
动态成功通道仍 unproven；**不向 L17 新派生成器/发射器任务**，不改前端/契约让迁移变新功能。完整更正见 REVIEW.md R06 / reviewed.json。
