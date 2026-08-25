# 0824 近期改造统一合并计划

日期：2026-08-24  
最终分支：`cursor/0824-cde6`（对外简称 0824）  
基准：`origin/main` @ `0e4c9fad`

本轮目标：把近 2–3 天的 PR/分支先收成几个主题仓，修复冲突并保证前后端编译，再归并到本分支。CI 暂不作为门禁。

## 1. 现状结论（第一轮 10 代理盘点）

- 开放 PR 约 115 个；8/21 之后 **main 零合并**。
- 近 3 天远程分支约 243 个；其中约 132 个无独立 PR，绝大多数是巨型 PR 的卫星工作枝。
- 真正有独特产品价值、必须作为主题仓底座的是这 8 个 tip（互相都不是祖先）：

| 主题仓 | 底座分支 | PR | 已吸收 |
|---|---|---|---|
| A wrapup | `cursor/sota-wrapup-0b49` | #268 | ~85 个小 PR（几乎全部 i18n/a11y/模型/流式修补） |
| B cloud-sync | `cursor/cloud-sync-sota-b343` | #177 | 83/86 卫星 |
| C generative-ui | `Generative-UI-0824` | #214 | 18/19 卫星（print-forced-colors 已被超集取代） |
| D anki | `cursor/anki-ai-native-research-bfca` | #215 | 产品代码，不是纯调研 |
| E optimization | `cursor/optimization0824-5575` | #213 | wi11 / r4-dep-sweep |
| F subapp | `cursor/sota-subapp-polish-2399` | #176 | w3/w4/w6/w8/w9/wave2/finder/reader 等 |
| G mobile | `cursor/mobile-uiux-unify-0888` | #172 | 移动端 90 轮 |
| H cache | `cursor/sota-p0-cache-telemetry-6117` | #183 | 叠在 #175 文档枝上 |

## 2. 明确忽略

- 全部 `dependabot/*`、release-please、`cla-signatures`、`master`
- 已关闭未合并 #101/#102/#103
- 过旧冲突 PR：#113、#123、#134、#155
- 已被 mega 吸收的卫星与小 PR（#165–#267 中除下列「剩余独特」外）
- #170 mythos-5（#268 判定为虚构模型）
- #198 把图片入口改成 200MB（与现行「文件 200MB / 图片 50MB」冲突）
- #200 旧 token 剥离（已被 #268 的 `model_special_tokens.rs` 取代）
- 已在 main 的旧枝：`os`、`nightly`、多数 `codex/*`、hotfix/fix-release 等

## 3. 仍需并入主题仓的剩余独特提交

- A wrapup：`d15d9ff6`（#164 finderStore hostId 分桶）；#159 中 ResourceIcons 暗色 token / ErrorBoundary 真重试（若 #268 未含）
- B cloud-sync：#169 FTP 550 tombstone、#174 WebDAV/S3 端点；可选移植 `r02-sync-more-tests`
- D anki：`cursor/occlusion-preview-interaction-rebased-c207` 的 `6c401455`；移植 #268 对 #187 的最终 token 语义
- F subapp：#160/#161/#162/#163/#167 中未被 #176 吸收的能力（按文件移植，不要整 PR 硬并）
- H cache：先合 #175 再合 #183
- 测试契约（可后置）：#205/#208/#209/#210（#203 与 #209 冲突，弃 #203）

## 4. 主题仓目标分支

| 主题仓 | 目标分支 |
|---|---|
| A | `cursor/0824-theme-wrapup-cde6` |
| B | `cursor/0824-theme-cloud-cde6` |
| C | `cursor/0824-theme-genui-cde6` |
| D | `cursor/0824-theme-anki-cde6` |
| E | `cursor/0824-theme-opt-cde6` |
| F | `cursor/0824-theme-subapp-cde6` |
| G | `cursor/0824-theme-mobile-cde6` |
| H | `cursor/0824-theme-cache-cde6` |
| 统一 | `cursor/0824-cde6` |

## 5. 推荐最终合成顺序

1. E optimization（结构基线，独占构建配置，对其它仓冲突少）
2. C generative-ui（加法式，与多数仓 CLEAN）
3. H cache（与 #268 CLEAN；与 #213 仅 lock/pipeline 语义）
4. A wrapup
5. B cloud-sync（与 A 在 ftp/s3/webdav 需语义合并）
6. D anki（与 A 在 `streaming_anki_service.rs` 冲突）
7. F subapp
8. G mobile（最后；与 F/A 冲突最多，按「主体用 F/A，重放 G 热区增量」）

## 6. 编译门禁（本阶段唯一硬条件）

```bash
npm ci
npm run typecheck
npx vite build
cargo check --manifest-path src-tauri/Cargo.toml --lib
```

不要因为 CI 红而停。lockfile/NOTICES 冲突时按主题仓规则重生成，不要手改乱锁。

## 7. 冲突处理原则

- 云存储：#177 为大改写，#268/#169/#174 为针对性修复；合 B 时先保证 #177 完整，再移植 #169/#174 的行为。
- 附件上限：文件 200MB，图片 50MB。拒绝 #198。
- 测试：#268 修了根因的，以 #268 断言为准；#176/#172 的产品改动不要用旧测试覆盖掉。
- `useMessageActions.ts`：#176 删除 vs #268 修改，保留产品能力后迁到 #176 新结构。
- legacy notes：#172 删除，#176 若只改了其中小补丁可弃补丁、跟删除。
- package-lock / THIRD_PARTY_NOTICES：合并后用项目脚本重生成。

## 8. 第二轮执行记录

### Step 1：已合入 E optimization（#213）+ C generative-ui（#214）

日期：2026-08-24。直接以两仓远程 tip 合入本分支（未等主题仓）：

- `origin/cursor/optimization0824-5575` @ `65bad3ed` → merge commit `6f636ad5`，零冲突。
- `origin/Generative-UI-0824` @ `c16a4fbd` → merge commit `23090166`，冲突 2 处。

冲突与解法（按「构建结构听 #213、Generative UI 产品代码全留」）：

- `public/legal/THIRD_PARTY_NOTICES.txt`（modify/delete）：采纳 #213 的 WI-9 结构
  ——唯一权威路径为 `legal/THIRD_PARTY_NOTICES.txt`，删除 public/ 旧址副本。
- `package-lock.json`（content）：先取 #213 侧，再在合并后的 `package.json`
  上 `npm install` 重生成；`zod@4.4.3`（#214 新增）从 dev 传递依赖提升为直接
  生产依赖，lock 净变化仅此一项。
