# 0824 Step-3 Anki 合并预演（第六轮）

日期：2026-08-24  
分支：`cursor/0824-rehearse-step3-anki-cde6`

## 范围与结论

- 基线：`origin/cursor/0824-cde6` @ `af3e39d8`
- Anki 主题（D）：`origin/cursor/0824-theme-anki-cde6` @ `07146ea9`
- 优先参考：`origin/cursor/0824-rehearse-wrapup-anki-cde6` @ `051c06e7`
- 补充参考：`origin/cursor/0824-rehearse-step2-anki-cde6` @ `884f402d`
- 合并提交：`428b0625`
- 未修改或推送 `main`、`cursor/0824-cde6`。

合并完成，Anki 的结构化协议、QA/critic、文档级重复检测、偏好反馈和图片遮挡能力均保留；
最新 0824 基线中的 A、H 缓存及 Generative UI i18n fallback 也保持不变。

## 冲突解决

本轮共解决 4 个文本冲突，均复用已验证的 wrapup/step2 Anki 裁决：

1. `src-tauri/src/streaming_anki_service.rs`
   - 保留 Anki 的协议解析、字段 QA、critic、指纹去重、图片遮挡字段合并和解析内环测试。
   - 保留基线的模型特殊 token 收尾过滤与不可修复错误卡过滤。
   - 去除双方重复 helper，采用保守清理：只丢纯 token 残片或剥离完整 JSON 外包装，
     不全局删除卡片正文中的字面 token；截断 JSON 仍进入修复路径。
2. `tests/vitest/anki/cardforge/CardAgent.test.ts`
   - 保留空闲超时返回 `ok:false` / `timedOut:true` 的契约，并对齐当前
     `生成空闲超时` 文案。
3. `tests/vitest/chat-v2/plugins/blocks/AnkiCardsBlock.test.tsx`
   - 保留接近真实 i18n 行为的 `{{var}}` 插值与 `defaultValue` fallback。
4. `tests/vitest/chat-v2/skills/chatAnkiAgentLoop.test.ts`
   - 保留 allowlist 与 embedded schema 的双向集合一致性检查及必需 CRUD 工具检查，
     不使用脆弱的固定工具数量断言。

## Generative UI 闪卡边界

沿用只读闪卡裁决：

- `5ddafc1a`：移植 step2 的 `f352403c`，让 `flashcard-preview` 只负责展示。
- `f874e2ed`：移植 step2 的 `40265239`，删除两侧 locale 死键和对应测试 mock。
- 移除 Generative UI 自有 `save-to-library` handler、卡片提取/转换路径和保存接线；
  保存、QA/critic 与审计统一由 `anki_cards` 管线负责。
- `resolveGenerativeUIChatActionHandlers.ts` 保留最新基线的 `fallbackLabel` 及全部
  Notes/Research/Copy fallback，同时不再注册任何闪卡保存 handler。
- E0515 借用修复已由基线 `2f7eec54` 等价包含，无需重复移植。

全库复核仅剩两类同名但合法的非 GenUI 路径：`common.json` 的错题本保存文案，以及
`chatAnkiIntegrationTestPlugin.ts` 的 `anki_cards` 保存场景。

## 验证

以下编译门禁通过：

```bash
npm ci
npm run version:generate
npm run typecheck
npx vite build
cargo +stable check --manifest-path src-tauri/Cargo.toml --lib
```

- TypeScript 类型检查通过。
- Vite 完成 19,736 个模块的生产构建，仅有既有 chunk/circular-import 告警。
- Rust stable 1.98 库编译通过，产生 27 项既有非阻断 warning。

受影响回归通过：

```bash
npx vitest run <10 个 Anki/GenUI 受影响测试文件>
npx vitest run tests/vitest/generative-ui/generativeUiI18n.parity.contract.test.ts
cargo +stable test --manifest-path src-tauri/Cargo.toml \
  --lib streaming_anki_service::tests -- --nocapture
```

- Anki/GenUI：10 个文件、108 项测试通过。
- Generative UI i18n parity：6 项测试通过。
- Streaming Anki：74 项测试通过，0 失败。

环境准备使用 CI 对齐的 Linux Tauri 系统依赖和目标平台 PDFium。下载脚本会重写已跟踪的
`licenses/pdfium.txt` 格式；验证后已恢复基线版本，未将该环境副作用带入提交。`npm ci`
报告 12 个既有审计项，本轮未改依赖。
