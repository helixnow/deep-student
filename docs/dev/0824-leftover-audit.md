# 0824 leftover 审计（第五轮）

日期：2026-08-24

## 结论

- 对照基线：
  - `origin/cursor/0824-cde6` @ `eec20398`
  - `origin/cursor/0824-leftovers-cde6` @ `a121e9df`
  - F `origin/cursor/0824-theme-subapp-cde6` @ `115b202a`
- `cursor/0824-leftovers-cde6` **禁止直接合入 0824**。它从 Step 1 基线
  `8361e6b7` 分叉，早于 0824 的 H cache 合入；直接比较其 tip 会删除 H 的迁移、
  prefix-freeze、cache telemetry 和相关文档/测试。
- **不要再次 merge #213 或 #214 整个 PR**。0824 Step 1 已分别 merge：
  - #213 到 `65bad3ed`（merge commit `6f636ad5`）
  - #214 到 `c16a4fbd`（merge commit `23090166`）
- 第四轮追加的 32 个 #213/#214 提交不是 Step 1 基线本身，而是两个 PR 在
  Step 1 tip 之后新增的 delta。重放到最新 0824 后：
  - #213 的 4 个中，Rust 格式提交 `c68ce29d` 已被 Step 2 的 `45222efe`
    覆盖，cherry-pick 为空，剔除；
  - #213 其余 3 个仍是独特 CI/测试修复；
  - #214 的 28 个仍是独特的产品加固、测试与 CI 修复。
- F tip 与第四轮审计相同。F 仍未包含 #160/#161 的 6 个能力增量，因此
  leftovers **没有被 0824+F 完全取代**，不能标记 `SUPERSEDED`。
- 已从最新 0824 重建 clean 分支，只重放下面列出的 37 个独特提交；旧分支的
  两个审计文档提交 `f2a8f675`、`a121e9df` 未搬运。

## #160/#161 相对 F 的独特能力

F @ `115b202a` 与第四轮核验时 tip 一致，以下缺口仍成立：

| leftovers 来源 | clean 提交 | 独特内容 |
|---|---|---|
| `87117108` | `638e13df` | 卡库手动新建与 `.apkg` 导入入口 |
| `219e2b82` | `1de96c8d` | 已有 pomodoro/todo 宿主时隐藏悬浮计时药丸 |
| `cac37349` | `67a5909d` | 题库 streak、正确数、已答集合进入 store，切视图不丢 |
| `6d7a829c` | `7b852b43` | 删除未渲染的 `PracticeModeSelector` |
| `3cdf4ac9` | `832edccf` | workbench 引导、桌面组件开关、Expose inert、恢复 CTA 等 |
| `d4380660` | `69b96b1f` | 为卡库新入口补齐中英文 i18n key |

这些提交触碰 F 大改过的 flashcards/practice/workbench 文件。后续正式合成时应先
合 F，再按行为重放这 6 项；不要把旧 leftovers 分支整体 merge 进去。

## #213 post-Step-1 delta

| upstream #213 | leftovers 提交 | clean 提交 | 处置 |
|---|---|---|---|
| `c986c8d1` | `c68ce29d` | — | 重放为空；已由 0824 `45222efe` 覆盖 |
| `a40c16a0` | `86daf865` | `e1fa9bce` | 保留 |
| `e311daa4` | `74ee5026` | `10f1ad16` | 保留 |
| `746445fc` | `dc7e24ea` | `817b9fd5` | 保留 |

## #214 post-Step-1 delta

以下 28 个提交全部位于 Step 1 已合 tip `c16a4fbd` 之后，且相对最新 0824
仍有非空补丁。这里只允许使用该精确 allowlist；不得重新 merge #214。

| leftovers 提交 | clean 提交 | 主题 |
|---|---|---|
| `6b4b5c5e` | `b8cec842` | 保留 matchMedia 测试设置 |
| `949ff1e1` | `a10da59d` | note-edit 禁止 regex 转发 |
| `32e44317` | `6047ef94` | Rust noteEdit 256 KiB 上限 |
| `c0e8fe43` | `ef74bf72` | Rust noteEdit 字段白名单 |
| `cfac845c` | `703cf00a` | TS/Rust researchSessionId 清洗 |
| `1194f01b` | `be793515` | 拒绝超过 256 KiB 的完整 intent |
| `f9690075` | `ba64fda1` | stream-cap 错误分类 |
| `8f6f7bf3` | `3422f212` | Rust/lint/vitest 修复 |
| `dc8c16bd` | `74444f6b` | sessionId 契约与 sanitizer 加固 |
| `8e566ac1` | `d7136698` | HPIAS session 隔离与 host action 包装 |
| `e18265d4` | `e780db9e` | research store 忽略外部 session 事件 |
| `393b46df` | `a6b23b3f` | 无控制字符字面量的 regex 构造 |
| `5b7ef9f2` | `a0dd7b9d` | 并发 HPIAS session store slices |
| `b8ec6e1f` | `24dbfb42` | frontend build heap |
| `b91f4623` | `3d8abb3e` | 单一 HPIAS listener 与 style/srcdoc 清洗 |
| `73e43602` | `b868c0ed` | Style Lab reset 保留其他 HPIAS slices |
| `e7390489` | `40464691` | 隐藏未注册 action 与 build heap |
| `26079980` | `039ca537` | 跳过空 ActionBar toolbar |
| `00d59508` | `9bdf8169` | undo stack 隔离与 action bar skip-link |
| `272aed70` | `e6d1ffdd` | generative-ui e2e / Vitest shard 4 |
| `087a7fdb` | `a39cb125` | URL 清洗与 briefing defaultValue |
| `6c6dc132` | `92bcb5a5` | 隔离外部 session_started |
| `6e08740c` | `9127956c` | Vitest heap 与 Windows UA |
| `24c97e26` | `ab485aa1` | Rust ingress 18 种 block allowlist |
| `bce368e3` | `58e4af56` | Vitest 拆为 8 个单 worker shard |
| `4c095774` | `da42b498` | Tauri e2e 拒绝未知 block type |
| `3ade1c8e` | `2fe74ba6` | 本地化 skill 与 shard 契约刷新 |
| `5f975cca` | `6c833a7f` | shard 4 restore/timeout/PDF 契约 |

## Clean 分支

- 基线：`origin/cursor/0824-cde6` @ `eec20398`
- 分支：`cursor/0824-leftovers-clean-dc0b`
- 独特提交：37（#160/#161 共 6、#213 共 3、#214 共 28）
- H cache 保护核验：相对 0824，没有删除
  `V20260824__add_cache_write_tokens.sql`、`prefix_snapshot_tests.rs`、
  `scripts/test_cache_hit_report.py` 或 `docs/dev/sota-conversation-core/**`。
- 唯一 cherry-pick 冲突：`8f6f7bf3` 与 Step 2 的 `2f7eec54` 都修改
  `parse_note_edit_accepts_append_payload`。保留 post-Step-1 的 owned `Value`
  形态，使用 `note_edit.get(...)`，避免旧的 `Option<Value>` 借用写法。

## 门禁

构建与测试结果在 clean 分支首次 push 后记录。