- `legal/THIRD_PARTY_NOTICES.txt`：`npm run licenses:generate` 重生成
  （1848 组件，含 zod）。
- `package.json`、`src-tauri/src/chat_v2/pipeline.rs`、`src-tauri/src/lib.rs`
  由 git 自动合并成功。

额外修复（`82fc755a`）：#214 tip 的 CI 从未跑完，
`src-tauri/src/chat_v2/tools/generative_ui_executor.rs` 带入一处 E0716
（`extract_question_from_intent(...)` 返回的 `Option<String>` 临时值在语句末被
释放，`hpias_question` 仍借用它）。改为先绑定局部变量再 `.as_deref()`，行为不变。

编译门禁结果（全部通过）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages |
| `npm run typecheck` | ✅（需先 `npm run version:generate` 生成 gitignored 的 `src/version.ts`，与 prebuild 行为一致） |
| `npx vite build` | ✅ 1m14s，仅 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（22 条，均为两仓自带） |

### Step 2：已合入 H cache（#175+#183）+ 移植主题仓 C 的 i18n 修复

日期：2026-08-24。本步由第四轮官方合并代理完成，输入为
`docs/dev/0824-step1-review.md`（第三轮复查，随本步一并收录进 0824，提交
`df7bed1a` + `f40ee4c8`）标注的两个阻断项：主题仓 H 的 `pipeline.rs` tip 上
看不到 Step 1 的 hooks/GenerativeUiExecutor；0824 尚缺主题仓 C 的 `423dc82a`。

顺序与提交：

1. **移植主题仓 C i18n**：cherry-pick `423dc82a` → `34c66cb2`
   （`fix(generative-ui): wire hardcoded Chinese guard texts to existing i18n`，
   7 个文件与源提交逐字节一致）。主题仓 C tip 的另一后续 `bc26f121`
   （executor E0716 修复）与 0824 已有的 `82fc755a` 等价——合并后
   `generative_ui_executor.rs` 与主题仓 C tip 零 diff——按计划跳过，不重复移植。
2. **合入 H**：`origin/cursor/0824-theme-cache-cde6` @ `9101aa0b` →
   merge commit `e54603a0`。按 step1-review 的红线执行
   「结构/hooks/GenUI 听 0824，cache 语义听 H」：
   - `src-tauri/permissions/application-commands.toml`：两侧新命令取并集
     （#213 的 `chat_v2_export_session_jsonl` + H 的
     `chat_v2_freeze_available_skills_snapshot`）。
   - `src-tauri/src/chat_v2/pipeline/tool_loop.rs`：保留 H 新增的
     prompt-cache 冻结/排序 helper（`sort_tool_schemas_for_prompt_cache`、
     `freeze_tool_schema_order_for_prompt_cache`、
     `freeze_tool_schemas_for_prompt_cache`、
     `merge_frozen_tool_schema_order_baseline`）与 reasoning-item 归属逻辑；
     丢弃 H 侧遗留的 approval 函数副本
     （`approval_manager_required`/`tool_may_require_approval`/
     `request_tool_approval`/`request_plan_gate` 等，#213 已迁至
     `pipeline/hooks.rs`，合并后逐一确认仍在 hooks.rs）。

合并后逐项复核（对照 step1-review 第 3 节 H cache 清单）：

- 0824 侧保留：`pipeline.rs` 的 `pub mod hooks` + `default_pipeline_hooks()`、
  catch-all 前注册 `GenerativeUiExecutor`、`render_generative_ui` →
  `block_types::GENERATIVE_UI` 映射；`tool_loop.rs` 的
  `before_tool`/`after_tool` hook 调用；`lib.rs` 的 `pub mod hpias`、
  `chat_v2_export_session_jsonl` 注册与 #213 初始化；compaction 拆分模块
  （`compaction/memory_flush.rs` 等）与 `context_compiler` 拆分不变。
- H 侧保留：prefix freeze 全链
  （`frozen_tool_schema_orders`/`microcompact_anchors`/
  `availableSkillsSnapshot` 会话持久化 + `prefix_snapshot_tests.rs`）、
  native replay（`llm_adapter.rs` 的 `response_reasoning_items` 采集/配对/回放）、
  cache telemetry（`V20260824__add_cache_write_tokens.sql` 迁移、
  `record_llm_usage_cache_ext`、`cache_write_tokens` 全链路记账）、
  检索/预取注入迁至 `<injected_context>`、`scripts/cache-hit-report.py` 报表。
- `git diff origin/cursor/0824-theme-genui-cde6..HEAD` 在
  generative-ui/locales/tests 路径下仅剩 0824 独有的 #213/H 增量，
  主题仓 C 无内容缺失。

合并后编译门禁修复（`src-tauri/src/llm_manager/model2_pipeline.rs`，
该文件不在 step1-review 的 H 重叠清单内，是本步实测新暴露的坏合成）：

- `server_side_web_search_enabled` 被合成了「#213 的 quirks 签名 + H 的
  `config.model` 白名单检查」的坏混合体（E0423）。重构为
  `(quirks, config, llm_context)` 三参：`ProviderQuirks::server_side_web_search`
  继续承载 #213 收敛的「官方 DeepSeek + Responses + supports_tools」门控，
  H 新增的 flash 系列模型白名单
  （`deepseek_model_supports_server_side_web_search`）作为独立第二道门保留，
  两个生产调用点与两组单测（含 H 的
  `server_side_web_search_whitelist_restricts_to_flash_series` 回归）同步更新。
- 合并丢失了 H 在 `use super::{...}` 中对 `is_official_deepseek_config`
  的导入，致 H 的 `provider_accepts_prompt_cache_key` /
  `provider_accepts_prompt_cache_retention`（DeepSeek 官方不写
  `prompt_cache_key`/缓存保留参数）E0425；补回导入，语义不变。
- 另修 #214 遗留的 lib test 编译错（与 Step 1 的 E0716 同类，#214 CI 从未跑完）：
  `generative_ui_executor.rs` 测试 `parse_note_edit_accepts_append_payload`
  把 owned `Option<Value>` move 进 `and_then` 再返回内部引用（E0515），
  改为 `as_ref()` 先借用；该错此前阻断整个 lib test target 编译
  （含 H 的 `prefix_snapshot_tests`）。

