# 0824 leftover 审计：#214 GenUI/HPIAS（`refs/pull/214/head`）

日期：2026-08-25

## 结论

- 审计对象：PR #214 头 `c2786d4b602c8271db0ad116aeb37b3c04fad5b5`，相对
  `origin/cursor/0824-cde6`（官方基线，`188500e0`）共 **30 个独有提交**。
- 官方基线与 `cursor/0824-leftovers-safe-cde6` 已吸收全部 GenUI/HPIAS 产品语义：
  逐项在基线源码核对（executor 256k/256KiB 上限、18 块白名单、noteEdit 字段
  白名单与 regex 拒转、researchSessionId 清洗、hpiasSessionSlice 多会话隔离、
  style/srcdoc/ping/background 清洗、空 ActionBar 跳过、undo 隔离、Tauri e2e
  未知块拒收等标记全部命中），且 `docs/dev/0824-leftover-audit.md` 第八轮
  INCLUDE 表已按 clean SHA 逐一重放同一批语义。
- 按指示 **DROP 八分片 CI 及其依赖项**：A 的四分片 + `--logHeapUsage` +
  job 级堆配置为准；#214 上为伺候八分片而刷新的 shard 契约、worker 堆、
  Windows UA 钉死等一律不取。
- 处置总计：**INCLUDE 1 / ALREADY 23 / DROP 6**。
- 唯一 INCLUDE 为 `0033879c` 的局部：`generative-ui` 技能在
  `src/locales/{en-US,zh-CN}/skills.json` 的 `builtinNames` /
  `builtinDescriptions` 条目。官方与 leftovers-safe 均缺失该 key；消费方
  （`GroupEditorDialog` / `ToolOutputView` 按 `skills:builtinNames.${id}`
  查找并回退 `skill.name`）纯增量取用，无任何契约测试受影响。该提交其余
  部分（八分片 shard 契约刷新、`i18n.source.test.ts` 路径改写、i18next
  mock 加固）均为八分片依赖，不取。

## 完整 SHA 处置表（30 个，按提交顺序）

