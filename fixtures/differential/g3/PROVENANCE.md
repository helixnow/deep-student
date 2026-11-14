# G3 证据基线核对（2026-11-06 15:52Z 快照）

本次只读核对代码、原件与队列；不修改 receipt、不合 main、不重录、不重编 Rust。
本文件不宣称集成门禁通过，也不把现有录制追认为当前 main 同树证据。

## 代码与输入基线

机器证据：`provenance-20261106T1550Z.json`。

- 核对时 HEAD：`974e1fbeaa21b0c183a41b6c016ba594f6b0a817`。
- 核对时 main：`84b290accaa2317a479e4e64a3b3e94bd941c28e`。
- merge-base：`383ce24280c00ca4d2cbe8352ded8c12da4316bb`；HEAD 独有 58 commits、main 独有 22 commits，二者已分叉，不能只称“同 main”。
- HEAD Host tree（Git object ID）：`bb20323243f5a015040806b4c83125ec51cb81d1`；main Host tree：`1761d5c9880539b6e6d2d0d2343f6b497ac2d158`。
- `host`/`electron` 相对 main 有 20 项路径差，完整名单、11 项范围拒绝文件的 blob ID 与当前字节 SHA-256 均见机器证据。包含其他会话历史代码，不自行删除或反向覆盖。
- 场景树快照含 222 个输入/sidecar 文件；每份列 working SHA-256、HEAD/main blob ID 和 compare 声明的 inputSha256。观察到的 compare 输入哈希与当前输入不符数为 0；其中 `host/plugins/backup/equivalence/g3-missing.json` 不在 main，这不证明所有场景已在 main。
- B 样例 summary/trace 没有录制 HEAD/hostTree 字段，**录制代码 base 未知**。当前 Host tree 只说明此次核对的代码，不能用它倒填旧 B receipt。

## A 构建与模板版本差

原 receipt：`fixtures/differential/wp043/builds/20261106023719-bc16bc/receipt.json`，SHA-256
`24c9f5b77e2b63a8b0f9d9a9ea2031ad603068b62fb72f3bfd9fe8bf17bdcf3b`。
原 submittedRevision=`ec19ff0f1`，rustSourceTree=`cff4c0cc6eddd710a71e87cb814bf20bc0384516`；
原 binary SHA-256=`102b48358f08f7f0d2d9b5a887b7337bacbc03f3ff217f3553d5900ec00cac7c`。

与 main 的 Rust 树只差 `src/data/builtin-templates.json`，不是零差异：

- A receipt 源模板文件 SHA-256：`8cc8d004f056656c8a12259782be4646c0356a00d094eebdf0783ea7d0ca78b9`。
- main 源模板文件 SHA-256：`9932e2dcd6b0fc6aad17f1ccf04a8ba9c368518efd812ec18b308a43e8e03cc6`。
- 11 个模板的 `version`、`css_style`、`front_template` 不同。逐模板与逐字段哈希见
  `template-baseline-delta-20261106T1555Z.json`（采集作业 `20261106155614-686872` exit 0，
  原件已产出）。上述两个源文件哈希及三个代表样例的逐字匹配均已只读核对。
- 已有 triage 的 `design-architect` 三个代表样例逐字满足 **A=receipt 旧源值、B=main 新源值**。
  因而这些样例应改列为**源数据基线版本差**，不是已经确认的 B 实现缺陷，更不是可归一化的随机值。
  此结论只覆盖已列样例，不把该分组全部次数当成已逐行验证的结果。
- 保留原 compare 差异和 receipt；不以新 main 冒充原构建。是否另行处理该版本差交 C1/C2 决定。

## 旧门禁失败与当前验证范围

原件目录：`.oc-runs/gate-raw/2026-11-06T093723387Z/07-X7-differential/`（共享主仓库下）。
candidate=`36b1e0213c7fb5a4df32a53ee818cae8f682123d`，tip=`f4572ba0624cb882e424869f1712cc0f89824be6`，
base=`5f806c95eb2ef7cee7c08579a7fbdbb615acd1cb`，测试 phase=`门禁/tests`，exit **1**。
两个 wrapper 的首因均为临时目录缺少 `scripts/electron-migration/record/g3-normalize.mjs`。

