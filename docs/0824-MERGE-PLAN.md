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

### Step 10 收口：#177 最新 3 提交 + leftover-160 产品尾款 + regress 隔离回收

日期：2026-08-25。官方 0824 唯一写入者执行。基座 `cb1a0fbe`（Step 9 tip）。

#### 10.1 Cherry-pick #177 最新增量（`origin/cursor/cloud-sync-sota-b343` 对 0824 的 3 个独有提交）

| 源提交 | 落地提交 | 内容 |
|---|---|---|
| `ef3c104d` | `4bebbf81` | put_file 后核对远端尺寸（WebDAV/S3/FTP stat 复核，短写/缺失删残片并 fail-closed；默认 trait 实现保持不校验以便测试替身模拟短写） |
| `8eb675ce` | `394851a7` | record 清单上传后 GET 复读（设备目录/instance.json/superseded_by/legacy change），短写不得推进水位 |
| `75f12160` | `587cfccd` | 文件级清单（workspace/blob/asset catalogs）发布后经同一 helper 复读 |

三个 pick 全部干净 auto-merge，零冲突；tombstone / WebDAV decode /
S3 normalize / FTP 550 / Composer* / 附件 200/50 均未被触及（见 10.4）。

#### 10.2 leftover-160 产品尾款（PR #303 @ `5c89a5b2`，同枝直落 `41587d48`）

- `StatisticsScreen.tsx`：`SchedulerSettingsSection` 移到统计面板之后
  （统计为主内容、调度设置为次级动作），DOM 顺序由新增用例锁定
  （`compareDocumentPosition` 断言）；
- `theme-colors.css`：亮/暗两档补 `--brand-secondary` / `--brand-accent`
  完整颜色定义（Tailwind `brand.secondary`/`brand.accent` 直接消费别名，
  裸 HSL 通道不可用）；新增 `brandColorTokenContract.test.ts` 契约；
- loadError / todayScreenEmptyLibrary 两测试 Step 9 已落，未重放；
  未复活 `PracticeModeSelector`；未触碰 D 只读闪卡与 G 44px。

#### 10.3 regress 隔离枝回收（`origin/cursor/0824-regress-cloud-cde6`，落地 `08b81e29`）

| 文件 | 处置 |
|---|---|
| `DataGovernanceDashboard.abg.source.test.ts` | TAKE（新增源码契约：A 8 个 tab aria-label + DEV-only debug 门、B E2EE ZIP 密码走 #177 API、G 44px coarse tab 三者共存；对 0824 现树逐断言 grep 核实后 vitest 3/3 绿） |
| `commands_zip.rs` 增量 | TAKE（纯 `#[test]`：密码下限按 Unicode 码点计数 + 稳定 `E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT` code；仅测试模块 +24 行，产品零改动，E2EE zip 未动；`cargo test resolve_zip_encryption_password_tests` 15/15 绿，含新增 Unicode 用例） |
| `threadWidthAlignmentContract.test.ts` 改动 | SKIP（该枝删除 InputBarV2 的 `<ThreadContentShell>` 断言；0824 上 `InputBarV2.tsx` 仍存在且 3 处使用，现行更强版本实测 2/2 绿，照抄即弱化契约） |

#### 10.4 门禁与不变量（HEAD `08b81e29`）

- `npm run typecheck` ✅ exit 0（先 `version:generate`）；
- `npx vite build` ✅ exit 0，1m01s（6GiB 堆），仅既有 chunk 体积警告；
- `cargo check --lib` ✅ exit 0（rustc 1.98，28 条既有警告；本 VM 补装
  GTK/webkit dev 库、protoc、`download-pdfium.sh linux-x64`，均为环境预备）；
- `cargo fmt --check` ✅ exit 0（含新增 Rust 测试）；
- 定向 vitest ✅ 11/11（brandColorToken 1、StatisticsScreen 5、
  DataGovernanceDashboard.abg 3、threadWidthAlignment 现行版 2）；
- 18 项不变量逐项复查全 PASS（清单同 Step 9 §9.4，其中 #10-13 在
  #177 三提交触及文件内逐符号核实：`tombstone.rs`、`decode_path`、
  `normalize_endpoint`、550/501 白名单全部在位）。

### Step 11 收口：#177 tombstone / encryption marker 发布后复读

日期：2026-08-25。基座 `6c9cc932`；仅 cherry-pick #177 新增的
`f39f0d3a` → `af414ed6`（每设备 tombstone 清单 PUT 后 GET 复读）与
`0fcbc59b` → `947910db`（加密标记持久化后复读），均干净落地并逐提交推送。