| # | SHA | 主题 | 处置 | 依据 |
|---|---|---|---|---|
| 1 | `95e59c3b` | docs: Round 50 leftover-gap 记录 | DROP | 官方 docs 线（Wrap-up + Round 49）已自成谱系；实质修复已吸收，历史轮次记录过时 |
| 2 | `ab8136c1` | test: restoreAllMocks 不再清掉 matchMedia | ALREADY | leftovers-safe 第八轮 `eb5279b4`（matchMedia 测试设置）；基线 genui 测试已无该 restoreAllMocks 形态 |
| 3 | `5eb77f60` | note-edit regex 禁止转发 HITL | ALREADY | 基线 `dispatchCanvasAIEditRequest.ts` 含 schema 防线且已再演进（i18n 文案）；Rust 端 `parse_note_edit_rejects_regex_flag` 在位；audit `814d0a28` |
| 4 | `76dab6ad` | Rust noteEdit 256 KiB 上限 | ALREADY | 基线 `MAX_NOTE_EDIT_INPUT_BYTES = 256*1024`；audit `1bff7e7d` |
| 5 | `992bfd4d` | Rust noteEdit 字段白名单 | ALREADY | 基线 `parse_note_edit` 仅收白名单字段进 `sanitized`；audit `ec3fea5d` |
| 6 | `f1870107` | TS/Rust researchSessionId 清洗 | ALREADY | 基线 `sanitizeResearchSessionId` + `MAX_RESEARCH_SESSION_ID_LENGTH`；audit `eae6f682` |
| 7 | `03ce657f` | 拒绝超 256k 完整 intent | ALREADY | 基线 `MAX_GENERATIVE_UI_INTENT_CHARS = 256_000`；audit `ed71df1b` |
| 8 | `c96b05b1` | stream-buffer-capped 解析错误分类 | ALREADY | 基线 `classifyGenerativeUIParseErrors` 含 `buffer-capped` 分类；audit `99740c0b` |
| 9 | `54c1eb38` | Rust/lint/vitest OOM 修复 | ALREADY | 产品部分（parser/schema/registry/renderer）已吸收；audit `50f065aa`；vitest OOM 编排由 A 四分片取代 |
| 10 | `73a84dbe` | sessionId 契约与 sanitizer 加固 | ALREADY | 基线 `hpiasEventBridge` 按 sessionId 过滤、markdown sanitizer 加固在位；audit `fa6fb8cd` |
| 11 | `98cb146f` | HPIAS session 隔离与 host action 包裹 | ALREADY | 基线 sanitizeGenerativeMarkdown / Panel / chat block 均含对应语义；audit `2fb56ffb` |
| 12 | `85da3120` | research store 忽略外部 session 事件 | ALREADY | 基线 `researchStore` "外会话只写 sessions[id]" 多会话形态已超集；audit `ead3276c` |
| 13 | `982f9fb4` | 控制字符 regex 免字面量构造 | ALREADY | 基线 `sanitizeGenerativeText` 用 `String.fromCharCode` 构造 `CONTROL_CHARS_RE`；audit `54c9ea27` |
| 14 | `40b7b062` | docs: 架构横幅 bump 到 Round 62 | DROP | 官方 ARCHITECTURE 横幅走自己的谱系（R41/42 + wrap-up）；单行 banner bump 过时 |
| 15 | `9510fa7c` | 并发 HPIAS session store slices | ALREADY | 基线 `src/stores/hpiasSessionSlice.ts` 全量在位；audit `16e4b3d4` |
| 16 | `2dcc68f3` | CI：Frontend vite build 堆 4 GiB | ALREADY | 基线 ci.yml 已是 `--max-old-space-size=6144`（后继 6 GiB 版本）；audit `e85c1051` |
| 17 | `c7164ee8` | 单一 HPIAS listener 与 style/srcdoc 清洗 | ALREADY | 基线 sanitizer 含 style/srcdoc 剥除 regex；audit `2ded044a` |
| 18 | `6ab94ed1` | Style Lab reset 保留其他 slices | ALREADY | 基线 hpiasSessionSlice 按 sessionId 定点 reset；audit `db410150` |
| 19 | `d306f768` | 隐藏未注册 action + build 堆 | ALREADY | 基线 `collectUnregisteredActionIds` + `rendererUnregisteredActions` 测试在位，ci.yml 堆 6144；audit `d4ba7592` |
| 20 | `3e67ea91` | 跳过空 ActionBar toolbar | ALREADY | 基线 `showToolbar = visibleActions.length > 0 …`；audit `da087f5a` |
| 21 | `0f49b4e2` | undo stack 隔离与 skip-link | ALREADY | 基线 `rendererUndoIsolation.test.tsx` 等在位；audit `5924ce3e` |
| 22 | `26bfcb33` | CI：unblock genui e2e 与 Vitest shard 4 | DROP | 八分片 shard-4 依赖；其 Rust `block_type_mapping…` 测试基线已有（executor L494），sidebar/scroll 契约改动会回退 A 版本 |
| 23 | `ec950e8a` | ping/background URL 清洗 + briefing defaultValue | ALREADY | 基线 sanitizer URL 属性 regex 已含 `ping|background`；audit `f8a18574` |
| 24 | `40a08fee` | 隔离外部 session_started、流式中保持 listen | ALREADY | 基线 researchStore/bridge 多会话形态已覆盖；audit `7632e922` |
| 25 | `19091465` | CI：vitest worker 堆 + Windows UA 钉死 | DROP | 八分片 worker 稳定化；基线 vitest forks 池 CI 堆 6144 已覆盖，UA 钉死会顶撞 A 的 scrollbar/StatusBar 契约 |
| 26 | `7083913b` | Rust ingress 18 块白名单 | ALREADY | 基线 executor 18 块白名单 + `all 18 types` 测试；audit `7529230d` |
| 27 | `01db704a` | CI：Vitest 拆 8 单 worker 分片 | DROP | 指示明确 DROP；A 四分片 + `--logHeapUsage` 为准（audit 先例：`58e4af56` 同因 DROP） |
| 28 | `1ec05547` | Tauri e2e 拒绝未知 block type | ALREADY | 基线 `execute_rejects_unknown_block_type` e2e 在位；audit `413b2514` |
| 29 | `0033879c` | 本地化 generative-ui 技能 + 刷新 shard 契约 | INCLUDE（局部） | 仅取 en-US/zh-CN `skills.json` 的 `generative-ui` builtinNames/builtinDescriptions（官方与 leftovers-safe 均缺）；shard 契约刷新、i18n.source 路径改写、i18next mock 加固为八分片依赖，不取 |
| 30 | `c2786d4b` | CI：shard 4 契约对齐 restore/timeout/PDF 默认值 | DROP | 八分片 shard-4 契约刷新；会改写 A/D 已裁决的 CardAgent、fileDefinitionPdf、p11-workbench 契约（audit 先例：`6c833a7f` DROP） |

## 门禁

| 门禁 | 结果 |
|---|---|
| `node -e JSON.parse`（en-US / zh-CN skills.json） | ✅ |
| 定向 vitest（i18n / skills 相关契约） | ✅（见下） |
