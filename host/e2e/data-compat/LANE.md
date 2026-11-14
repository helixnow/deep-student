# X3-data-compat

## main-red 修复（2026-11-06）

main `5f806c95e` 的 slotC/head/previous-head 三条在全量运行中约 30–33 秒失败；相同 main 定向
job `20261106105414-f5463b` 9/9 通过。构造测量 `20261106105509-caafba` 五库 wall 5.61s、CPU 1.58s。
`buildDatabase` 的可重建样本连接改用 connection-local synchronous=OFF，减少独立迁移/history 提交的同步落盘等待；
原 SQL/事务/完整性检查/Host 重开和生产配置保持。所有断言与超时预算不变，详见 audit 的 main-red 节。

## 状态：WP-044 seed/DB 差分入口已实现；WP-115 起 X3-L05-02 原断言已通过（L05 WP-063 已 main）；WP-116 新增 L15/L24 seed

## WP-116：`l15-review-cas-tombstone-w0` SQL seed

新增 seed `l15-review-cas-tombstone-w0`（`provenance=sql-constructed`）：五库按当前迁移重放，`mistakes.db` 按 Rust 原测试夹具 SQL
写入 6 个精确 i64 reviewVersion（`fsrs_card_states.local_version`，含 2^53+1、2^63-1024、i64::MAX 及 double 相等邻值）
与 `S:7150`/`S:7327` 两组 card/task 软删除（保留活子 state、Processing task）。记录 ID、源行号与差异见 `SCENARIO-V0.md` 末节。
`review-cas-tombstone-seeds.test.ts` 5 条，job `20261105194708-b008f6` 5 passed，exit 0。不改 L15/L24 场景/实现，不改 TESTMAP。
前会话正式 selfgate tip `da1f23e39` 已通过：全目录 job `20261105195049-6fca48` **71 passed / 0 failed / 0 skipped**；
typecheck `20261105195049-24aa3c`、普通/严格边界 `20261105195049-55ea2a` / `20261105195049-61c0d3` 均 exit 0。
恢复时核对原件，不另跑已绿定向测试。main 已有 X7 `scenario-v0.mjs:38-55` seed/HOME 准备入口；
真实工具及 A/B 消费仍归 X7/L15/L24（见 BLOCKERS 最新节）。原 X3-L05-02 断言/预算保留。

WP-044 发布 `empty`、`historical-wp013-v1`（SQL 构造，非 A 产物），接口和 X7 样例见
`SCENARIO-V0.md`。全库/全表/全列快照保留 storage class、精确整数、JSON 原文和 A1/A2/B。
独立工具验收 job `20261105160805-7e4ed6`：12 passed / 0 failed / 0 skipped，Errors 0，exit 0。
真实 Node CLI 两条入口/退出码验收 `20261105161500-ecc220`：2 passed，Errors 0，exit 0。
基线 job `20261105155554-826f3d`：38 passed / 1 failed / 0 skipped，Errors 0，exit 1，
仍为 X3-L05-02；原测试未改。正式本包 gate 结果见审计报告，不用工具绿替代整体 gate。
Rust TESTMAP pending 0→0，兼容待修 1→1；真实历史发布产物及 normalize 双录批准留给后继包/C2。

WP-044 最终代码 tip `1115ae52a`：正式 gate tests `20261105163939-5acb94`
**52 passed / 1 failed / 0 skipped，Errors 0，exit 1**，唯一 X3-L05-02；typecheck
`20261105163939-d7d6ac` exit 0。父 `20261105163025-e1de5e` 最终 **128 / SIGTERM**；
普通/严格边界 `20261105163939-974465` / `20261105163939-28916f` 随后均 **exit 0**，
分别 3055/8 files、0 violation。四子项原件收齐，整体仍红，无正式 selfgate 成功回执；未重跑。

## WP-115：`l22-temp-sessions-w0` SQL seed

新增 seed `l22-temp-sessions-w0`（`provenance=sql-constructed`）：五库按当前迁移重放、无业务行，`mistakes.db` 原样执行
L22 固定 SQL（`cf9e3e015` 的 `pending-seed/l22-temp-sessions-w0.sql`，blob `3f666bc6`），只读消费、不复制 L22 文件。
详见 `SCENARIO-V0.md` 末节。`temp-sessions-seeds.test.ts` 6 条。runner 消费仍归 X7（同 WP-094）。
X3-L05-02 已随 main 中 L05 WP-063 修复，原断言通过（见 BLOCKERS）。

## WP-094：`skill-zip-v0` 合成技能 ZIP seed

新增 seed `skill-zip-v0`（`provenance=synthetic-zip`）：`home/w0-zip-seeds/` 下 10 个确定性构造 ZIP，
对应 L07 `skill_import_zip` 的空包/空 EOCD/无 SKILL.md/根 frontmatter 名（合法与非法）/合法多文件/
同名与大小写冲突/非 ZIP/截断中央目录。清单、目标 Rust 分支与构造方式见 `SCENARIO-V0.md` 末节。
不是历史 A 发布物；`historical-wp013-v1` 的 SQL 构造标签不变。`skill-zip-seeds.test.ts` 7 条，
定向作业 `20261105174513-b5dab5`（含 scenario-v0/cli）21 passed / 0 failed，exit 0。
runner 尚不解析 `scenario.seed`、不设 HOME，这些文件暂不能被场景消费（见 BLOCKERS）。