- 编译门禁：`npm run typecheck`、`npx vite build`（CI 同款 6GiB heap）、
  `cargo check --manifest-path src-tauri/Cargo.toml --lib` 均 exit 0；
- 定向 Rust `reread` 回归：6/6 通过；
- Step 9 §9.4 的 18 项不变量逐项复查仍为 **18/18 PASS**，其中 tombstone
  新 helper 对 blob/asset/workspace 三类清单 fail-closed；WebDAV decode、
  S3 normalize、FTP 550/501、Composer*、附件 200/50、G 44px 与 HPIAS
  18-block allowlist 均保持；
- SKIP：内容已等价落地的 `ef3c104d`/`8eb675ce`/`75f12160`，以及全部隔离 PR。

### Step 12 收口：#177 文件级对象上传后尺寸核验

日期：2026-08-25。基座 `db6032d4`（Step 11 tip）；仅 cherry-pick #177 新增的
`bb81e9d6` → `06f32d0e`（fix(sync): verify file-level object size before
writing manifests），干净落地零冲突。fetch 时 #177 tip 即为 `bb81e9d6`，
其后无更新提交。

- 内容：新增 `put_file_and_verify_size` helper（复用 Step 10 落地的
  `verify_uploaded_size`），文件级 workspace/blob/asset 对象 `put_file` 后
  `stat` 核对远端大小，短写 fail-closed 不得写入文件级清单；生产 provider
  的 `put_file` 已自核，此处拦默认实现。附源码契约断言与
  `TruncateFileObjectPut` 截断替身回归测试。
- 编译门禁：`npm run typecheck`、`npx vite build`、
  `cargo check --manifest-path src-tauri/Cargo.toml --lib` 均 exit 0；
- 定向 Rust 回归 `workspace_upload_fails_when_remote_object_size_mismatches`
  1/1 通过；
- Step 9 §9.4 的 18 项不变量逐项复查仍为 **18/18 PASS**（本提交仅触及
  `sync/mod.rs` 与 #177 自述文档；tombstone、WebDAV decode、S3 normalize、
  FTP 550/501、Composer* 拆分、附件 200/50、G 44px、HPIAS 18-block
  allowlist 全部在位）；
- SKIP：已等价落地的 `ef3c104d`/`8eb675ce`/`75f12160`/`f39f0d3a`/
  `0fcbc59b`，以及全部隔离 PR。

### Step 13 收口：#177 Range 断点续传

日期：2026-08-25。基座 `8badceda`（Step 12 tip）。首次 fetch 仅见
`86a1e7c4` → `6887bf84`（桌面 S3 整包恢复精确 Range 续传；忽略 Range
从零重下、错位 `Content-Range` fail-closed）；编译期间 #177 新增
`6d6769bc` → `bf8ab827`（WebDAV / 桌面 S3 仓库巡检同一对象最多 3 次按
已写入前缀续传）。两提交均干净 cherry-pick 并逐提交推送；最终复 fetch
#177 tip 为 `6d6769bc`，其后无更多提交。FTP 与 Android 行为不变。

- 编译门禁：`npm run typecheck`、`npx vite build`、
  `cargo check --manifest-path src-tauri/Cargo.toml --lib` 最终均 exit 0
  （Rust 1.98；28 条既有 warning；Vite 仅既有 chunk/circular warning）；
- Step 9 §9.4 的 18 项不变量逐项复查仍为 **18/18 PASS**：tombstone 发布后
  复读、WebDAV decode、S3 normalize、FTP 550/501、Composer* 拆分、
  附件 200/50、G 44px、HPIAS 会话隔离与 18-block allowlist 全部在位；
- SKIP：已等价落地的 `ef3c104d`/`8eb675ce`/`75f12160`/`f39f0d3a`/
  `0fcbc59b`/`bb81e9d6`，以及全部隔离 PR。

### Step 14 巡检：#177 无新增内容

日期：2026-08-25。基座 `188500e0`（Step 13 tip）。复 fetch
`origin/cursor/cloud-sync-sota-b343`，tip 为
`6d6769bc94868e8d5f68da63100678c9e87798d3`，与 Step 13 收口时一致。
fetch 时 #177 无新增 unique 内容（`origin/cursor/0824-cde6..#177` 的
8 个提交均已按 Step 10-13 映射等价落地：`ef3c104d`→`4bebbf81`、
`8eb675ce`→`394851a7`、`75f12160`→`587cfccd`、`f39f0d3a`→`af414ed6`、
`0fcbc59b`→`947910db`、`bb81e9d6`→`06f32d0e`、`86a1e7c4`→`6887bf84`、
`6d6769bc`→`bf8ab827`）。本步仅此文档说明，无产品代码变更，按约定
跳过全量编译门禁；Step 13 已记录 compile exit 0 与 18/18 PASS。

