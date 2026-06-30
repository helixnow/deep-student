# 代理 5（round 2）—— 制卡与间隔重复

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-5-status.md`（F1–F23 / O1–O11，含 17 文件死代码删除）。

## 已完成（第一轮，勿重做）
O1–O11 全部落地（软暂停死代码移除、调度代际 epoch 防竞态、APKG 媒体清单、非破坏取消、看板重试 Cancelled、3D 预览窗口化、17 个死代码文件删除等），cargo check / tsc / vitest 全绿。

## 本轮任务

第一轮把 P0/P1 都修完了，剩余均为**低优先级登记项**。本轮逐项评估「修 or 收口为不修」，并补一轮针对性深审。

### P2/P3 — 低优先级登记项（逐个定夺）
- [ ] **F3** `streaming_anki_service.rs:324/2161`：用错误消息字符串（`CANCELLED_BY_USER`、含"超时/截断"）做控制流分支，脆弱。评估重构成枚举（中风险）或保留。
- [ ] **F5** `enhanced_anki_service.rs:259`：`sleep(20ms)` 缩小取消竞态窗口，非确定性（有 `handle.abort()` 兜底）。评估是否改成确定性同步。
- [ ] **F7** `anki_connect_service.rs`：全文件用 `println!` 而非 `tracing`（诊断噪声）。批量改 `println!`→`debug!/trace!`（改动面大但机械）。
- [ ] **F9** `apkg_exporter_service.rs:552`：`note_id` 用 `秒*1000+序号`，同秒多次导出可碰撞（guid 唯一 + Anki 处理冲突，实际无害）。评估是否加纳秒/计数器。
- [ ] **F11** `apkg_exporter_service.rs`：多模板导出 `insert_note` 字段映射比单模板简化（不回退 extra_fields、无 ALIAS_MAP）。统一需较大重构，评估收益。
- [ ] **F13** `apkg_exporter_service.rs:517`：csum 用原始 sort_field 算 SHA1，Anki 官方先 strip HTML。仅影响 Anki 端重复检测精度，改动有回归风险。
- [ ] **F14** `apkg_exporter_service.rs:889`：导出整库 `fs::read` 进内存。桌面数千卡可接受；大库可改流式。
- [ ] **F21** `CardAgent.createCardCollector` 超时 `300_000ms` 固定：大文档多分段易超时，超时后部分卡"成功"返回与库内不一致。建议改"距上次事件的空闲超时"或按段数放大。**（前端，相对值得做）**
- [ ] **F22** `SegmentEngine.hardSplit/estimateCharTokens`：ASCII 字母计 0 token，英文长文低估分段数（实际切分在后端，仅影响前端预估）。

### 建议
F21（收集器空闲超时）与 F7（println→tracing）相对值得做；其余多为"无害/有回归风险"，评估后大多可登记为"确认不改"。先出处理清单。

## 验证
`cargo check`；`npm run typecheck`；`npm test -- anki|template`；`cargo test anki|spaced_repetition`（若可跑）。
