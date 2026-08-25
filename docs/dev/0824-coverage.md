# 0824 开放 PR tip 覆盖审计

审计快照：2026-08-25 00:33 UTC（第八轮，0824 已含 A+B+D）。

本表覆盖该时点仍开放的 PR #158–#268，共 111 个（无缺号）。判定对象是同一次
`git fetch` 固定下来的 `refs/pull/<PR>/head`，不是 PR 标题所指的旧底座：

- 0824：`4f05d2272217e91a899ed6261356eea1acafc438`
- B cloud（#177 tip，与主题分支 tip 重合）：`017bb297c4576305b018cafb54fcbe092612a6de`
- C genui（#214 tip，与主题分支 tip 重合）：`c2786d4b602c8271db0ad116aeb37b3c04fad5b5`
- D anki（#215 tip，与主题分支 tip 重合）：`f4f1300e85cf08fc4b2b2c9db7d6bc1f94d0019b`
- E optimization（#213 tip，与主题分支 tip 重合）：`746445fc61914e7eaad8522d7aa4b75083e42762`
- F subapp（#176 tip，与主题分支 tip 重合）：`97ee408c8b5c7df1087e15986b170a16bd248488`
- G mobile（#172 tip，与主题分支 tip 重合）：`e963b6df949aa3476c03f6d86c66007b480bba05`

0824 与各主题分支的合入边界（`git merge-base`）：

- D anki：tip `f4f1300e` 已经是 0824 祖先——D 已通过
  `a8185664` 全量合入，#215 本轮升格为 `IN_0824`。
- B cloud：0824 含 B 至 `fb77f0af`；B 之后又前进 27 个提交
  （R12 delta 系列原语、v1trust、P2 收尾等），#177 tip 尚未进 0824。
- C genui：0824 含 C 至 `c16a4fbd`；C 之后又前进 30 个提交，#214 tip 尚未进 0824。
- E optimization：0824 含 E 至 `65bad3ed`；E 之后又前进 4 个提交，#213 tip 尚未进 0824。
- F subapp / G mobile：与 0824 的 merge-base 均为 main tip `0e4c9fad`，
  两支与 0824 无任何 git 祖先重叠（F 的部分行为是按 0824 结构选择性移植进去的）。

`IN_0824` 与 `IN_THEME_ONLY` 均以
`git merge-base --is-ancestor <PR tip> <target tip>` 的精确祖先关系为准。
`LEFTOVER` 表示当前 PR tip 仍有未进入 0824 或 B–G 主题仓的独特增量；
`IGNORE` 表示精确 tip 不应再整支合入（有用部分已经选择性移植/等价吸收，
或该 tip 已明确被取代、冲突或弃用）。
本轮对 111 个 tip 全量逐项重算；分类未沿用旧表。

| PR | 状态 |
|---:|---|
| #158 | IGNORE |
| #159 | IGNORE |
| #160 | LEFTOVER |
| #161 | LEFTOVER |
| #162 | IGNORE |
| #163 | IGNORE |
| #164 | IGNORE |
| #165 | IN_0824 |
| #166 | IN_0824 |
| #167 | IGNORE |
| #168 | IN_0824 |
| #169 | IN_0824 |
| #170 | IGNORE |
| #171 | IN_0824 |
| #172 | IN_THEME_ONLY(G mobile) |
| #173 | IN_0824 |
| #174 | IN_0824 |
| #175 | IN_0824 |
| #176 | IN_THEME_ONLY(F subapp) |
| #177 | IN_THEME_ONLY(B cloud) |
| #178 | IN_0824 |
| #179 | IN_0824 |
| #180 | IN_0824 |
| #181 | IN_0824 |
| #182 | IN_0824 |
| #183 | IN_0824 |
| #184 | IN_0824 |
| #185 | IN_0824 |
| #186 | IN_0824 |
| #187 | IN_0824 |
| #188 | IN_0824 |
| #189 | IN_0824 |
| #190 | IN_0824 |
| #191 | IN_0824 |
| #192 | IN_0824 |
| #193 | IN_0824 |
| #194 | IN_0824 |
| #195 | IN_0824 |
| #196 | IN_0824 |
| #197 | IN_0824 |
| #198 | IGNORE |
| #199 | IN_0824 |
| #200 | IGNORE |
| #201 | IN_0824 |
| #202 | IN_0824 |
| #203 | IGNORE |
| #204 | IN_0824 |
| #205 | IGNORE |
| #206 | IN_0824 |
| #207 | IN_0824 |
| #208 | IGNORE |
| #209 | IGNORE |
| #210 | IGNORE |
| #211 | IN_0824 |
| #212 | IGNORE |
| #213 | IN_THEME_ONLY(E optimization) |
| #214 | IN_THEME_ONLY(C genui) |
| #215 | IN_0824 |
| #216 | IN_0824 |
| #217 | IN_0824 |
| #218 | IGNORE |
| #219 | IN_0824 |
| #220 | IN_0824 |
| #221 | IN_0824 |
| #222 | IN_0824 |
| #223 | IN_0824 |
| #224 | IN_0824 |
| #225 | IN_0824 |
| #226 | IN_0824 |
| #227 | IN_0824 |
| #228 | IN_0824 |
| #229 | IN_0824 |
| #230 | IN_0824 |
| #231 | IN_0824 |
| #232 | IN_0824 |
| #233 | IN_0824 |
| #234 | IN_0824 |
| #235 | IN_0824 |
| #236 | IN_0824 |
| #237 | IN_0824 |
| #238 | IN_0824 |
| #239 | IN_0824 |
| #240 | IN_0824 |
| #241 | IN_0824 |
| #242 | IN_0824 |
| #243 | IN_0824 |
| #244 | IN_0824 |
| #245 | IN_0824 |
| #246 | IN_0824 |
| #247 | IN_0824 |
| #248 | IN_0824 |
| #249 | IN_0824 |
| #250 | IN_0824 |
| #251 | IN_0824 |
| #252 | IN_0824 |
| #253 | IN_0824 |
| #254 | IN_0824 |
| #255 | IN_0824 |
| #256 | IN_0824 |
| #257 | IN_0824 |
| #258 | IN_0824 |
| #259 | IN_0824 |
| #260 | IN_0824 |
| #261 | IN_0824 |
| #262 | IN_0824 |
| #263 | IN_0824 |
| #264 | IN_0824 |
| #265 | IN_0824 |
| #266 | IN_0824 |
| #267 | IN_0824 |
| #268 | IN_0824 |