编译门禁结果（Rust stable 1.98.0，与 CI 一致；安装 CI 同款
libwebkit2gtk-4.1-dev 等系统依赖与 PDFium 后复跑）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages（package.json/lock 本步无变化，无需重生成 NOTICES） |
| `npm run licenses:check` | ✅ `[license-compliance] OK` |
| `npm run typecheck` | ✅ 0 错误 |
| `npx vite build` | ✅ 2m44s，仅既有 chunk 体积/循环 chunk 警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（24 条，均为主题仓自带） |
| 定向 vitest（i18n 移植） | ✅ `builderI18n.contract` + `generativeUiI18n.parity.contract`，9 tests 全过 |

step1-review 点名的 `useAIEditState.i18n.test.ts` 只存在于主题仓 A（wrapup），
随 Step 3 合入时再跑。

### Step 3：已合入 A wrapup（#268 底座 + tests 对齐，经预演分支）

日期：2026-08-24。本步由第五轮官方合并代理完成。未直接合 theme-wrapup +
theme-tests 两仓，而是采用已完成第四轮复查的预演分支
`origin/cursor/0824-rehearse-wrapup-cde6` @ `2e82b623`（预演过程与冲突解法见
`docs/dev/0824-rehearse-wrapup.md`，随本步一并入库）：

- 预演分支以 Step 1 tip `8361e6b7` 为基线，先合 wrapup tip `1f8d9850`
  再合 tests tip `02a1d03a`，4 处测试冲突已按「对齐当前实现」原则解掉；
- 第四轮复查发现与 Step 2 后 0824 的唯一内容冲突
  （`useAIEditState.ts` 双方接不同 i18n 契约）已在预演分支上预对齐为
  0824 的 `guardText → notes:aiDiff.errors.*` 契约（提交 `2e82b623`），
  同时修正配套 locale 与测试断言、删除 `learningHub.json` 的 `ai_edit` 死键段；
- 复查点名的 `e54603a0` 编译阻断（`server_side_web_search_enabled` 坏合成）
  已由 Step 2 的 `c1a2a232`/`2f7eec54` 在 0824 上修复。

合并执行：`git merge --no-ff origin/cursor/0824-rehearse-wrapup-cde6` →
merge commit `3efdc1b3`，**零冲突**（与复查结论一致；未从过期基线
`8361e6b7` fast-forward）。409 文件，+15676/−1758。

合并后红线复核（对照第 7 节与 step1-review）：

- #213 拆模保留：`pipeline.rs` 的 `pub mod hooks` + `default_pipeline_hooks()`、
  compaction/context_compiler 拆分不变；wrapup 对 `llm_adapter.rs`、
  `multi_variant.rs`、`tool_loop.rs`、`variant_adapter.rs` 的修补落在拆分结构上。
- #214 GenUI 保留：catch-all 前注册 `GenerativeUiExecutor`、
  `generative_ui_executor.rs` 与 Step 2 移植的 i18n guard 文案不变。
- Step 2 H cache 保留：prefix freeze 全链（`frozen_tool_schema_orders`、
  `freeze_tool_schemas_for_prompt_cache`、`pipeline/prefix_snapshot_tests.rs`）、
  `cache_write_tokens` 记账、native replay；`model2_pipeline.rs` 的
  `server_side_web_search_enabled(quirks, config, llm_context)` 三参门控与
  flash 白名单、`is_official_deepseek_config` 导入均未被合并回退。
- wrapup 保留：i18n/a11y 测试群（dstu、workbench driver、command-palette 等
  新增 60+ 测试文件）、流式修复（`utf8_stream.rs`、`sse_buffer.rs`、
  `streaming_anki_service.rs`）、模型修复（`model_special_tokens.rs` 新增、
  `builtin_vendors.rs`/adapters、model-capability-registry）。
- package.json 仅 npm scripts 变化（dstu-test:cloud 指到 scripts/dev 编排），
  依赖与 lockfile 零变化，无需重生成 NOTICES。

合并后门禁修复（`llm_adapter.rs` 测试，git 看不见的跨侧语义断裂）：
wrapup 给 `ChatV2LLMAdapter::new` 加了第 6 参
`wrap_token_policy: ModelWrapTokenPolicy`（special-token 过滤链），而 Step 2
从 H 合入的同文件测试 helper（`web_search_item_tests` /
`response_reasoning_pairing_tests`）仍按旧 5 参调用，`--lib` 测试目标
2 处 E0061（`cargo check --lib` 不受影响）。两处 helper 补传
`ModelWrapTokenPolicy::Disabled`（与 `tool_loop.rs` 生产侧无策略模型的默认值
一致；这两组测试只验证 web_search item 缓存与 reasoning-item 配对，不涉及
token 过滤，语义不变）。修复后该 6 个测试全过。

编译门禁结果（Rust stable 1.98.0 + CI 同款系统依赖与 PDFium）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages |
| `npm run typecheck` | ✅ 0 错误（先 `npm run version:generate`） |
| `npx vite build` | ✅ 2m19s，仅既有 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（24 条，与 Step 2 持平） |
| 定向 vitest `useAIEditState.i18n.test.ts` | ✅ 12/12（预对齐契约生效） |
| 定向 `cargo test --lib prefix_snapshot` | ✅ 4/4（H prefix freeze 回归在 wrapup 合入后仍过；需先修上述 E0061） |
| 定向 `cargo test --lib chat_v2::pipeline::llm_adapter` | ✅ 6/6（E0061 修复后的 H reasoning/web_search 测试） |
| 预演冲突覆盖 4 文件（question-bank-editor-ai-markdown / fileDefinitionPdf / settingsQuietHoverContract / smokeRender） | ✅ 9/9 |

待办：B cloud-sync / D anki / F subapp / G mobile 按第 5 节顺序继续合入
（回归清单见 `docs/dev/0824-step1-review.md` 第 3 节；B 合入时注意与本步
wrapup 在 `ftp.rs`/`s3.rs`/`webdav.rs` 的语义合并，D 注意
`streaming_anki_service.rs` 冲突）。

### Step 4：已合入 B cloud-sync（#177 + #174 移植；补记）

日期：2026-08-24。本步执行时未更新本文档，此处由第七轮代理按提交历史补记：

- merge commit `0e32e0fe`：`origin/cursor/0824-theme-cloud-cde6` @ `a1ee2420`
  （theme 分支已先合入最新 cloud sync #177）合入 0824。
- 后续修复：`84f7ca5d`（rust-test-build env 残留冲突标记清理 +
  unicode-normalization 的 NOTICES 重生成）、`8b70b2d7`
  （autosync 间隔切换与本地化缺配置错误的测试契约，采纳预演分支断言）。
