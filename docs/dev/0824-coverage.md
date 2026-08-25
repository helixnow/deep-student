# 0824 开放 PR tip 覆盖审计

审计快照：2026-08-25 13:05 UTC（第十六轮）。官方 0824 固定在
`2d41ea8b`；#177 按当前开放 PR tip `89808fd8` 判定，其应保留内容已在
Step 17 前后全部等价落地。

范围包括该时点仍开放的 PR #158–#268（111 个，无缺号），以及编号更大且
head 以 `cursor/0824-` 开头的开放 PR（48 个），合计 159 个：

- 官方 0824：`origin/cursor/0824-cde6` @
  `2d41ea8baca24e96ef02770a3a9b56ec0b87043d`
- 上一轮目标：`991227c26703f6b59bd7bb1a739ef9fdcf971157`
  （本轮官方 tip 在其后新增 4 个提交，覆盖 Step 21）
- #177 当前开放 tip：
  `89808fd8a5470e03eb2383ee6375c81b90f10d28`
- 本次更新前 #293 tip：
  `6fa11849fde492bffe5d7f0c235b3ba8be75795a`
- 关键源 tip：#160 `7c1a5094595f0ee3323135a597cc769305388cd7`；
  #172 `e963b6df949aa3476c03f6d86c66007b480bba05`；
  #176 `97ee408c8b5c7df1087e15986b170a16bd248488`；
  #213 `746445fc61914e7eaad8522d7aa4b75083e42762`；
  #214 `c2786d4b602c8271db0ad116aeb37b3c04fad5b5`；
  #215 `f4f1300e85cf08fc4b2b2c9db7d6bc1f94d0019b`

状态定义：

- `IN_0824`：精确 PR tip 满足
  `git merge-base --is-ancestor <PR tip> 2d41ea8b...`。
- `IN_THEME_ONLY`：精确 tip 不是 0824 祖先，但仍是待落主题仓祖先；本轮为 0。
- `CONTENT_EQUIV`：精确 tip **不是** Git 祖先，但其待保留内容已通过 patch-id
  等价 cherry-pick 或按当前结构适配移植；不能把它表述成祖先关系。
- `ALREADY`：隔离/rel PR 的已裁决 `INCLUDE` 已进入 0824；PR tip 本身因
  docs、merge commit 或不同 cherry-pick SHA 仍不是祖先，不应整枝再合。
- `INCLUDE`：仍有已核实的独特产品或测试增量，应从源枝按提交取用。
- `LEFTOVER`：仍有应该进入 0824 的独特 `INCLUDE`。
- `IGNORE`：不应再整枝合入；产品已吸收，或只剩已裁决的 `ALREADY`、
  过期文档、预演 merge、CI shard / `DROP`。

精确祖先检查结果：

- #158–#268：90/111 为 0824 祖先，21/111 不是。
- 编号更大的 48 个 0824 PR：仅 #269 的 tip 是 0824 祖先，另 47 个不是。
- 合计 91/159 为祖先、68/159 不是；表中 91 个 `IN_0824` 与结果逐项一致。
- 关键点：#172、#176、#215 为祖先；#160、#177 当前 tip、#213、#214
  均不是。

关键项的内容裁决：

- #177 改记 `CONTENT_EQUIV`：当前开放 tip `89808fd8` 不是 `2d41ea8b`
  的祖先。Step 17 对 `0824..#177` 的 14 个提交复核中，12 个已与此前端口
  patch 等价；另两个分别以 `edd5672d` → `957fe6d7`、`89808fd8` →
  `172fd10d` 落地，当时 `git cherry 0824 #177` 已无 `+` 残留。此前
  `4bebbf81`、`394851a7`、`587cfccd`、`af414ed6`、`947910db`、
  `06f32d0e`、`6887bf84`、`bf8ab827` 等有效端口同样必须保留。
- #160 记为 `CONTENT_EQUIV`。其产品主体已由 F 吸收；缺失回归测试已由
  `f38d0041` 适配移植（`AnkiTasksApp.loadError.test.tsx` 与
  `todayScreenEmptyLibrary.test.tsx`），scheduler 顺序与 brand token 尾款由
  `41587d48` 落地。源 tip 仍不是祖先，但审计过的产品/测试 `INCLUDE` 已齐。
