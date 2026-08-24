# WRAP-WI-12：Session JSONL 导出验收

> 验收代理：SA-WRAP-WI12  
> 分支：`cursor/optimization0824-5575`  
> 结论：通过；WI-12 已完整实现，不再含 stub / `todo!` / ignored test。

## 验收结果

1. `src-tauri/src/chat_v2/session_export.rs` 是可运行实现：
   - 按 `header (message block*)* compaction* footer` 流式写出 JSONL；
   - 默认递归脱敏，并剥离技能全文快照与附件 `previewUrl`；
   - 支持全变体/激活变体、session state 与 compaction 开关；
   - not-found、缺块和写入失败均有明确处理。
2. 单测全部启用，无 `#[ignore]`：
   - 原有测试已覆盖行序、round-trip、redact、not-found、缺块、选项开关和
     IO 错误；
   - 本次补充空会话测试，确认仅输出 header/footer、计数全零且末尾保留 LF。
3. Tauri command `chat_v2_export_session_jsonl` 已完成三层接线：
   - `handlers/mod.rs` 重导出；
   - `lib.rs` `generate_handler!` 注册；
   - `permissions/application-commands.toml` ACL 放行。
4. `WI-12-session-jsonl-spec.md` 状态为 `Implemented`。本次补充可直接复制的
   TypeScript `invoke` 示例，明确 camelCase 参数、绝对 `.jsonl` 保存路径和
   产品 UI 必须保持 `redactSecrets: true`。

## 补洞内容

- 新增 `export_empty_session_writes_header_and_zero_count_footer`；
- 在规范 §6 新增前端调用示例；
- 未发现或保留任何 WI-12 stub。

## 验证

- `cargo test --lib session_export`：11 passed，0 failed，0 ignored；
- `cargo check --lib`：通过。