- 附带 `af3e39d8`（恢复被本地 pdfium 下载覆盖的已跟踪 license 文本）。

### Step 5：已合入 D anki（#215 底座，经 step3-anki 预演）

日期：2026-08-24。本步由第七轮官方合并代理完成。输入：

- 0824 tip `8b70b2d7`（E+C+H+A+T+B）；
- D 主题仓 `origin/cursor/0824-theme-anki-cde6` @ `07146ea9`；
- 预演分支 `origin/cursor/0824-rehearse-step3-anki-cde6` @ `76be463d`
  （第六轮在 `af3e39d8`——含 A 不含 B——上完成的同 tip 合并预演，过程与
  冲突裁决见 `docs/dev/0824-rehearse-step3-anki.md`，随本步一并入库）。

**合并执行**：merge commit `a8185664`。冲突 4 处
（`streaming_anki_service.rs` + `CardAgent.test.ts` + `AnkiCardsBlock.test.tsx`
+ `chatAnkiAgentLoop.test.ts`）。关键事实：`af3e39d8..8b70b2d7`（B+T 两步）
对这 4 个文件零改动，且预演所合 theme-anki tip 与本步完全相同，故 4 处冲突
直接复用预演 `428b0625` 的已验证裁决。合并后与预演树对比：
Anki/GenUI/streaming 相关路径零 diff，其余差异均为 B/T 增量，无内容回退。

**`streaming_anki_service.rs` 双侧语义均保留**：

- D 侧：结构化协议解析、字段 QA（`_qa_flags`）、critic pass
  （`run_critic_pass`/`anki_critic`）、指纹去重、图片遮挡
  （`anki_image_occlusion` 字段合并）。
- wrapup 侧：`MODEL_SPECIAL_TOKENS`/`strip_model_special_tokens`
  （#268 对 #187 的最终语义：保留卡片正文字面 token，只丢纯 token 残片或
  剥离完整卡片 JSON 外侧包装；纯 token 错误卡不进重试）。

**吸收预演的只读闪卡裁决**（Generative UI 闪卡 display-only 边界）：

- cherry-pick `cdfc9d63`（源 `5ddafc1a`）：删除 GenUI 自有 `save-to-library`
  handler、卡片提取/保存接线；`resolveGenerativeUIChatActionHandlers.ts`
  保留基线 `fallbackLabel` 与全部 Notes/Research/Copy fallback；保存与
  QA/critic 统一归 `anki_cards` 管线。
- cherry-pick `65274b98`（源 `f874e2ed`）：清理两侧 `save_to_library`
  locale 死键与测试 mock。
- wrapup-anki 预演的 `683d7733`（executor 测试 `.as_ref()` 借用修复）无需
  移植——0824 基线已含等价修复（Step 2 记录的 E0515 修复）。

**合并后存量修复**（`f727043e`，非本步引入——已在合并前 tip `8b70b2d7`
复跑实证同样 3 失败）：`model2_pipeline` 三个断言未跟上产品演进：
终结成功缺失文案已被 main 的 `c006f457` 改为中性 `LLM provider`；同提交的
`embedded_binary` 强脱敏先于 `[base64 data:]` 占位符吃掉 `image_url`；
H 的 prompt cache 使 openai_responses 请求快照新增 `prompt_cache_key`
（`provider_accepts_prompt_cache_key` 门控回归本就在过）。三处按现行为对齐，
修复后 59/59。

编译门禁结果（Rust stable 1.98.0 + CI 同款系统依赖与 PDFium；下载脚本对
`licenses/pdfium.txt` 的重写已恢复，未带入提交）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages（依赖零变化，无需重生成 NOTICES） |
| `npm run typecheck` | ✅ 0 错误（先 `npm run version:generate`） |
| `npx vite build` | ✅ 1m20s，仅既有 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（28 条，新增 4 条为 D 自带） |
| `cargo test --lib --no-run`（测试目标编译） | ✅ 无错误 |
| 定向 vitest（3 个冲突测试文件 + `flashcardDisplayOnly`） | ✅ 4 文件 49/49 |
| 定向 `cargo test --lib streaming_anki_service` | ✅ 74/74（遮挡草稿合并、QA 校验、token 收尾语义均过） |
| 回归：prefix_snapshot / llm_adapter / anki_critic / anki_model_routing / anki_image_occlusion | ✅ 4/4、6/6、45/45、25/25、35/35 |
| `cargo test --lib model2_pipeline` | ✅ 59/59（存量修复 `f727043e` 后） |

### Step 6：已合入 F subapp（#160/#161，经 step3-subapp 预演）

日期：2026-08-25。本步由第八轮官方合并代理完成。输入：

- 0824 tip `4f05d227`（E+C+H+A+T+B+D）；
- F 主题仓 `origin/cursor/0824-theme-subapp-cde6` @ `575fee7f`（已含 #160/#161）；
- 预演分支 `origin/cursor/0824-rehearse-step3-subapp-cde6` @ `64a976ce`
  （第六轮在 `af3e39d8`——含 A 不含 B/D——上完成的同 tip 合并预演，21 处冲突
  裁决见 `docs/dev/0824-rehearse-step3-subapp.md`，随本步一并入库）。

**合并执行**：merge commit `0a0a1197`（未 fast-forward 预演分支，在最新 0824
上重新 merge F）。冲突 28 处 = 预演已知 21 处 + B/D 与 F 重叠新增 7 处。

**预演裁决复用（21 处）**：`af3e39d8..4f05d227`（B+D 两步）对这 21 个文件
零改动，直接采用预演终态（已含预演 4 个提交的全部修正）。要点：

- finder 分桶取 F 全套（`useFinderStoreFor` 每宿主独立桶 + 视图偏好继承 +
  活跃宿主机制），删 wrapup 重复测试 `finderStoreHostBuckets.test.ts`、清
  NavigationContext 死绑定；保留 wrapup「画布导航写入桶 store」与 F 每宿主桶
  的有益组合（canvasMobile 面包屑因此有真实数据）。
- wrapup 打在死文件 `useMessageActions.ts` 上的复制失败 i18n，随 F 删除该文件
  并移植到活着的三个复制处理器（`MessageItem` / `ParallelVariantView` /
  `useChatPageEvents`）；OCR 阶段标签 i18n 随 F 的 InputBarUI 拆分进
  `attachmentModeHelpers.ts` 的 `getStageLabel`（该文件非冲突自动并入，
  修补按预演提示单独移植，防静默丢失）。