- #213 记为 `IGNORE`：最后两个 `INCLUDE` 已按当前树移植为
  `e83d4081`（provider-contract parser）与 `6a903224`（rustfmt）；
  `746445fc` 的旧测试修改和 `e311daa4` 的 skill 契约均已实测
  `ALREADY` 或会回退当前契约，没有剩余 `INCLUDE`。
- #214 改记 `CONTENT_EQUIV`：30 个独特提交复核中的唯一 `INCLUDE` 是
  generative-ui 内置 skill 名称/描述 i18n。隔离枝提交 `5cf6dccf` 已由
  0824 的 `414abdc7` 以相同 patch-id `dc567c3e...` 落地；其余 23 项
  `ALREADY`、6 项 `DROP`，源 tip 虽非祖先但待保留内容已齐。
- #312 记为 `ALREADY`：两个纯测试提交已在 Step 17 以 `c8f40a01`、
  `54da9c33` 落地；其余仅为隔离报告。
- #313–#323 均记为 `ALREADY`：Step 18–20 已按提交吸收 finder、anki、
  restore、mainbackfill、llmusage、i18n、VFS、chat、leftover-rescan
  集成测试、schema lock 与 cloud markerless 修复；源枝审计文档与 merge
  commit 不重放。
- #324 改记 `ALREADY`：Step 21 已以 `96a1ca42`、`2e788607`、
  `be53b8ba` 吸收 zh-CN/en-US locale 项及 split input-bar i18n 契约测试；
  组件键保持 `common:more`。源枝 docs tip `9d39c760` 仍不整枝合入。

| PR | 状态 |
|---:|---|
| #158 | IGNORE |
| #159 | IGNORE |
| #160 | CONTENT_EQUIV |
| #161 | IGNORE |
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
| #172 | IN_0824 |
| #173 | IN_0824 |
| #174 | IN_0824 |
| #175 | IN_0824 |
| #176 | IN_0824 |
| #177 | CONTENT_EQUIV |
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
| #213 | IGNORE |
| #214 | CONTENT_EQUIV |
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

#158–#268 小计：`IN_0824` 90；`IN_THEME_ONLY` 0；`CONTENT_EQUIV` 3
（#160、#177、#214）；`LEFTOVER` 0；`IGNORE` 18。

## 编号更大的开放 0824 PR

只列冻结时仍开放且 head 为 `cursor/0824-*` 的 PR；已关闭的
#272–#274、#276–#278、#285–#286 不在范围内。

| PR | 冻结 tip | 0824 精确祖先 | 状态 |
|---:|:---|:---:|:---|
| #269 | `2d41ea8b` | 是 | IN_0824 |
| #270 | `bc26f121` | 否 | IGNORE |
| #271 | `ae3207ff` | 否 | IGNORE |
| #275 | `d2762072` | 否 | IGNORE |
| #279 | `a121e9df` | 否 | IGNORE |
| #280 | `b2dbbe71` | 否 | IGNORE |
| #281 | `904cca53` | 否 | IGNORE |
| #282 | `c8eb191f` | 否 | IGNORE |
| #283 | `93a890d1` | 否 | IGNORE |
| #284 | `67ea40f7` | 否 | IGNORE |
| #287 | `0b0fe816` | 否 | IGNORE |
| #288 | `051c06e7` | 否 | IGNORE |
| #289 | `5a0eab09` | 否 | IGNORE |
| #290 | `dba60698` | 否 | IGNORE |
| #291 | `884f402d` | 否 | IGNORE |
| #292 | `0aab5fd7` | 否 | IGNORE |
| #293 | `6fa11849` | 否 | LEFTOVER |
| #294 | `76be463d` | 否 | IGNORE |
| #295 | `02172aa6` | 否 | IGNORE |
| #296 | `60d1cbbf` | 否 | IGNORE |
| #297 | `cb48a5d7` | 否 | IGNORE |
| #298 | `4d236cb8` | 否 | IGNORE |
| #299 | `bf8f1b72` | 否 | IGNORE |
| #300 | `0c07e5e2` | 否 | IGNORE |
| #301 | `119f9f0b` | 否 | IGNORE |
| #302 | `fe7a61f9` | 否 | IGNORE |
| #303 | `f62082e7` | 否 | IGNORE |
| #304 | `03bbc4f8` | 否 | IGNORE |
| #305 | `52d30c05` | 否 | IGNORE |
| #306 | `52e1b424` | 否 | IGNORE |
| #307 | `f5b8bc9f` | 否 | IGNORE |
| #308 | `ec66d3a5` | 否 | IGNORE |
| #309 | `1be75038` | 否 | IGNORE |
| #310 | `ab03bab3` | 否 | IGNORE |
| #311 | `8f84c745` | 否 | IGNORE |
| #312 | `10ccd369` | 否 | ALREADY |
| #313 | `f2b55909` | 否 | ALREADY |
| #314 | `465f0872` | 否 | ALREADY |
| #315 | `2ba5522d` | 否 | ALREADY |
| #316 | `3d3516c3` | 否 | ALREADY |
| #317 | `c4a3382c` | 否 | ALREADY |
| #318 | `a6e2621b` | 否 | ALREADY |
| #319 | `13d45b0a` | 否 | ALREADY |
| #320 | `8e6d8e8f` | 否 | ALREADY |
| #321 | `cb842c8a` | 否 | ALREADY |
| #322 | `b0cdd9fe` | 否 | ALREADY |
| #323 | `e9952820` | 否 | ALREADY |
| #324 | `9d39c760` | 否 | ALREADY |

