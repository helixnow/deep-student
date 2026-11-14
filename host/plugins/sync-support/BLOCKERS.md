# L20b-sync-support 外部阻塞

本 lane 未完成，Rust 映射现为 39 ported / 1 pending；仍保留 S04 通用跨表链与 S06。
按 C2 签收通知及 R4 ACCEPTANCE §10–12，S01/S02/S03/S05 的指定范围已完成主线独立签收，
不再列为“待签收”；这不扩大为整 lane 或全部 serde 行为通过。

## 174833 的 72 项摘要：归档状态未知（独立保留）

- 原 root `_integration-p3`、baseline `e87727c09`、candidate `7b5ca5178`、merge `2fce872c5`。
  原集成日志报72项，但runner仅保留摘录，无原始栈/退出码/Errors/skip记录。
- 固定树最小作业 `20261104175634-655ae5` 3/25标题过滤、exit0；同基线新tip `6361462a6`
  的目录作业 `20261104175750-d8056d` 123/123、exit0、无 Errors/Unhandled Errors，五项gate过。
- 不能据此认定原集成红灯已修、属于算法回归或属于infra。已交C2请求原root完整stdout/环境/实际HEAD；
  在无原始栈且未复现的情况下，不改业务断言、不派停放owner、不重复猜测旧Slot/paths根因。

## 集成回归历史与当前装配修复（不是 S06）

- 固定组合 `fb463060d` + `053d7f27c`（合并 `b82afc31c`）最小复验：
  `20261104170655-11b47d` exit1；`20261104170838-db350a` exit1。
- 上述固定树中 F3 `registerNoteAssetRetention` 返回 Slot disposer，但 L10 丢弃 disposer，
  第一个 codec/host 成功，dispose 后第二个 host 初始化抛 SlotOccupied，业务断言尚未执行。
- **现已由 L10 `5f9082dbf` 修复并进入 main**：notes effect 保留并释放 disposer。
  本lane不再把它描述为当前缺实现；前轮正式红灯 `20261104171656-8ca196` 61/62、exit1保留。
- 本 lane 的 note-history fixture 由两个 host 改为单应用+两个显式真实库，原断言不变；
  `20261104171349-5962ce` 相关两入口通过（3项标题过滤），不宣称跨用例释放缺口已闭合。
- 本轮宿主新增能力缺口：L10 worker 初始化调用 registerMaintenanceParticipant。修前最小作业
  `20261104173050-679378` exit1；本lane宿主现委托真实F3 registry及app目录，修后
  `20261104173204-d56061` 四入口通过（24项标题过滤）、exit0、无 Errors/Unhandled Errors。
- 未越权修改 owner 目录、未放宽 Slot、未用 no-op 注册或跳过原失败换绿。
- 详见 REPORT 原 root/candidate/作业/首栈；旧 selfgate 绿不覆盖新集成红灯。

## S01 已主线签收；S04 通用跨表链仍未闭合

- 正式 main `677f6727c` 已合 L20 变更：`sync/index.ts:94-97` 默认 hooks 的 reader
  来自 syncSupport.noteHistory，写入经 L10 notes.sync/revisions，旧写 SQL 已删除。
- `tests/note-history-apply.test.ts` 恢复 5 条完整公开 pending/enrich/apply/replay/检疫测试，
  两个真实迁移库，Node 作业 `20261104160636-53cfb7` 5/5、exit 0，无 Errors/Unhandled Errors。
- 未修改 L20 目录、未替换默认 hooks。R4 ACCEPTANCE §11 已独立核对原五场景及宿主，
  复用主线 `20261104181546-28458e`：support 123/123；整作业原 exit1（其它目录3失败、20 Docker skip），
  不冒称整作业全绿。S01 指定生产消费链已签收，不再是本lane待办。
- S04 的通用跨表写者/事务链仍按 R4 原结论未决；不能以笔记 owner 接缝或 S01 通过关闭它。
  L20 全局旧测试映射/第二Host问题继续归 R4-SYNC-07，不在本轮文档同步中越权修改。
- L10 负大整数及软删笔记修复已在 main，并非仍缺 owner 实现；本 lane 接缝回归
  `20261104145316-0d5433` 10/10 是较早接缝证据，与本轮完整 apply 证据分开。

## S06：真实 SQLite busy 通知

- 提供方：F3。按 C2 最新确认，main 和 F3 分支 API 均未发布真实 busy observer。
  F3 处于 parked，由 C2 上报接管/能力裁定；本lane不直接派停放owner。
- 需要实际争锁通知后才释放写者，才能对应 Rust `state.rs:620-659` 的读前等待断言。
- 固定延时、worker“即将调用”通知、最终序号正确都不是已争用证明；原 Rust 测试继续 pending，
  不自行添加原生绑定或模拟 busy 回调。

S02/S03原范围/S05 已由 R4 ACCEPTANCE §10 主线签收，S03 事件 JSON 增量由 §12
在 main `9b3c18601` / `20261104220300-b694ec` 2/2 完成签收。整作业原 exit1、
1842 passed / 2 failed / 20 Docker skip，无额外 Unhandled Errors；不借策略放行签整 lane。
X6/其它未审范围不扩签，本lane不修改 ACCEPTANCE.md。
