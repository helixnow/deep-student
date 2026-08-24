# 0824 wrapup + Anki 合并预演

日期：2026-08-24  
分支：`cursor/0824-rehearse-wrapup-anki-cde6`

## 范围与结论

- 基线：`origin/cursor/0824-rehearse-wrapup-cde6` @ `fe71256a`
- Anki：`origin/cursor/0824-theme-anki-cde6` @ `07146ea9`
- 参考：`origin/cursor/0824-rehearse-anki-cde6` @ `8d7eb165`
- 合并提交：`177bdea9`
- 未修改或推送 `main`、`cursor/0824-cde6`。

合并完成。Anki 的产品、QA、grounded critic、结构化输出和图片遮挡能力均保留；
wrapup 的特殊 token 过滤、流式空闲超时和残片修复语义也保留。旧
`ChatV2AnkiAdapter` 没有恢复，生产代码中只剩解释历史路径的注释。

## 冲突解决

共解决 4 个文本冲突：

1. `src-tauri/src/streaming_anki_service.rs`
   - 保留 Anki 的 `anki_protocol`、字段 QA、文档级重复检测、critic、金标引用、
     图片遮挡字段合并和完整解析内环测试。
   - 保留 wrapup 的特殊 token 收尾过滤和不可修复错误卡过滤。
   - 双方曾独立加入同名 token helper；合并时去除重复定义，采用保守语义：
     只丢纯 token 残片或剥离完整 JSON 外包装，不全局替换正文中的字面 token，
     截断 JSON 仍可进入修复路径。
2. `tests/vitest/anki/cardforge/CardAgent.test.ts`
   - 保留空闲超时是 `ok:false` 的 wrapup 契约，并对齐当前实现的
     `生成空闲超时` 错误文案。
3. `tests/vitest/chat-v2/plugins/blocks/AnkiCardsBlock.test.tsx`
   - 保留 Anki 测试所需的 i18n 插值行为，不削弱 wrapup 的 block 状态覆盖。
4. `tests/vitest/chat-v2/skills/chatAnkiAgentLoop.test.ts`
   - 采用 allowlist 与 embedded schema 双向集合一致性检查，避免固定工具数量
     在后续扩展时产生脆弱断言，同时保留必需 CRUD 工具检查。

## GenUI 闪卡边界

复用参考预演的只读策略，提交为 `976d5e53`：

- `flashcard-preview` 只负责展示，不再生成 `save-to-library` action。
- 移除 GenUI 自有保存 handler 和卡片转换路径。
- 保存、QA/critic 和审计统一由 `anki_cards` 管线负责，避免双保存和绕过质检。
- 增加防回归契约，外部 intent 即使携带旧 action 也不会注册保存 handler。

Rust 单测编译额外暴露了临时 JSON 值借用错误；`683d7733` 将断言改为从
`Option<Value>` 借用，避免返回悬垂引用。

## 验证

以下门禁通过：

```bash
npm ci --legacy-peer-deps
npm run version:generate
npm run typecheck
npm run typecheck:native
npx vite build
cargo +stable check --manifest-path src-tauri/Cargo.toml --lib
cargo +stable test --manifest-path src-tauri/Cargo.toml \
  --lib streaming_anki_service::tests -- --nocapture
```

- TypeScript：`tsc` 与 `tsgo` 均通过。
- Vite：19,736 个模块完成构建。
- 冲突与 GenUI 覆盖：9 个 Vitest 文件、90 项测试通过。
- Rust 库编译通过；streaming Anki 74 项单测全部通过，覆盖 token、流式切卡、
  结构化 wrapper、QA、文档指纹和图片遮挡。
- 环境使用 stable Rust 1.98、CI 所列 Linux Tauri 依赖和目标平台 PDFium。
- npm 报告 12 个既有审计项；Vite/Rust 仅有既有 warning。

附加的 `cargo +stable fmt --check` 会要求格式化 Anki 主题带入的多份模块和测试；
本预演未夹带大范围纯格式变更。正式合并若以当前 stable rustfmt 为阻塞门禁，
应单独做机械格式化提交。