### Step 15 收口：generative-ui 内置技能本地化

日期：2026-08-25。基座 `1f567a56`（Step 14 tip）；仅 cherry-pick
leftover-genui 的 `5cf6dccf` → `414abdc7`，为中英文 `skills.json` 的
`builtinNames` / `builtinDescriptions` 补齐 `generative-ui`。未合入隔离枝
或 8-shard CI 改动；Composer*、附件 200/50、G 44px、HPIAS allowlist 与
#177 端口均未触及。`npm run typecheck`、`npx vite build` 均 exit 0；
`cargo check --manifest-path src-tauri/Cargo.toml --lib` 已用 Rust 1.98
执行，但本 VM 缺少 `gdk-3.0` 开发库，环境阶段 exit 101。

### Step 16 收口：#177 rewind 后再前进，续传/复读四提交落地

日期：2026-08-25。基座 `2b6488a6`（Step 15 tip）。#177
（`origin/cursor/cloud-sync-sota-b343`）曾被 rewind 到
`4e28168c`（temp materialization 2x 空间 fail-closed，为 0824 的祖先），
随后又前进到新 tip `519fb9d2`。fetch 时 `0824..#177` 按 SHA 共 12 个
提交，其中 8 个经 `git cherry` 确认与 Step 10-13 的端口 patch 等价
（`ef3c104d`/`8eb675ce`/`75f12160`/`f39f0d3a`/`0fcbc59b`/`bb81e9d6`/
`86a1e7c4`/`6d6769bc`，SKIP 不回退不重置）；4 个为真正新增内容，按序
干净 cherry-pick 零冲突：

- `f7efe4e5` → `8c8b79bd`：文件级下载在目标旁 `.resume` 续传，不再
  覆盖 live dest（新增 `cloud_storage/resume.rs`）；
- `405ad31f` → `aa2a6744`：文件级续传分片改按内容哈希键控，源变更即
  作废旧分片；
- `a439433a` → `42696414`：record-level change shard PUT 后 GET 复读，
  短写 fail-closed；
- `519fb9d2` → `72660bf4`：内存对象 GET 尺寸核验拒绝截断响应，S3 分片
  下载失败重试（`traits.rs` 新增校验 helper，WebDAV/S3 接入）。

落地后复核 `git cherry 0824 #177` 无 `+` 残留，`0824..#177` 无新增
unique 内容。编译门禁三项全过：`npm run typecheck`（先
`npm run version:generate` 生成 `src/version.ts`）、`npx vite build`
（仅既有 chunk 警告）、`cargo check --manifest-path
src-tauri/Cargo.toml --lib`（Rust 1.98，本 VM 补装
libgtk-3-dev/libwebkit2gtk-4.1-dev/libsoup-3.0-dev/protobuf-compiler 并
经 `scripts/download-pdfium.sh` 取回 `libpdfium.so` 后 exit 0，28 条
既有 warning）。不合并任何隔离 PR，不 reset 0824 到 #177 tip。

### Step 17 收口：#177 多段清理/GET 停滞超时 + regress 两测试回收

日期：2026-08-25。基座 `865d2e4c`（Step 16 tip）。fetch
`origin/cursor/cloud-sync-sota-b343`，tip 前进到 `89808fd8`；
`0824..#177` 共 14 个提交，其中 12 个经 `git cherry` 确认与
Step 10-16 的端口 patch 等价（`ef3c104d`/`8eb675ce`/`75f12160`/
`f39f0d3a`/`0fcbc59b`/`bb81e9d6`/`86a1e7c4`/`6d6769bc`/`f7efe4e5`/
`405ad31f`/`a439433a`/`519fb9d2`，SKIP 不重放）；2 个为真正新增，
按序干净 cherry-pick 零冲突：

- `edd5672d` → `957fe6d7`：同 key 的 S3 multipart 上传在开新 multipart
  前列出并 abort 6 小时以前的陈旧 upload（崩溃残留持续吃配额）；
  缺 `Initiated` 或 list/abort 出错不阻塞当前上传，避免误杀并行的
  同 hash 活跃上传；
- `89808fd8` → `172fd10d`：record 级 shard/manifest 走的内存对象 GET
  在 WebDAV 与 S3 上改用与文件下载一致的 90s per-chunk 停滞超时
  （原为 300s 全体超时或 SDK collect 裸等），声明长度时仍拒短体。