- `qbank-tools.ts` 不整文件取 F：非冲突区保留 0824 的 110 行描述压缩，冲突块
  取 F 的 count≤50 / `daily_target` /【必填】标注，9 条机器可读契约串已补回。
- `package.json`/lock/`legal/THIRD_PARTY_NOTICES.txt` 保持 0824 dep-sweep 态；
  `public/legal/` 副本保持删除。
- 测试冲突按预演对齐当前实现（i18n mock 按 ns 缓存、mindmap 断言并集、
  DockWindowList 等真实一帧、Notes 三件套取 F 行为超集、
  sidebar 集成 mock 补 defaultValue 签名）。

**新增裁决（B/D × F 重叠 7 处，预演基线不含 B/D）**：

- 作文批改三件（`EssayGradingWorkbench` / `GradingMain` / `ResultPanel`）：
  同位插入取并集——F 的撤销建议 / 存为笔记 / `SuggestionChange` 锚定签名 +
  双侧逐字节相同的制卡入口（#160/#161 两侧同源）；D 独有内容仅是被 F 锚定
  签名取代的旧 `onApplySuggestion` 窄签名，无丢失。
- `generateCardsFromText.ts` + 测试、`selectionCardGeneration.ts`：取 0824 侧
  非阻塞 `cardAgent.startGeneration` 契约（合并树 CardAgent 文档明确
  `generateCards` 为阻塞式编程 API、无 UI 生产调用方；成功 toast
  「已启动 + 查看任务」语义只与直启匹配）。F 侧唯一差异即方法名与注释。
- `docs/user-guide/12-Anki制卡与模板.md`：尾部修订注释取两侧并集。

合并树与预演终态全树对比：除 B/D 合法增量与预演文档本身外零 diff。

编译门禁结果（Rust stable 1.98.0 + Tauri Linux 系统依赖 + protobuf-compiler
+ PDFium；下载脚本对 `licenses/pdfium.txt` 的重写已恢复，未带入提交）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages（依赖零变化） |
| `npm run licenses:check` | ✅ `[license-compliance] OK` |
| `npm run typecheck` | ✅ 0 错误（先 `npm run version:generate`） |
| `npx vite build` | ✅ 1m09s，仅既有 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（28 条，与 Step 5 持平） |
| 定向 vitest：sidebar 集成 / qbank 契约 / finder 分桶 / generateCardsFromText | ✅ 4 文件 40/40 |
| 定向 vitest：作文批改 + 划词制卡冲突面（8 文件） | ✅ 112/112 |
| 定向 vitest：notes / mindmap / workbench / finder store（29 文件） | ✅ 286/286 |
| F 重构面 input-bar 全目录 vitest | ✅ 19 文件 171/171（与预演一致） |

待办：G mobile 按第 5 节顺序继续合入（参考
`cursor/0824-rehearse-step3-mobile-cde6` / `cursor/0824-rehearse-step3-fg-cde6`
等预演分支；回归清单见 `docs/dev/0824-step1-review.md` 第 3 节）。

### Step 7：已合入 leftovers-safe（24 项 INCLUDE 加固；补记）

日期：2026-08-25。本步执行时未更新本文档，此处由 Step 8 代理按提交历史补记：

- merge commit `362dd2df`：`origin/cursor/0824-leftovers-safe-cde6` 合入 0824，
  内容为 `docs/dev/0824-leftover-audit.md`（`f103d9ef` 收录）判定的 24 项
  INCLUDE 加固——GenUI 入口/清洗（sanitizer、256k/256KiB 上限、
  researchSessionId 校验、Rust 18 块型白名单、noteEdit 字段白名单）与
  HPIAS 会话隔离（store slice 隔离、外来 session 事件忽略、undo 栈隔离）。
- 附带 `bfb52a9e`（executor 集成测试目标编译修复）与 CI 前端构建 4GiB 堆。
- 改动面全部在 generative-ui/HPIAS/locales/tests 路径；与 G 的 689 文件
  改动面**零交叉**（Step 8 实测 `git diff 0a0a1197..362dd2df` ∩ G = ∅）。

### Step 8：已合入 G mobile（#172 底座，多预演逐文件定源）

日期：2026-08-25。本步由总攻 Step 8 官方合并代理完成。输入：

- 0824 tip `362dd2df`（E+C+H+A+T+B+D+F+leftovers-safe）；
- G 主题仓 `origin/cursor/0824-theme-mobile-cde6` @ `4ab24435`
  （约 545 提交 / 688 文件，与全部预演同 tip）；
- 预演源（全部读文档后按逐文件输入一致性定源，未 fast-forward 任何预演）：
  - `origin/cursor/0824-rehearse-step5-fg-cde6` @ `0c07e5e2`（0824+D 上 F+G）；
  - `origin/cursor/0824-rehearse-step3-fg-cde6` @ `60d1cbbf`（复查推荐 F×G tip，含 D）；
  - `origin/cursor/0824-rehearse-step5-mobile-cde6` @ `bf8f1b72`（含 D 不含 F 的 G 预演）；
  - `origin/cursor/0824-rehearse-subapp-mobile-cde6`（历史 F×G，仅热区参考）。

**合并执行**：merge commit `79362482`（690 文件）。冲突 52 处 =
45 内容冲突 + 6 处 G 侧删除（legacy notes）+ 1 处我侧删除
（`PracticeModeSelector`，F 已删、G 改，跟删除）。

**定源方法（本步关键决策）**：三组预演各有一处系统性缺陷，不能整树沿用任何
一个，必须按「冲突文件是否被 F/Step 6 触碰」+「输入逐字节一致性」逐文件定源：

- **step5-fg 的 InputBarUI 复活了 3921 行单体**（其 F 合并点 `8f995c0e` 即已
  丢失 F 的 ComposerToolbar 拆分），且部分热区沿用了历史 subapp-mobile 预演的
  过时值（`!h-9` 而非 G 终版的 `!h-11`），另漏放 EpubPreview `isActive`
  返回键守卫、legacyNavigationMap「仅桌面端可用」通知等 G 增量；
- **step3-fg 的 G 重放完整忠实**（44px 终值、isActive 贯穿、视频全屏返回键），
  但其 G 合并发生在 B/D 反向刷新之前，个别文件丢 0824 主体内容
  （`SkillsManagementPage` 的行内确认滚顶逻辑被旧版覆盖前身、
  `NotesWorkspaceApp.css` 的 F 侧内容差异），且多处把 A 的 i18n
  aria-label 退化为硬编码（`aria-label="refresh"/"remove"/"edit"`）；