汇总：`IN_0824` 88；`IN_THEME_ONLY` 5
（B：#177，C：#214，E：#213，F：#176，G：#172）；
`LEFTOVER` 2（#160、#161）；`IGNORE` 16。

相对上一轮（B 合入后快照）的变化：

- #215（D anki）：`IN_THEME_ONLY(D)` → `IN_0824`。D 主题分支已随
  `a8185664` 全量并入 0824，PR tip 即 D tip。
- #177（B cloud）：`LEFTOVER` → `IN_THEME_ONLY(B)`。PR tip 现与 B 分支 tip
  重合（`017bb297`），上一轮多出的 `recoveryKind` 增量已回到 B 主线；
  但 B 在 0824 合入边界 `fb77f0af` 之后仍有 27 个提交未进 0824。
- #213（E optimization）：`LEFTOVER` → `IN_THEME_ONLY(E)`。PR tip 现与 E 分支
  tip 重合（`746445fc`），post-Step-1 增量已收进 E；E 比 0824 边界多 4 个提交。
- #214（C genui）：`LEFTOVER` → `IN_THEME_ONLY(C)`。PR tip 现与 C 分支 tip
  重合（`c2786d4b`）；C 比 0824 边界 `c16a4fbd` 多 30 个提交。

## 非祖先 tip 的处置依据

- `LEFTOVER`：
  - #160：F 已吸收大部分，但本轮内容级抽查确认 F tip（`97ee408c`）仍缺
    独特增量——F 仍保留 #160 删除的未渲染 `PracticeModeSelector.tsx`；
    `questionBankStore` 的 streak/answered 持久化未吸收
    （#160 中 6 处 `streak` 引用，F 仅 1 处）；`.apkg` 导入仅部分吸收
    （F 的 `LibraryScreen`/`libraryStore` 缺 #160 的对应改动）。
  - #161：F tip 完全缺失 `ImmersiveHint.tsx/.css`（沉浸模式可见出口）与
    `workbench-shell-ux.test.tsx`；关窗拦截、快捷键可发现性等其余壳层
    改动在 F 中也只有部分对应。
- `IGNORE`（沿用前几轮内容级结论，本轮 tip 未变化）：
  - #158 的有效叶提交已由 #169/#180/#181/#182/#186、A/T 或等价补丁吸收；
    其中删除已投入运行的 UTF-8 decoder 不应重放。
  - #159/#164 的有用子集已选择性移植进 A；其余与 A 等价或冲突，不能把原 tip
    整体再合入。
  - #162/#163/#167 的有用行为已按 F 当前结构移植；原 tip 不应复活旧结构。
  - #170、#198、#200、#203 分别因虚构模型、错误的 200MB 图片语义、被新
    special-token 实现取代、与 #209 契约冲突而明确弃用。
  - #205/#208/#209/#210/#212/#218 已按当前实现重放到随 A 一并进入 0824 的
    T tests；重放提交不是原 tip 的 Git 祖先，原 tip 无需再合。