编译期间与收口后两次复 fetch #177，tip 均为 `89808fd8`，其后无更多
提交；`git cherry 0824 #177` 无 `+` 残留。

另按可选项回收 `origin/cursor/0824-regress-latest-cde6` 两个纯测试
提交（与上述两端口零文件重叠，逐 hunk 核实仅测试编译生效）：

- `2e74b23c` → `c8f40a01`：`state.rs` 新增 `#[cfg(test)]`-only
  `test_write_lock`，三个会写共享 `sync_state.db` 的 tombstone 测试
  入口取锁串行，消除并行 harness 下 SQLite 死锁检测绕过 busy_timeout
  直接 `database is locked` 的偶发红灯；产品代码零改动；
- `f4ef3459` → `54da9c33`：`builtinSkillLocalization.test.ts` 钉住
  zh-CN/en-US 的 generative-ui 内置名与描述（锁 Step 15 落地内容）。

- 编译门禁：`npm run typecheck`（先 `version:generate`）、
  `npx vite build`（仅既有 chunk 警告）、`cargo check --manifest-path
  src-tauri/Cargo.toml --lib` 均 exit 0（Rust 1.98，本 VM 补装
  libgtk-3-dev/libwebkit2gtk-4.1-dev/libsoup-3.0-dev/protobuf-compiler
  并经 `scripts/download-pdfium.sh` 取回 `libpdfium.so`；28 条既有
  warning）；
- 定向测试：`builtinSkillLocalization` vitest 4/4 绿；三个串行化
  tombstone 测试 `cargo test --lib` 3/3 绿；
- Step 9 §9.4 的 18 项不变量逐项复查仍为 **18/18 PASS**：tombstone
  （`tombstone.rs` 在树且发布后复读在位）、WebDAV `decode_path`、
  S3 `normalize_endpoint`、FTP 550/501 白名单、Composer* 拆分
  （input-bar 下 Composer 组件族齐全）、附件 200/50
  （`ATTACHMENT_MAX_SIZE`/`ATTACHMENT_IMAGE_MAX_SIZE`）、G 44px /
  safe-area / Android 返回键、HPIAS `session_id` 过滤与 18-block
  allowlist（`generative_ui_executor.rs` 恰 18 项）、无 mythos-5 /
  haiku-5 真实条目（仅防伪造守护）、NOTICES 在 `legal/`、
  GenerativeUiExecutor 注册等全部在位；
- SKIP：#177 全部已等价落地的 12 个 SHA（不回退不重置），以及全部
  隔离 PR；regress 枝其余内容未取。

### Step 18 收口：Finder/Workbench 升级防护与 Composer 旧状态归一化

日期：2026-08-25。基座 `64b0e76d`（Step 17 tip）；仅从
`origin/cursor/0824-rel-finder-cde6` 按序干净 cherry-pick 两个 INCLUDE
提交，未合并隔离枝，也未取其他 rel 枝的推测性重构：

- `9176740b` → `e24b828d`：Finder 持久化偏好改为字段白名单恢复，
  Workbench 壁纸/平铺边距旧值改为容错解析与限幅；
- `0a6344e1` → `67a7fdf8`：Composer 恢复时丢弃退役 panel key、补齐当前
  默认值，并让 Rust `PanelStates` 兼容缺失/新增 `skill` 字段。

Composer*、附件 200/50、G 44px、HPIAS、#177 端口与 `note_props` 均未
触及。`npm run typecheck`（先 `version:generate`）、`npx vite build`、
`cargo check --manifest-path src-tauri/Cargo.toml --lib` 均 exit 0；Cargo
使用 Rust 1.98，输出 28 条既有 warning。

### Step 19 收口：mainbackfill/llmusage/anki/restore 四 rel 枝升级修复

日期：2026-08-25。基座 `427c775f`（Step 18 tip）。复查远端全部
`cursor/0824-rel-*-cde6` 枝，仅有 mainbackfill/llmusage/anki/restore/
finder 五条，无新增枝；finder 两提交已于 Step 18 落地，本步不重放
`9176740b`/`0a6344e1`。按序 cherry-pick 六个 INCLUDE 提交（未合并任何
隔离枝整枝）：