- **step5-mobile 质量最高**（A i18n aria + B E2EE + G 44px 三方同存，
  81 项热区测试验证过），但基线不含 F，只适用于 F 不触碰的文件。

**逐文件定源结果**：

1. **22 个 F/Step6 零触碰的冲突** → 取 step5-mobile blob（输入逐字节一致）：
   BatchEditDialog / FilterBuilder / BatchOperationToolbar / CrepeDemoPage /
   ErrorBoundary / ExamSheetUploader / QuestionBankListView /
   QuestionInlineEditor / ReviewQuestionsView / SecurityStatusIndicator /
   UnifiedSidebar / FolderPickerDialog / IndexStatusView / CloudStorageSection /
   DataGovernanceDashboard / McpEditorSection / McpToolsSection / OcrEngineCard /
   OcrEngineTestPanel / VendorSidebar / responsive-utilities.css /
   secondarySurfaceShellContract.test.ts。
   - `DataGovernanceDashboard`：按裁决**不照抄 F×G 树**，取 step5-mobile 的
     `e7193f93` 终态（A `tabs_nav_label` + 8 个 TabsTrigger 逐个 aria-label +
     B `adc3c8f6` E2EE zip（encryptionPassword/exportZip/importZip 贯穿）+
     G coarse 44px 页签，且比 F×G 版多每 trigger 的 `!min-h-11 !min-w-11`）。
   - `ReviewQuestionsView`：D 操作栏（含 44px）整体保留，G 其余自动合并热区
     （复选框 coarse 44px 扩区、重做按钮、SegmentedControl itemClassName）在位。
2. **3 个两预演一致的 F 交叠冲突** → 直接取（Resizable / FinderToolbar /
   EnhancedPdfViewer）。
3. **13 个 step3-fg 为纯 G 增量的 F 交叠冲突** → 取 step3-fg blob：
   StreamingAnnotatedText（!h-9→!h-11 终值）/ DsDialog（关闭钮 coarse 44px 锚定
   + AlertDialog 按钮）/ StatisticsScreen / TodayScreen / EpubPreview
   （isActive 返回键守卫）/ FileContentView / TextbookContentView（isActive
   贯穿）/ VideoPlayer（全屏 Android 返回键 + overlay 按钮 !h-11）/
   SessionRow / TodoMainPanel（返回键保活可见性守卫 ×2 + coarse 热区）/
   DesktopContextMenu.css / EmptyDesktop.css / ExposeOverlay.css
   （coarse 关闭钮常显 44px）/ legacyNavigationMap（browser/flashcards no-op
   附「仅桌面端可用」通知，`workbench:legacyFallback.desktopOnly` 键已随 G
   自动并入）/ NotesWorkspaceApp.css（G 终版触控方案：拖拽条命中区改走 TSX
   `hitAreaMargins={{ coarse: 19 }}`、compact 固定 50/50 无手柄、
   删除死选择器 `.rct-tree-item-button`——TSX 配套已自动并入）/
   SkillsManagementPage（G 的 anyInlinePanelOpen 滚顶扩展 + useMobileHeader
   第 4 参 `!workbenchWindowId` 嵌入豁免 + 全部 coarse 热区）。
4. **2 个混合文件手工合成**：SkillsList / AnkiTasksApp——取对应更优底稿后，
   补齐 step3-fg 的 coarse 热区、保留/恢复 A 的 i18n aria-label
   （拒绝 step3-fg 的 `aria-label="favorite"/"edit"/"more"/"clear"` 硬编码）。
5. **InputBarUI（裁决 6）**：取 step3-fg blob = 0824 拆分主体 +
   G 残留区 5 个提示按钮热区（longPaste convert/dismiss、flashcard/media/
   mindmap hint）；再把 G 单体上的其余 8 处热区**手工重放进拆分文件**——
   `ComposerToolbar.tsx`（发送钮 coarse !h-11 !w-11、停止钮 coarse、
   水位环 after:-inset-2 命中扩区、模型搜索框 coarse !h-11 !text-base 防
   iOS 聚焦缩放）、`AttachmentPanelBody.tsx`（移动加号钮 min-w→!min-w、
   桌面区 5 按钮 + 重试/移除 coarse !min-h-11）。不复活整文件单体。
6. **删除类**：`NoteTagsEditor(.test)` / `NotesTabsBar` / `PreviewPanel` /
   `ReferenceSelector(.test)` 跟 G 删除；`PracticeModeSelector` 跟 F 删除。
   `DndFileTree/**`、`workspaceShared.tsx` 等 legacy notes 集合继续不存在。

**自动合并复核**：`ChatV2Page` / `LearningHubPage` / `LearningHubSidebar`
自动合并结果与 step3-fg 逐字节一致；`MessageItem` / `ParallelVariantView`
保留 Step 6 的 `t('common:copy_failed')` 复制失败 i18n（预演缺该内容）；
`useChatPageEvents` 无 `loadUngroupedCount` 残留；`LearningHubNavigationContext`
与 step3-fg 一致。`qbank-tools.ts` / `finderStore.ts` / `generateCardsFromText.ts`
G 零触碰，Step 6 裁决原样保留（每宿主分桶、110 行描述压缩、
`cardAgent.startGeneration` 非阻塞契约）。

**红线复核**（对照总攻硬性裁决）：

- src-tauri 全程零改动（G 不触碰 Rust；D 的 QA/critic/遮挡、H cache、
  pipeline hooks、GenUI 注册面不受影响）。
- 附件上限 `ATTACHMENT_MAX_SIZE=200MB` / `ATTACHMENT_IMAGE_MAX_SIZE=50MB` 不变。
- ChatV2AnkiAdapter / mythos 的出现次数与合并前基线一致（均为「已退役/虚构」
  注释性提及，未复活）；GenUI save-to-library 死键未回流
  （common.json 的 `save_to_library` 为错题本既有键）。
- Finder compact：40px 视觉 + `after:-inset-1` 伪元素扩展命中区（8 处）在位；
  EnhancedPdfViewer 移动侧栏 tab `!min-h-11`（9 处）在位。
- G 重放度：safe-area 68≥67、registerBackHandler 172≥166、
  pointer:coarse 3056≥3032（HEAD 均为 G 超集）。

**合并后存量修复**（`8a350d14`，非本步引入——在合并前 tip `362dd2df` 复现
同样失败）：`ReviewQuestionsView.confirmation.test.tsx` 的 react-i18next
mock 工厂缺 `initReactI18next` 导出，组件传递依赖图加载 i18n 引导模块时
收集失败；补齐 mock，3/3 过。

