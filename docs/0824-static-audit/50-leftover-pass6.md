model=gpt-5.6-sol-xhigh-fast
# 0824 leftover 第六轮复扫（pass 6）

- 执行时点：2026-08-26T08:39:38Z（UTC）。
- 基座：`origin/cursor/0824-cde6` @ `f83e541b1deaf65d9e9c4ac6f4755a73f4c19580`（Step 22 tip）。
- 对照：`origin/main` @ `b2a85a6900034943a2bedb7c5ebcf95ec7854fea`。
- 开放 PR 数：**182**；排除 head 名以 `cursor/0824-` 或 `0824-` 开头的 67 个后，非 `0824-*` 数：**115**。

## 结论

**A：无未吸收产品增量。**

必须吸收的 SHA：**无**。

本轮用 GitHub 当前 `headRefOid` 抓取 115 个非 `0824-*` 开放 PR head，OID
核对为 115/115；逐 head 执行
`git cherry origin/cursor/0824-cde6 <head> origin/main`，再按产品路径口径
排除 `docs/`、`.github/`、`wrapup/`、`tests/`、`playwright/`、
`dstu-test/` 及全部 `*.md`。结果仍为：

- **96 个**没有产品路径 `+`；
- **19 个**存在历史产品路径 `+` 候选，共 64 个提交，PR 集合仍恰好是
  #113、#134、#155、#158、#159、#160、#161、#162、#163、#164、#167、
  #170、#198、#200、#203、#209、#213、#214、#218；
- 非 `0824-*` 数仍为 115，最新更新时间仍是 #177 的
  `2026-08-25T08:28:42Z`，上述 head 均未较 pass 3/5 前进，也没有新出现的
  非 `0824-*` PR。因此维持既有处置：已适配吸收 / 既定拒绝 / 纯测试或
  工具链 / 过旧机器人，不机械回放旧 patch。

历史 19 个候选的处置未变：#159/#160/#161/#162/#163/#164/#167 已由主题
提交或后续端口适配吸收；#158 的工具链改动和会删除现役 `utf8_stream`
的改动继续拒绝；#170/#198/#200 分别会恢复伪能力、放宽图片面至 200MB、
回退现行流式解码链，继续拒绝；#203/#209/#218 只有测试契约调整；
#113/#134/#155 为过旧冲突、CI 稳定化或 release-please 版本提交。

## 点名 PR

- #177 head 仍为 `89808fd8a5470e03eb2383ee6375c81b90f10d28`；
  `git cherry` 为 `+0/-14`，无独特产品提交。
- #213 head 仍为 `746445fc61914e7eaad8522d7aa4b75083e42762`；
  `git cherry` 为 `+3/-1`。三个历史 `+`
  `c986c8d1`、`a40c16a0`、`746445fc` 的 parser/rustfmt 语义已适配落地，
  其余会弱化契约或仅调整当前已绿测试，维持 DROP。
- #214 head 仍为 `c2786d4b602c8271db0ad116aeb37b3c04fad5b5`；
  `git cherry` 为 `+30/-0`，其中产品路径 `+` 仍为历史 25 个。
  GenUI/HPIAS 产品语义已由 leftovers-safe 适配吸收，其余为 CI/docs，
  勿整支合并。
- #268 head 仍为 `1306b85acb2b6c4063b45b5e01f0cacea99555a4`；
  `git cherry` 为空，且该 head 是当前基座祖先。

四个点名 head 均未移动。

## main 与无 PR 治理枝

- `git cherry origin/cursor/0824-cde6 origin/main` 仍只显示
  `+ b2a85a69`。基座包含 `5f324e1f`；对
  `src-tauri/src/data_governance/migration/coordinator.rs` 重做新增行
  多重集合比较，main 为 226 行、0824 端口为 261 行、main 独有 0 行、
  端口独有 35 行。`5f324e1f` 仍是语义加法式超集，不得整支 merge main
  或重复摘取 `b2a85a69`。
- `origin/cursor/governance-abg-audit-6b8b` head 为
  `450bbc0d2231347392d8bd19073ab89f98357b30`，GitHub 全状态查询无关联 PR。
  相对基座的 `git cherry +` 共 36 个；逐提交、逐路径筛选得到产品提交 0、
  产品路径 0，改动均在 `docs/0824-static-audit/*.md`，只是静态审计文档枝。

## Step 22 与重复主题

开放 PR 从 pass 5 的 166 增至 182，新增 16 个正好是 #328–#343，head
均属 `cursor/0824-*`，不计入 leftover。当前基座从旧 tip `2d41ea8b` 到
`f83e541b` 已包含对应的 qbank、provider/HPIAS、mindmap/PDF/stream、
Anki QA/CardAgent/APKG、backup/restore/migration 修复及 reviewfix。

个别隔离 head 因官方落地时重新组合、格式化或补齐测试，patch-id 仍可能显示
`+`：#338/#341 的 `f7c38ca2` 已由 `307449e2` + `4756e93c` 承载；
#342/#343 的短口令改动及测试已由 `2c56db91`、`de56f37f`、
`31c0ea85`、`800f7121`、`bc2a655b`、`23eb0af6` 承载。这不构成未吸收
产品增量。**#328–#343 已落地、勿再整支 merge。**

#327 与 #328 主题重复；对当前基座复核为 `+0/-2`，官方已收等价提交，
**勿整支 merge**。

本轮不改代码。
