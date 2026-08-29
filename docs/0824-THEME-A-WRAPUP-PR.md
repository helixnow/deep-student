# 0824 主题仓 A（wrapup）收口记录 / 待开 draft PR

分支：`cursor/0824-theme-wrapup-cde6`（底座 PR #268 `cursor/sota-wrapup-0b49` @ `1306b85a`）
目标 base：`cursor/0824-cde6`（PR #269 所在统一分支；若 GitHub 不允许则退回 main）
开 PR 入口：https://github.com/helixnow/deep-student/compare/cursor/0824-cde6...cursor/0824-theme-wrapup-cde6

> 本文件即拟用的 draft PR 描述（仓库 PR 模板格式）。本轮执行环境的 GitHub 凭证仅有推送权限、无 createPullRequest 权限（gh CLI 与 REST API 均 403），故先以文档形式随分支记录。

## PR 标题

[0824 主题仓 A] wrapup 收口：#268 底座 + finderStore 分桶/ResourceIcons 暗色 token/ErrorBoundary 真重试/#175 文档

## PR 正文

### Summary

0824 主题仓 A（wrapup）收口分支。底座为 PR #268（`cursor/sota-wrapup-0b49`，HEAD `1306b85a`，已吸收约 85 个 i18n/a11y/模型/流式小 PR），在其上按 `docs/0824-MERGE-PLAN.md`（见 `cursor/0824-cde6`）补齐剩余独特改动。本 PR 面向 0824 统一合并分支 `cursor/0824-cde6`，不改 main。

### Changes

**吸收（4 个移植提交 + 1 个文档合并）：**
- `d15d9ff6`（#164）finderStore 按 hostId 分桶：files/page/canvas/group-picker 各自实例化、persist 独立 key（`learning-hub-finder:<bucket>`），画布与学习中心不再互相带走落点；含 11 个用例的 `finderStoreHostBuckets.test.ts`。cherry-pick 时只落 6 个 finderStore 相关文件——该提交混入的 command-palette a11y / DataGovernance / 设计 token 契约测试部分与 #268 已吸收的 `a11y-command-palette-data-governance-ecb3` 分支重叠（差异仅为注释措辞，且 #268 侧另有 tRef 防自激循环修复），冲突全部按保留 #268 解决。
- `6fa9382a`（#159）ResourceIcons 走 `--resource-icon-*` 主题 token，暗色下资源图标不再是刺眼浅色块（tsx 内联浅色 hex 保留为 fallback）。
- 补移植 #159 `416f6fa4` 的 resource-icon token 定义子集（仅此子集；其余 token-gap/暗色阴影部分 #268 已有同名契约测试覆盖的等价实现）。color-mix 派生值按本仓 `theme-colors.css` 既有的 `@supports` 降级模式收纳。
- `bc392d54`（#159）ErrorBoundary 内联兜底按钮从「假刷新」（`setState({hasError:false})` + 刷新文案）改为调共享 `resetError` + 新 `error_boundary.retry` 文案；`error_boundary.refresh` 留给真会 reload 的 TopLevelFallback。
- merge #175（`cursor/sota-responses-cache-review-6117`）：纯文档，`docs/dev/sota-conversation-core/` 下 15 个 Responses/缓存审计文件，与 #268 CLEAN。

**跳过（按计划）：**
- #170 mythos-5（#268 判定为虚构模型）、#198 图片入口 200MB（与现行「文件 200MB / 图片 50MB」冲突）、#200 旧 token 剥离（已被 #268 `model_special_tokens.rs` 取代）。
- #268 已吸收的约 85 个小 PR 不再整支 merge。
- `d15d9ff6` 中与 #268 重叠的 command-palette/DataGovernance/token 契约测试部分（见上）。
- #159 其余两个提交（`416f6fa4` 非 resource-icon 部分、`8f08b3c9` 按钮字号 token）——#268 已有等价物。

### How to test

编译门禁（本地全部通过）：
- `npm ci` ✅
- `npm run version:generate && npm run typecheck` ✅（`src/version.ts` 为 gitignore 生成文件）
- `npx vite build` ✅（1m9s，仅既有 chunk 体积警告）
- `cargo check --manifest-path src-tauri/Cargo.toml --lib` ✅（Rust 1.98，23 个既有警告，0 错误）

附加验证（非门禁）：`npx vitest run` 新增 `finderStoreHostBuckets.test.ts`（11 用例）+ `errorBoundaryCopy.test.tsx`（6 用例，含 retry 断言）全过。

环境备注：cargo check 需 Rust ≥1.91（lockfile 中 libsqlite3-sys 0.38 用 `cfg_select`）、`protobuf-compiler`、GTK/WebKit 系统库，以及 `bash scripts/download-pdfium.sh` 拉取 pdfium 资源。

### Screenshots / Logs

无 UI 截图（云环境）。暗色资源图标效果由 `--resource-icon-*` token 的 color-mix 比例翻转驱动，可在 `.dark` 下查看学习中心 finder 网格验证。

### 残留风险

- resource-icon token 定义是从 #159 手工摘取的子集并改用本仓 `@supports` 降级模式收纳，非逐字 cherry-pick；无 color-mix 的老 WebView 上暗色图标退回浅色（与现状一致），属预期降级。
- finderStore 分桶改变 persist key（`learning-hub-finder` → 默认桶保留原 key，新宿主用 `learning-hub-finder:<bucket>`），canvas/page 宿主首次升级后落点重置一次。
- 本分支与主题仓 B/D/F/G 后续归并时的已知冲突热区（ftp/s3/webdav、`streaming_anki_service.rs`、`useMessageActions.ts`）按总计划第 7 节处理，不在本 PR 范围。
- vitest 全量未跑（非本阶段门禁），CI 状态不作为本轮判据。

### Third-party content
- [ ] 本 PR 包含第三方代码 → 来源与许可证：

### Checklist
- [x] I ran `npm run build` and `cargo build` locally（typecheck + vite build + cargo check --lib）
- [x] I updated docs/README if needed（#175 审计文档随合并进入）
- [x] I linked the related Issue(s)（#268 底座；移植 #164/#159/#175；跳过 #170/#198/#200）
- [x] I have read the [CLA](https://github.com/helixnow/deep-student/blob/main/.github/CLA.md) and will sign it when prompted by the CLA bot
