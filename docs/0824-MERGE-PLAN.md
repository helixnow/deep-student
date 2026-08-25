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