## WP-013 历史状态（X3-L05-02 待 owner 修复）

WP-013 在原五库上新增 audit、sync_state、workspace 历史样本；原 35 项已完成状态保留为历史记录。
新发现 workspace unread 队列恢复问题，详见 `BLOCKERS.md`。新三库使用原 owner 的非 refinery 初始化路径；
workspace V1→V2、sync_state 六表→七表、audit 无编号历史 schema，不能合计为新的 refinery 迁移。
不声明 W6 全部完成。

最终代码 `0b6c7bbd8`（main `b55af5d85`）：gate tests `20261105150116-3326d4`
38 passed / 1 failed / 0 skipped，Errors 0，exit 1；唯一失败 X3-L05-02。
typecheck、普通/严格边界子作业均 exit 0。父 gate `20261105145307-027b3f` 被共享执行器重启中断（code -1），
没有本次正式 selfgate 成功回执；所有子项原件与历史 SQL 核验见审计报告。

范围按 `docs/dev/electron-migration/dispatch/X3-data-compat.md`：只写本目录和 X3 审计报告，不修改被验收 lane 的实现，不编译或运行 Rust。

## 已交付及证据

- 独立重放 Rust SQL 的五库样本、132 条迁移、32 个 seed 表；不使用 Host migrator 自造样本。
- 迁移幂等、refinery checksum 金标和损坏 checksum 负对照；原始 SQL NULL、JSON、时间及内部 bigint 原值断言。
- F4 固定旧密文向量、A/B/pending/legacy 数据空间、C/D 显式读取、L21 v1/v2 ZIP 公开导入。
- X3-F3-01 已签收：main 包含 `f9cbf4d23` 后，原 UTC Z 定向回归作业 `20261104120614-97f4dd` exit 0，无 Errors。断言未改。
- 自检通过提交：`1a69a4f8d`，基线 main `c6309183c`。lane-gate `20261105001910-067a1c` exit **0**；类型检查 `20261105002813-53febc`、边界 `20261105002813-9452ff` 均 exit **0**。tests `20261105002813-68247d`：**35 passed / 0 failed / 0 skipped**，无 Errors，exit **0**。
- 覆盖边界（真实用户数据库、跨机密钥恢复、ZIP 整槽 restore 等）见审计报告，不将 SQL 重放样本冒充 Rust 二进制生成或真实用户备份。
- main `677f6727c` 新增 VFS 必需 `vfsIndex`，自检 `20261104160508-65281a` 捕获 services 套件启动失败；`ef1538432` 在测试宿主安装真实 L12 插件，修正后 services 套件恢复执行，证据见上项及 TESTMAP。未改业务断言。

## 剩余事项 / BLOCKERS

- [x] **X3-L04-01，owner：L04-chat-session，主线签收**。修复 `320e451774f269f1883c56b51fb975ece348eed6` 已是 main/HEAD `c6309183c4cddc06b3647530f3306f7906f2295b` 的祖先，两次检查均 exit 0。`messages.ts:38-42` 对 SQL NULL/JSON null 返回 undefined，保留嵌套 Value null。
  - 原 `services.test.ts -t 'L04 messages'` 作业 `20261105001522-cb081d`：1 passed / 16 filtered（Vitest 显示 skipped），无 Errors，exit 0。真实宿主和原断言均未改，未复制 owner 实现。
- [x] 旧包 lane-gate 全部通过；F3、L04 两项不兼容均已主线签收。真实用户库、跨机密钥、整槽恢复等覆盖缺口保持。
- [x] WP-013：X3-L05-02 原 inbox 断言在 main 含 L05 `33e266809` 后通过（WP-115 基线 job `20261105182339-e61a0e`），断言未改；C2 组合签收另行。

## standard-v2 §1 自查适用范围

本 lane 是新增兼容性验收，不移植生产命令，不声称完成各 owner 的生产代码审计：

1. 生产接线：公开插件服务及 IPC 由真实 Host 调用；迁移/槽位另测生产模块，见 TESTMAP。
2. 所有权：直接 SQL 写入限本目录临时样本；SQL 重放、种子与负对照不写旧用户库。
3. 数据边界：保留全字段比较、SQL NULL 省略、9 位纳秒 UTC Z 和 safeIntegers bigint；L04 差异未隐藏。
4. 日志/错误：真实插件宿主提供生产 log；fixture 的 finally 关闭 SQLite；不将测试安静 logger 当生产日志迁移证据。
5. 真实性：未使用 mock/skip/it.fails 绕过生产路径；checksum 有独立金标，密文用固定向量，ZIP 独立构造。
6. 完整性：原 35 项及 WP-013 新增 4 项逐项见 TESTMAP；未覆盖分支按审计报告列出，不冒充全插件验收。
7. 运行时：临时目录与句柄清理、有限超时；不运行 Rust、生产进程或真实系统密钥库。同步 SQL 重放属于测试 fixture，不是新增生产阻塞路径。
8. 闭环：F3、L04 均有正式 main 祖先及原回归通过证据；历史“L04 未进入 main”仅为旧基线记录，当前已失效。