- `3d3516c3` → `5f324e1f`（mainbackfill）：VFS pre-repair 在
  `ensure_change_log_table` 之前先补齐 V20260130 契约缺失表
  （`apply_vfs_init_missing_tables`），main `b2a85a69` 的端口；修复
  v0.9.44→0824 升级时旧库只有 resources/notes 而 change_log 回放报
  `no such table: main.questions` 的路径。落地后核实调用顺序：backfill
  先于 change_log 修复；
- `c4a3382c` → `920dd665`（llmusage）：cache token 迁移兼容加固，
  `cache_write_tokens` 保持 nullable、NULL≠0（未测量 ≠ 零），
  model2_pipeline 与 provider 上报路径同步适配；`coordinator.rs` 与
  Step 19 首提交自动合并干净；
- `ef991061` → `0105a7eb`（anki）：新增 V20260824 迁移把旧库 nullable
  的 `tags_json`/`images_json`/`extra_fields_json` 归一为合法空 JSON，
  读路径容忍 NULL，`_qa_flags`/`_occlusion` 载荷原样保留。唯一冲突在
  `tests/fixtures/migrations/manifest.json`（llmusage 与 anki 各追加一个
  v0.9.44 fixture case，纯加性），保留双 case 解决；
- `e97b89ff` → `1df0ec6a`（restore）：不安全恢复路径 fail-closed 前移到
  磁盘预算、清槽与任何数据库写入之前；ZIP 拒收与 E2EE 门禁只紧不松；
- `92c487f8` → `6cfabf67`（restore）：部分归档恢复不再弹误导性确认，
  云错误本地化补 zh-CN/en-US 文案，附 dashboard/localize 两组测试；
- `2ba5522d` → `d7fb7677`（restore，可选项取用）：ZIP 拒收检查纯
  rustfmt，`cargo fmt --check` 1.98 干净。

随手清理 `1119f9be`：`commands_restore.rs` fail-closed 端口后 `warn`
导入不再使用，删除以维持 28 条既有 warning 基线。

SKIP（不取）：`465f0872`（anki 审计文档）与 `8ae0c915`（restore ZIP
兼容文档）均为 docs-only，以本节记录代替；finder 枝全部提交
（Step 18 已落地）；无其他 rel 枝残留内容。