新增范围小计：`IN_0824` 1；`IN_THEME_ONLY` 0；`CONTENT_EQUIV` 0；
`ALREADY` 13（#312–#324）；`INCLUDE` 0；`LEFTOVER` 1（#293）；
`IGNORE` 33。

处置依据：

- #270/#271/#275 与 #279–#302 是已被官方合成取代的主题、leftover 或预演
  整枝。它们的 merge / 文档 tip 不是 0824 祖先，但产品 `INCLUDE` 已进入
  `2d41ea8b`；旧合成树不应再合。
- #303 的 #160 测试与产品尾款已分别由 `f38d0041`、`41587d48` 落地；
  #304 的可保留回归增量已由 `08b81e29` 落地；#305 的 18 项不变量结论已在
  官方 merge plan 中持续复验。三者剩余均为隔离枝记录，记 `IGNORE`。
- #306–#308 分别是 #213 余项裁决、18 项不变量复验和全量 leftover 扫描；
  均为不应整枝合入的隔离文档。#309 的唯一产品 `INCLUDE` 已以 `414abdc7`
  等价进入官方 0824，剩余为 #214 审计记录，因此也记 `IGNORE`。
- #301/#302 的 G 差异结论和落地结果已进入官方 Step 8 记录；不重合旧审计枝。
- #310/#311 分别是 Step 15 不变量与编译门禁报告，仅作对照，记 `IGNORE`。
  #312 的两个测试已由 Step 17 吸收，记 `ALREADY`。
- #313 的 finder 两提交由 Step 18 吸收；#314–#317 的 anki、restore、
  mainbackfill、llmusage 由 Step 19 吸收；#318–#323 的 i18n、VFS、chat、
  leftover-rescan 测试、schema lock、cloud markerless 由 Step 20 吸收。
  这些 rel/隔离 PR 均记 `ALREADY`，不得整枝重放。
- #324 的 locale 修复与契约测试已由 Step 21 的 `96a1ca42`、
  `2e788607`、`be53b8ba` 吸收，组件键保持 `common:more`，记
  `ALREADY`；`9d39c760` 为 docs-only 收尾，不随产品提交取用。
- #293 是本覆盖审计本身，仍有应合入 0824 的唯一文档增量，因此在冻结快照中
  是唯一 `LEFTOVER`；它不是产品或测试缺口。

## 汇总与剩余项

159 个开放 PR 总计：

- `IN_0824` 91
- `IN_THEME_ONLY` 0
- `CONTENT_EQUIV` 3（#160、#177、#214）
- `ALREADY` 13（#312–#324）
- `INCLUDE` 0
- `LEFTOVER` 1（#293，仅本审计文档）
- `IGNORE` 51

剩余产品/测试 `INCLUDE`：**无**；剩余文档 `LEFTOVER`：**#293**。
#213 没有剩余 `INCLUDE`，#160/#177/#214 已内容等价。0824 中已落地的
#177 cloud ports 必须保留。