当前 normalize fixture 已复制 normalizer（`g3-normalize.test.mjs:76`）；report fixture 同样已补。
最近 report/manifest 定向作业 `20261106153724-5d5cbd` exit **0**，4 passed；
不能将此结果改写为旧集成门禁通过，也没有重跑完整集成三检查。
最新汇总指令取代旧催办，本轮不修 owner 文件、不为消除范围拒绝而回滚历史工作。

## 实际 job/phase/exit 与 ETA

| job | phase | 最近 exit / 结果 |
|---|---|---|
| `20261106142245-f33227` | G3 A/B/A2 recording（队列 other） | **143**；14:49:10Z 结束 |
| `20261106152615-758c5e` | ledger check | **0**；15:33:08Z 结束 |
| `20261106153724-5d5cbd` | report/manifest tests | **0**；15:37:44Z 结束 |
| `20261106154002-b5e20d` | residual triage | **0**；15:40:35Z 结束 |
| `20261106155231-148e18` | read-only provenance audit | **0** |
| `20261106155614-686872` | read-only template baseline audit | **0**；11 个模板源数据版本差，3 个代表样例匹配 |

核对时没有匹配的队列 recording running job。观察到协调者管理的 detached batch 进程，但它不是
jobs running phase 的凭证；本会话未启停它。A2 完成 ETA：**未知**，旧 08:50 预测失效。

## RUN-MANIFEST 与结构修复结论

- 核对时 `runs/full/RUN-MANIFEST.json` 不存在，最终 report 尚不能封存。封存输入不等于追认录制代码 revision。
- 原件未改，normalizer/compare/batch 未改。只消费 active compare 的规则、A2/approvals 校验仍在。
- WP-262 只归因；真正 `sync_state.db` 修复为 L20b WP-278。WP-263/264 已进 main 不能推出
  “三项结构差异全部解决”。每项仍以实际原件、启动范围和对应修复 receipt 为准。

## C2 签收后的分类边界

- 旧 B revision 未知，不能用当前 HEAD 追认旧 trace 同源。
- 三个 design-architect 代表样例只签源数据基线差；不签 B 产品缺陷，不归一化，
  不把 11 个模板或分组次数说成已逐条复核。
- F2 目录、F4 字段/错误文本等暂列**待同基线复现候选**；旧 triage 表的产品差措辞
  受本条限定，不能据此盲修 owner 代码。
- 活 driver 不启停；manifest 等待真实 revision receipts。N008/N009 保持 proposed，
  等 R3 独审及 C2 最窄 allowlist 裁定，本次没有扩展批准规则。

## C1 归口交接（协调消息状态，非修复验收）

| 项目 | owner / 包 | C1 通知的状态 | X7 报告边界 |
|---|---|---|---|
| `get_app_data_dir` | F2 / WP285 | ready，等 WP273 活 writer 正常边界 | 尚未启动/修复，不改变冻结轨迹 |
| cloud 出站 None/false 省略 | L21 / WP286（产品总 owner） | ready，等 WP271 边界 | 未验收，不将旧样例追认为已修 |
| 入站非法 `allowInsecure` 完整 Rust 错误 | F1 / WP287 | 已实际 astra 启动 | 启动不等于修复或测试通过 |

- F5 契约原本就是正确的 `snake_case`；F4 仅薄包装。不加 camel alias，
  不把成功意图语料里的非法 camel 参数改成 B 应接受的目标。
  A 对该参数报 error 的 expectation 残差保留；本轮不修改录制输入或重判为 pass。
- 两个 ready 包的检查点是**实际启动后 +20 分钟**，不能按 ready 时间冒报已启动。
- pdfstream shell 能力仍 blocked，未授权 X7 本包扩 shell 或改 normalizer/compare/batch。
- C1 通知 X3/`0efb` 已入 main `16b573121`；这不改变旧 trace 的未知 revision，
  不据该消息倒填 receipt 或重新宣称旧证据同源。
- 原 trace/compare/receipt/录制输入继续冻结；不重启、不重录。519 equal / 1043 artifacts
  不是 pass/768；最终命令级五态仍待既定封存条件与 C2 复算。