编译门禁结果（Rust stable 1.98.0 + CI 同款 libwebkit2gtk-4.1-dev 等系统依赖
+ protobuf-compiler + PDFium；下载脚本对 `licenses/pdfium.txt` 的重写已恢复，
未带入提交）：

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages（依赖零变化，无需重生成 NOTICES） |
| `npm run typecheck` | ✅ 0 错误（先 `npm run version:generate`） |
| `npx vite build` | ✅ 1m09s（4GiB 堆），仅既有 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 仅警告（28 条，与 Step 6 持平） |
| input-bar 全目录 vitest | ✅ 19 文件 171/171（拆分契约 + 热区重放后仍全绿） |
| finder / workbench-shell / mobile-uiux 契约 | ✅ 7 文件 42/42 |
| DGD debug-tab / backup-config / backup-operations / zip-password + RecordConflictsPanel + r07-cloud-only-delete | ✅ 6 文件 65/65 |
| flashcardDisplayOnly / secondarySurfaceShell / scrollbarVisual / errorBoundaryCopy / image-viewer aria / McpToolsSection 两契约 / pdf 套件 | ✅ 12 文件 68/68 |
| a11y（QuestionBankListView/SecurityStatusIndicator）+ qbank 契约 + notes 工作区 + anki-tasks + todo + CloudStorage/sync 面 | ✅ 34 文件 321/321 + ReviewQuestionsView.confirmation 3/3（存量修复后） |

至此第 5 节推荐顺序的 8 个主题仓全部合入完毕。

### Step 8 收口：回收总攻隔离枝的独特修复（不整枝 merge）

日期：2026-08-25。G 合入（`79362482`）后，总攻期间其余代理在 6 条隔离枝上
继续修质量问题。这些枝各自含重复的 G merge，不能整枝合并；本步 fetch 后
逐文件 diff，只回收 0824 缺失且正确的 hunk。对照源与处置：

| 隔离枝 @ tip | 回收 | 跳过（含理由） |
|---|---|---|
| `0824-g-fix-chat-b0d6` @ `e11fc8d2` | 4 个 chat 契约测试跟进 F 拆分（送信/停止钮契约从 `InputBarUI` 改读 `ComposerToolbar`，composer 面板 token 契约改读 `AttachmentPanelBody`，侧栏字号契约 `text-[13px]`→`text-ui`）；新增 `InputBarUI.mobileSplitContract.source.test.ts` 拆分所有权+44px/16px+OCR i18n 契约；`docs/dev/0824-g-chat.md` | `AttachmentPanelBody`/`ComposerToolbar` 仅格式/注释差异 |
| `0824-g-fix-gates-c824` @ `d4dace83` | 4 个测试契约修复：desktopGlobalSearch 补 `@/i18n` mock 与 `isInitialized`（隔离真实 i18n 引导）；DGD restore-operations/backup-restore-ui 对齐 B 的 E2EE 三参 `importZip(path, format, password)` 与导入密码确认层；OSS 致谢测试视口可切换（桌面 Dialog 与移动内联分支分别断言） | legacy notes 模块整包复活（TrashDialog/previews/ReferenceSelector/DndFileTree 等，与 G 授权删除相悖）；`NotesContext` trashOpen/libraryOpen（0824 由 `NotesWorkspaceApp` 本地管理，无消费者） |
| `0824-g-fix-anki-cde6` @ `e1edaa44` | `ResultPanel` 工具栏 coarse 44px+`shrink-0`、存笔记钮 40→44px；`DailyPracticeMode` 上/下月 `aria-label` + `daily.previousMonth/nextMonth` 双语键；`LibraryScreen` 建卡两输入框 coarse `!h-11`；`streakHint` 双语文案对齐日历日+回退语义；新增 TodayScreen.emptyLibrary / reviewActivityStreak / LibraryScreen 空态 `.apkg` 导入 3 组回归测试；confirmation 测试补选中错题→共享 `generateCardsFromText` 用例（保留 `initReactI18next` mock，该枝缺 `8a350d14`）；新增 `ResultPanel.actions.test.tsx`；`docs/dev/0824-g-anki.md` | `library.css`（0824 的 `pointer:coarse`+行内钮兜底为更新版）；`ReviewQuestionsView` 的 `sm:` 断点方案（0824 的 coarse-pointer 方案覆盖触屏平板，更优）；ResultPanel 轮次导航 `md:`→`sm:` 断点改动（无测试锁定，非 44px 修复） |
| `0824-g-fix-i18n-cde6` @ `308cfdab` | `docs/dev/0824-g-i18n.md`（全量 i18n/a11y 扫描记录） | SkillsList/AnkiTasksApp aria 修复 0824 已有（`79362482` 手工织合时已恢复 A 的 i18n aria）；该枝测试反缺 `initReactI18next` |
| `0824-g-fix-invariants-cde6` @ `ccf0075d` | `docs/dev/0824-g-invariants.md`（12 项不变量审计，0824 终态全 PASS） | leftovers-safe 硬化 0824 已含（`362dd2df` 即合并该枝复查的 `bfb52a9e`）；SkillsList/AnkiTasksApp diff 为 aria 硬编码回退；第九轮 leftover-audit 重写描述其自身 refresh 谱系，与 0824 直并史不符，仅取其结论：原 24 项 INCLUDE 中 `10f1ad16`（qbank headless 禁令）语义已由 F 的 `f32d820a` 覆盖，重放在终树零净影响 |
| `0824-g-landing-cde6` @ `fe7a61f9` | `docs/dev/0824-g-landing.md` | 产品代码与 0824 仅注释差异（其"重放 G 热区到拆分输入栏"结果与官方 `79362482` 等价） |

回收前实测：上述 8 个既有测试文件在 0824 tip 上 **13 用例红**（送信钮契约读
错文件、E2EE 签名不匹配、`text-ui` 断言等），证实缺口真实。回收后验证：

- 全部 14 个涉及测试文件（含 3 个新增）通过；
- `npm run typecheck` 0 错误（先 `version:generate`）；
- 红线复查：F 拆分未回退（mobileSplitContract 新契约锁定）、只读闪卡/
  `cardAgent`/pipeline hooks/host buckets/src-tauri 零触碰。

### Step 9 收口：FF 云同步 #177 增量 + 剩余 leftover INCLUDE + 编译门禁

日期：2026-08-25。官方 0824 唯一写入者执行。基座 `e88340c6`。

