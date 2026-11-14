# L23-V2-1.3-FTP：冻结候选与全部回执（健康会话复用，不重复测试）

## 候选及源依据

受测源 **`06867c21a3a2050f1e742d0c52ba68fe937d152d`**，tree
**`8891dadd75b4995e0414a8686f7cb6290ffb71df`**。src/ftp.ts、tests/ftp.test.ts、
F4 time及目标配置在全部验证期间未变；结束仍同HEAD/tree、相关diff空，仅原两个
外部ledger dirty。回执全取回后才进入文档保存/允许的main同步。

`src-tauri/Cargo.lock:12002-12005`固定suppaftp7.1.0，原Rust
`cloud_storage/ftp.rs:782-795`将MDTM NaiveDateTime转UTC、错误保FileSystem/FTP MDTM前缀。
本地无该依赖缓存，本轮只读官方固定版本源，未下载/安装crate或编译Rust：

- [suppaftp7.1.0 src/list.rs](https://docs.rs/crate/suppaftp/7.1.0/source/src/list.rs)：
  `ListParser::parse_mlsx_time`用chrono `%Y%m%d%H%M%S`，非法日历返回InvalidDate；
  然后取timestamp()整秒as u64，UNIX_EPOCH.checked_add失败回退epoch。因此MLSD
  负纪元值回退0，闰秒纳秒部分不计入SystemTime，而非Date.UTC归一到下一秒。
- [suppaftp7.1.0 tokio_ftp/mod.rs](https://docs.rs/crate/suppaftp/7.1.0/source/src/async_ftp/tokio_ftp/mod.rs)：
  `mdtm`分别调用NaiveDate::from_ymd_opt及NaiveTime::from_hms_opt，非法日期/60秒
  返回BadResponse，不应把Feb30或秒60滚成另一有效时间。

TS保既有14位语法，只将日历解码委托现有公开F4 parseRfc3339；新增的私有compact
adapter只补UTC分隔符，不复制日期parser。MLSD按原整秒/负纪元fallback投影，MDTM
保持原from_hms_opt秒范围与FileSystem错误路径；未改原大小/重试/传输预算/日志策略。
四位年份域的毫秒值在JS安全整数范围；BigInt到number只作有界时间单位投影。
本单元不签POSIX/DOS/所有词法日期域、u64文件大小链或整个P04/FTP验收。

## 原先红与修后固定源验证（全部已取回，无待取job）

| 检查 | Job | 原结果 |
| --- | --- | --- |
| 新时间回归先红 `-t ftp_timestamp_` | `20261105073524-b30864` | exit1，5failed/1passed/29标题过滤，无Errors |
| 完整FTP `npx vitest run -c vitest.host.config.ts host/plugins/sync-providers/tests/ftp.test.ts` | `20261105074123-c98ffc` | exit0，35/35，无Errors |
| `npm run typecheck:host` | `20261105074123-495e83` | exit0，无Errors |
| `npm run migration:boundaries` | `20261105074123-a16bba` | exit0，2979files/0违规，无Errors |

FTP验证start07:41:23.995Z/end07:41:55.139Z，typecheck至07:44:24.858Z，均2026-11-05；
冻结窗口覆盖全部job，未在FTP先结束而typecheck仍运行时merge或编辑。原metadata/log
位于 `/home/dsdev/.oc-jobs/done/<job-id>.{json,log}`。新六例包括真实TCP FTP服务端
驱动FtpStorage.stat的两条MDTM拒绝，未替换客户端/解析器/业务路径；有效闰日控制
项先前已通过。原29例及原断言/预算未改，六补充不新增Rust映射行。

**计数纠正**：06867c21a的checkpoint提交信息误沿用旧656/202/1；其冻结树和当前
TESTMAP实际均为 **659ported/199pending/1approved obsolete（859行）**，本修复未改
任何去向行。以实际逐行统计及本说明为准，不改写历史commit，不误判成去向丢失。
生成头仍旧637/221，交infra，未隐藏/覆盖/暂存两个外部ledger文件。

## 本轮结束边界

按C2后发07:37裁定：只保存最新main2a8df3141/07:33:46.683Z的同源W69
40532.18936800001ms>30000，未新排W69/S108/目录/全集或改变其阈值/输入/SQL。
其原回执见W69任务卡；实际L20获权写者仍未确认。

本FTP最小单元回执已齐，原候选/工作成果已保存，按长会话要求交健康会话承接；
不要重复35例/typecheck/boundaries、旧目录复核或S108诊断。下一会话先读HANDOFF，
核main和权限/实际新增反馈，再限定下一单元。本轮不自行restart/park/换模型或改状态。