Composer*、附件 200/50、G 44px、HPIAS 18-block、#177
reread/size/resume/stall-timeout/multipart-abort、`note_props`、finder
持久化加固均未触及。编译门禁（Rust 1.98 + 本 VM 补装
libgtk-3-dev/libwebkit2gtk-4.1-dev/libsoup-3.0-dev/protobuf-compiler +
`scripts/download-pdfium.sh linux-x64`，下载脚本对
`licenses/pdfium.txt` 的重写已恢复未带入提交）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck`（先 `version:generate`） | ✅ exit 0 |
| `npx vite build` | ✅ exit 0（仅既有 chunk 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ exit 0（28 条既有 warning） |
| `cargo fmt --check` | ✅ exit 0（rustfmt 1.98） |

### Step 20 收口：i18n/VFS/schema/chat/cloud/leftover 六 rel 枝升级修复

日期：2026-08-25。基座 `30fc858b`（Step 19 tip；fetch 后远端未前进，
无需 fast-forward）。仅按序 cherry-pick 六条枝的 13 个 INCLUDE 提交，
未合并任何隔离枝整枝，未使用 `-X theirs/ours`，全程零冲突：

- A) i18n（#318，`origin/cursor/0824-rel-i18n-cde6`）：
  - `40157848` → `01ed64bf`：release 升级提示复用已翻译 key；
  - `b6246382` → `a4057892`：auto-sync 旧存储水合安全恢复；
  - `3db6bfec` → `5f80e9a0`：侧栏导航 i18n key 归位；
  - `af6078a8` → `65a53f3d`：笔记标签错误改用既有 key；
  - `ff151fa4` → `705a05f4`：笔记通知 key 修正；
- B) VFS（#319，`origin/cursor/0824-rel-vfs-cde6`，明确不 merge 该枝
  的 `2bfe7c31` merge commit）：
  - `b3ce56cd` → `f702121b`：note_props release 升级加固，新增
    `pre_repair_vfs_v20260824_note_props`；
  - `028a2a62` → `e7aa650e`：v0.9.44 迁移按版本序回放测试；
  - `4759bd0c` → `77ee8ecb`：部分元数据保留与搜索分页修复；
- C) schema（#321，`origin/cursor/0824-rel-schema-cde6`）：
  - `6dae7316` → `caa86864`：manifest 锁定 vfs V20260824 note_props，
    与 VFS 组零文件交集；
- D) chat（#320，`origin/cursor/0824-rel-chat-cde6`）：
  - `6c9a231f` → `249df98a`：chat release 升级边界加固（HPIAS
    `session_id` 过滤对缺失/非字符串 id 拒收收紧，`guardedListen`
    白名单只紧不松）；
  - `8e6d8e8f` → `71a51913`：HPIAS allowlist 行为测试；
- E) cloud（`origin/cursor/0824-rel-cloud-cde6`）：
  - `e9952820` → `17f8cdba`：无标记旧版加密密码先对既有备份验证，
    v1 marker 下明文与损坏内容仍 fail-closed；不回放 #177 已移植
    SHA；
- F) leftover tests（`origin/cursor/0824-leftover-rescan-cde6`）：
  - `199b3377` → `0b3d20ed`：钉住卡片表面与 PDF 移动端标签页的 0824
    集成契约（纯测试）。

coordinator.rs 为加法式合并：Step 19 的
`apply_vfs_init_missing_tables` backfill（含 recorded note_props 恢复）
原样保留，`b3ce56cd` 的 `pre_repair_vfs_v20260824_note_props` 叠加
其上，落地 diff 与源提交逐行一致，自动合并无 hunk 丢失。

SKIP（不取）：`a6e2621b`（i18n docs）、`2bfe7c31`（VFS merge
commit，禁整支 merge）、`13d45b0a`（VFS docs）、`1483d071`/`b0cdd9fe`
（schema docs）、`cb842c8a`/`a2ed8071`（leftover rescan docs）；
Step 18 finder `9176740b`/`0a6344e1` 与 Step 19 源 SHA
`3d3516c3`/`c4a3382c`/`ef991061`/`e97b89ff`/`92c487f8`/`2ba5522d`
均不重放；mobile 枝尚不存在，不等待。

pipeline hooks、GenerativeUiExecutor、H cache、utf8_stream 调用方、
model_special_tokens、闪卡只读、cardAgent.startGeneration、附件
200/50、finder host buckets、qbank-tools 压缩+daily_target、
tombstone/WebDAV decode/S3 normalize/FTP 550、HPIAS session+18
allowlist、NOTICES 在 legal/、Composer*、G 44px/safe-area/Android
back 均未触及。`download-pdfium.sh` 对 `licenses/pdfium.txt` 的重写
已恢复，未带入提交。

| 门禁 | 结果 |
| --- | --- |
| `npm run version:generate && npm run typecheck` | ✅ exit 0 |
| `npx vite build` | ✅ exit 0（仅既有 chunk 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ exit 0（28 条既有 warning，Rust 1.98） |
| `node scripts/check-migrations.mjs` | ✅ exit 0（111 个迁移文件） |

### Step 21 收口：rel-mobile（#324）附件面板 i18n 双提交落地

日期：2026-08-25。基座 `991227c2`（Step 20 tip；fetch 后远端未前进，
无需 reset/fast-forward）。仅从 `origin/cursor/0824-rel-mobile-cde6`
按序 cherry-pick 两个 INCLUDE 提交，未合并任何隔离枝整枝，全程零冲突：

- `1901780e` → `96a1ca42`：zh-CN/en-US 两份 `common.json` 增补
  `actions.more` 词条（rel-mobile 树上附件面板「⋯更多」按钮的
  aria-label 键）；
- `8c7f8415` → `2e788607`：新增
  `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts`，
  扫描拆分 Composer* / 附件面板组件里全部字面量命名空间 t() 键
  （200+ 个），锁定 zh-CN 与 en-US 必须同时可解析。

**落地后裁决**（`be53b8ba`，与两条 rel 枝对同一 bug 的竞争性修复收敛）：
cherry-pick 后该测试第三用例在 0824 上 1 红——它断言组件源码含
`aria-label={t('common:actions.more'`，但 0824 已在 Step 20 经
rel-i18n（#318）的 `40157848` → `01ed64bf` **有意**把该按钮收敛为复用
已翻译的顶层 `common:more`，且 `releaseUpgradeI18n.test.ts` 锁定
`AttachmentPanelBody.tsx` 不得再引用 `common:actions.more`（removedKeys
只禁组件源码引用，不禁 locale 词条存在；全树无其他 `actions.more`
消费者）。按第 7 节「修了根因的以既有断言为准」：组件保持
`common:more` 不回退，新契约第三用例改为断言按钮用 `common:more`，
同时把 rel-mobile 增补的 `actions.more` 词条锁定为双语可解析
（`1901780e` 的 locale 增量原样保留）。适配后
inputBarSplitI18nKeys 3/3 + releaseUpgradeI18n 3/3 全绿。

SKIP（不取）：`9d39c760`（rel-mobile 审查文档，以本节记录代替）。
不重放 Step 18/19/20 已落地源 SHA；未 push 隔离枝。

Composer* 拆分、附件 200/50、G 44px/safe-area/Android back、HPIAS
`session_id` 过滤与 18-block allowlist、#177 端口、finder 持久化加固
均未触及（本步改动面仅 2 行 locale + 1 个新测试文件 + 测试适配）。
`download-pdfium.sh` 对 `licenses/pdfium.txt` 的重写已恢复，未带入提交。

| 门禁（最终树 `be53b8ba` 上复跑） | 结果 |
| --- | --- |
| `npm run version:generate && npm run typecheck` | ✅ exit 0 |
| `npx vite build` | ✅ exit 0（仅既有 chunk 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ exit 0（28 条既有 warning，Rust 1.98） |
| `node scripts/check-migrations.mjs` | ✅ exit 0（111 个迁移文件） |

### Step 22 收口：质量评审 10 路修复 + 二检 reviewfix 加法落地

日期：2026-08-26。基座 `2d41ea8b`（Step 21 tip；fetch 后远端未前进，
无需 reset/fast-forward）。按序 `git cherry-pick -x` 十路质量评审修复
（fix 枝 + 二检 reviewfix 枝的加法提交，共 27 个源 SHA，零跳过），
未合并任何隔离枝/reviewfix 枝整枝，未使用 `-X theirs/ours`：

独立面（零冲突）：

- qbank（#332，`fix-qbank-session-a875`，无 reviewfix）：
  - `aa88dcbc` → `3fcebbb1`：练习进度按视图隔离；
- provider（#333，`fix-provider-mythos-a875`，无 reviewfix）：
  - `35706d09` → `55846040`：provider 能力门控与流完成修复；
- hpias（#331，`fix-hpias-honesty-a875`，同枝双提交，无独立 reviewfix）：
  - `0a7661e9` → `900fcc19`：默认 HPIAS 研究诚实化；
  - `5a41f06b` → `05ba27f4`：保留研究引文注释语义；
- mindmap/pdf/llm（#337，`fix-mindmap-pdf-a875`，无 reviewfix）：
  - `2387ca1a` → `5ffd4900`：.xmind 图片内联流式化 + 单次导入预算；
  - `70e7f193` → `1a0a7442`：recite 统计只记实际呈现/作答的空；
  - `7e6c7a95` → `a25d56e4`：PDF 选区工具栏 documentTitle 用 fileName；
  - `2c93d0d1` → `daf5b78e`：清理 `<|im_start|>assistant` 续写头。

Anki 面：

- QA（#328 + reviewfix #336）：
  - `3eb5c03e` → `1a5b6f6a`、`6ee51d64` → `d9a314cb`（#328）；
  - `b36b8356` → `7077075a`（#336：critic QA flag 持久化按
    enable_qa_pass 门控）；零冲突；
- CardAgent（#338 + reviewfix #341）：
  - `f7c38ca2` → `307449e2`（#338：FSRS 显式 opt-in、协议中立
    prompt、lossless-only JSON 修复、maxCards 全局配额）。
    **冲突 1**：`src-tauri/src/streaming_anki_service.rs` 测试区两侧
    同位新增——HEAD 侧是本步刚落地的 #336 QA 持久化契约测试，
    incoming 侧是 #338 的截断残卡拒收 + 无损修复两个测试。加法式
    解决：两侧测试全部保留（先 QA 契约测试收闭括号，再叠加 #338
    两测试），`rustfmt --check` 该文件通过；
  - `7a84b781` → `4756e93c`（#341：rustfmt 收口）；
- APKG/金标（#329 + reviewfix #335）：
  - `23460c69` → `d8a606c2`（#329：APKG 导入与 gold 溯源加固）；
  - `b0d52d32` → `08beff7e`（#335：更正 occlusion 导出文案）；零冲突。

备份 / 恢复 / 升级：

- backup（#334 + reviewfix #339）：
  - `5b90ee55` → `1523c285`：sealed 导入续传必须输入密码；
  - `3df483f2` → `3a1b79bb`：本地 ZIP 密码保护文案诚实化；
  - `be36cc95` → `87563bd4`（#339：清除云错误文案/用户指南残留的
    加密 ZIP 声明）；零冲突；
- restore（#330 + reviewfix #340）：
  - `1de660ab` → `2f4e79e9`：密钥随槽位切换一并提交；
  - `35b71885` → `2bc68277`（#340：crypto key 发布日志化，crash-safe
    cutover，新增 `crypto_publication.rs`）；零冲突；
- upgrade（采用 reviewfix #343 序列，比 #342 更完整；另取 #342 独有
  的测试对齐提交）：
  - `f577be11` → `5c3cb512`：迁移前 NULL-source anki 卡去重，避免
    UNIQUE abort（`apply_vfs_init_missing_tables` 等 coordinator 既有
    加法未触及，已核实仍在）；
  - `72999575` → `2c56db91`：存量短 E2EE 口令在恢复/导入/重输路径
    放行。**冲突 2**：`BackupTab.tsx` `handleImportConfirm`——HEAD
    侧含本步 `5b90ee55` 的 sealed 续传空密码守卫 + 导入最小长度校验，
    incoming 删除导入路径长度门禁。按第 7 节原则组合：保留 sealed
    续传非空守卫（0824 已有能力），删除导入路径
    `validateOptionalPassword` 长度门禁（本路修复；解密路径不设长度
    下限，口令错误由解封层 fail-closed）；`validateOptionalPassword`
    仍服务导出/新设口令路径，无 unused；
  - `5d800c8c` → `de56f37f`：云恢复补齐存量短口令路径；
  - `a26ab05f` → `31c0ea85`、`2ea25732` → `800f7121`、
    `2ee4a605` → `bc2a655b`：测试隔离/格式化收口；
  - `7789f68b` → `23eb0af6`（#342 独有测试对齐，**未 skip**）：核查
    发现其非冗余——`72999575`/`5d800c8c` 落地后，
    `BackupTab.zip-password.test.tsx` 的旧断言（导入短口令必须拒收）
    与 `r09-ux-cloud-storage.test.tsx` 的旧断言（performRestore 必须
    含 `isExplicitCloudEncryptionPasswordTooShort`）已与组件新行为
    矛盾，该提交是必需的净新增断言对齐。**冲突 3**（平凡）：
    `CloudStorageSection.cloudUi.test.tsx` 一行注释——其 mock 重置块
    已随 `a26ab05f` 落地，仅注释行冲突，采纳注释。

三处冲突均加法式解决，全树无残留冲突标记；零 SHA 跳过（27/27）。
docs-only/审计文档类源枝提交本就不在本次清单内。

本步**未跑**全量编译/Tauri 打包/cargo test 全量/vitest 全量（按本轮
硬规则），仅做定向核查：手工解冲突的
`streaming_anki_service.rs` 过 `rustfmt --check`、
`apply_vfs_init_missing_tables` 等 VFS coordinator 既有加法确认未回退、
`validateOptionalPassword` 导出路径引用完整。四门禁（typecheck /
vite build / cargo check / check-migrations）留待下一验证步在本 tip
上复跑；**Goal 不因本步完成**。未合 main，未 push 任何隔离枝。

### Step 23 收口：Step 22 tip 四门禁 + 18 不变量 + Tauri 实机

日期：2026-08-26。基座仍为 `f83e541b`（fetch 后远端未前进）。隔离枝
`cursor/0824-verify-step22-a875`（#344）在独立 worktree 复跑，**未**
整支 merge 该枝，本步只把实证记录加法写入官方文档。未改产品代码。

| 门禁（`f83e541b` 隔离复跑） | 结果 |
| --- | --- |
| `npm run version:generate && npm run typecheck` | ✅ exit 0（`0.9.44+16403.f83e541b`） |
| `npx vite build` | ✅ exit 0（1m 20s，仅既有 chunk 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ exit 0（28 条既有 warning，Rust 1.98，3m 10s） |
| `node scripts/check-migrations.mjs` | ✅ exit 0（111 个迁移文件） |

18 不变量在同一 tip 只读取证 **18/18 PASS**（进度仓
`docs/0824-static-audit/51-invariants-step22.md`）。leftover 第六轮
仍为结论 A：非 `0824-*` 开放 PR 115 个，无未吸收产品增量。

Tauri 实机：隔离 worktree `cargo build --bin deep-student` exit 0 后，
`DISPLAY=:1` 启动 debug 二进制。debug 带 `--cfg dev`，须先起 Vite
`:1422`（`tauri dev` 等价路径）；补 Vite 后窗口 1112×773 可交互，
Study Desktop / Chat Composer / 设置 Model Service / All Apps /
AI Dashboard 均渲染。未做 production 安装包，未发真实 LLM。
详见 `docs/dev/0824-verify-step22.md`。

未合 main，未 force-push，未整支 merge #344 / #326 / leftover 族。