#### 9.1 Fast-forward #177（云同步最新增量）

`origin/cursor/0824-rehearse-cloud-latest-cde6` @ `2630dc95`（预演枝，
0824 为其祖先，`merge-base --is-ancestor` 复核为真）→
`git merge --ff-only` 纯快进，无合并提交。快进后 `100c118d`（#177 tip）
已是 HEAD 祖先。带入 46 提交：39 个 #177 独有（R10-R12：中立文件名、
record-path 命名、v1 marker 信任、Android SAF 原子队列、备份 manifest
复读、ZIP 尺寸校验、云错误本地化 `localizeCloudError` 等）+ merge 提交 +
#174 移植 + notices + 预演文档。

#### 9.2 Leftover INCLUDE（同枝直落，不整枝 merge）

| 源 | 处置 | 落地提交 |
|---|---|---|
| #160 `AnkiTasksApp.loadError.test.tsx` | PORT：产品行为（load-error 面板 + stale banner）0824 已有，仅补测试；mock 面与既有 emptyState/polling 测试一致 | `f38d0041` |
| #160 `todayScreenEmptyLibrary.test.tsx` | PORT + 适配：空卡库 CTA 复用 `today.goLibrary`（0824 无 `goLibraryToAdd` 键）；真实 zh-CN 文案断言 3 用例（空库 0%、满库复习完 100%、有卡无到期 idle） | `f38d0041` |
| #160 其余 12 提交 | SKIP：产品已被 F 吸收（建卡/.apkg、pomodoro pill、streak、删 PracticeModeSelector、workbench 壳、i18n 键）；不复活 `PracticeModeSelector` | — |
| #213 `a40c16a00`（provider-contract 解析器 + vitest 堆） | 部分 PORT：仅取解析器修复——旧 `indexOf` 前缀匹配在当前 ci.yml 上误中缩进块内的 `provider-contract` 出现处，5 用例实测 1 红，改正则标题匹配后 5/5 绿；ci.yml 堆改动不取（0824 vitest shard 步已带 A 的 `NODE_OPTIONS 6144` + 4 分片） | `e83d4081` |
| #213 `c986c8d11`（rustfmt） | 按意图 PORT：ci.yml 第 304 行有 `cargo fmt --check` 门禁，快进后树上 15 个文件违规（anki_critic/anki 协议族/apkg importer/chat_v2 tools/lib.rs/question_bank_service/note_repo + 3 测试文件），全量 `cargo fmt`，纯格式化；rustfmt 1.83 与 1.98 双版本 `--check` 均干净 | `6a903224` |
| #213 `746445fc6`（wrap-up vitest 回归修复） | SKIP：其触及的 5 个测试文件在 0824 上实测全绿（InputBarV2.staleContextRef 24/24、StatusBar 33/33、activeSkillToolAccess、blankedTextInteraction、scrollbarVisualContract）；照抄会删除仍在守护的 staleContextRef 测试 | — |
| #213 `e311daa40`（skill 契约对齐） | SKIP：0824 的 qbank 描述已是压缩版且含 headless 禁令语义（F `f32d820a` 谱系），phase3/4/6/9 契约实测全绿；重放会与压缩版描述冲突 | — |
| #214 全部 30 提交 | SKIP：8 分片拆分（`01db704a`）及其配套 CI/契约修复（`19091465`/`26bfcb33`/`54c1eb38`/`c2786d4b`/`0033879c`）明令 DROP，与 A 的 4 分片相悖；GenUI/HPIAS 产品提交已经 leftovers-safe 吸收（18 块白名单、sanitizers、会话隔离在树上核实）；`2dcc68f3` vite build 堆 4GiB 已被现行 6144 超越；两个 docs 提交（Round 50/62 banner）描述 #214 自身树状态，留给隔离代理 | — |

#### 9.3 编译门禁（HEAD `6a903224`）

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ exit 0 |
| `npm run typecheck` | ✅ exit 0（先 `version:generate`） |
| `npx vite build` | ✅ exit 0，1m02s（6GiB 堆），仅既有 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ exit 0（rustc 1.98，28 条既有警告；环境需补 GTK/webkit dev 库、protoc、pdfium 资源，均为环境预备非代码问题） |
| `cargo fmt --check` | ✅ exit 0（1.83 与 1.98 双验） |
| 新增/触及 vitest | ✅ loadError 2/2、todayScreenEmptyLibrary 3/3、兄弟套件 anki-tasks+TodayScreen 10/10、provider-contract-config 5/5 |

#### 9.4 不变量复查（18/18 PASS）

1. pipeline hooks：`chat_v2/pipeline/hooks.rs`（PipelineHook + ApprovalGate/TaskAudit）✅
2. `GenerativeUiExecutor` 注册：`pipeline.rs:347` executors.push ✅
3. H cache：#175/#183 cache telemetry/prefix-freeze（`model2_pipeline`/providers）在树 ✅
4. `utf8_stream` 有调用者：`llm_manager/mod.rs` ✅
5. `model_special_tokens`：`utils/mod.rs`，multi_variant/llm_adapter 消费 ✅
6. 只读闪卡 + 无生产 `ChatV2AnkiAdapter`（仅历史注释）+ `cardAgent.startGeneration`（CardAgent.ts:411）✅
7. 附件上限 file 200MB / image 50MB（core/constants.ts + resources/types.ts）✅
8. finder host buckets（finderStore.ts）✅
9. qbank-tools 压缩版 + `daily_target`（qbank-tools.ts:746）✅
10. tombstone（sync/tombstone.rs，#177 快进后 515 行扩展）✅
11. WebDAV decode（webdav.rs `decode_path`）✅
12. S3 normalize（s3.rs `normalize_endpoint`）✅
13. FTP 550（550/501 白名单 + 不存在语义）✅
14. HPIAS 会话隔离（hpiasEventBridge `session_id` 过滤）+ 18 块白名单（`ALLOWED_GENERATIVE_UI_BLOCK_TYPES`）✅
15. 无 mythos-5 / haiku-5（仅防伪造守护测试，目录零真实条目）✅
16. NOTICES 在 `legal/`（THIRD_PARTY_NOTICES.txt），`public/legal` 不存在 ✅
17. InputBar 保持 F 拆分 Composer*（5 个 Composer 文件；staleContextRef 测试保留且 24/24 绿）✅
18. G 44px / safe-area / Android 返回键（min-h-11、ios-safe-area.css、MainActivity OnBackPressedCallback）✅
