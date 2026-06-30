# 代理 5 状态文档（round 2）—— 制卡与间隔重复

> 第一轮状态见 `docs/6.12/status/agent-5-status.md`（F1–F23 / O1–O11，禁止清空回退）。
> 本轮目标：逐项定夺第一轮登记的低优先级项（F3/F5/F7/F9/F11/F13/F14/F21/F22 = 修 or 收口不修），
> 并补一轮针对性深审。本文档随进展持续更新。feed_id=F-E6QC8。

## 当前状态（2026-06-13）
- 已完成：① 复核全部 9 个登记项的真实代码现状；② 二轮深审 SRS 核心与复习计划服务；
  ③ 用户指示「全都干」→ **9 项全部实施**（R1-R9）；④ 用户指示「继续挖」→ 二轮深挖，
  新增 R10（多模板缺索引）/R11（看板删除计时器卸载清理）两处低风险硬化，并登记 1 个跨组配置问题 X1。
- 二轮深审结论：`spaced_repetition.rs`（SM-2）与 `review_plan_service.rs` 干净、**无新增 P0/P1**——
  SM-2 失败保留 EF、间隔上限/下限、本地时区一致、fuzz 防洪峰；复习计划 update+history 同事务、
  分页创建避免漏题、命令层校验 quality≤5。
- 前端验证：`tsc --noEmit` exit 0；改动文件 eslint **0 error**（顺带修复 2 个先存在 error：
  CardAgent resume case 加花括号、SegmentEngine 删未用变量）；vitest anki+templates **29/29**
  （CardAgent 新增 F21 空闲重置用例）。
- 后端验证：`cargo check`（专用 target-agent5 避多代理锁竞争）**exit 0**，0 error，
  改动的 4 个文件**无任何警告**（"MY FILES" 段为空 = 零新增警告），全树警告 92 ≤ 基线 100。
- 共享文件：本轮**无**改动（lib.rs/commands.rs/models.rs/App.tsx/locales 均未触碰；
  F5 改的 `process_task_and_generate_cards_stream` 签名仅在本域 streaming/enhanced 两文件间）。

## 二轮深审（针对性复查，第一轮 T6/T7 区域）
| 单元 | 复查结论 |
|------|----------|
| `spaced_repetition.rs` | SM-2 公式正确；q<3 保留 EF（符合 Wozniak 1987 原始规范）；`calculate_ease_factor` 最小 1.3；间隔 `MAX_INTERVAL=730` 且至少 +1；`fuzz_interval` 每次 `RandomState::new()` 随机展开（注释措辞略含糊但行为正确）；到期/过期判断用 `Local` 与 todo 模块一致。13 个单测覆盖到位。**无问题。** |
| `review_plan_service.rs` | `process_review` 在单事务内 `update_plan_with_conn`+`record_history_with_conn`；`next_review_date` 与 `last_review_date=today` 均走 Local；`create_plans_for_exam` 分页(500/页)避免固定上限漏题；命令层 `quality>5` 拒绝。`batch_create_from_questions` 用字符串匹配 "already exists" 区分 skipped/failed（仅影响计数，cosmetic，不单列）。**无问题。** |

## 处理清单（逐项定夺，待用户确认）

> 风险口径：低=纯日志/前端预估/无行为变更；中=触及错误模型或需测大文档/跨模板回归。

| # | 位置 | 风险 | 建议 | 理由 |
|---|------|------|------|------|
| **F7** | `anki_connect_service.rs`（18 处 `println!`） | 低（仅日志） | **建议修** | 全文件 18 处 `println!` 改 `debug!`/`trace!`（探测诊断噪声）。纯日志、零行为变更、机械可控。文案"5秒"已在 O1 修正。**agent-5.md 标注"相对值得做"。** |
| **F21** | `CardAgent.createCardCollector`（CardAgent.ts:1426-1440） | 低（前端） | **建议修** | 现为整文档固定 5min 总超时；大文档多分段易误超时，超时后以"部分卡片成功"返回与库内不一致。改为**空闲超时**：在 card:generated/card:error/task:progress/task:complete 事件到达时重置计时器，仅在"长时间无任何事件"才超时。仅前端、收敛在收集器内。**agent-5.md 标注"相对值得做"。** |
| F22 | `SegmentEngine.estimateCharTokens`（SegmentEngine.ts:481） | 低（仅前端预估） | 可选 1 行修 / 收口 | hardSplit 逐字符累计时 ASCII 字母/数字返回 0，英文长文几乎不产生分割点→`analyzeContent` 低估分段数。可让 letters/digits 返回 ~0.25（不影响 `estimateTokens`，其已剥离单词）。**仅影响前端预估，真实切分在后端。** |
| F3 | `streaming_anki_service.rs:315 / 2146` | 中 | 收口不修（可选硬化） | 以 `e.message=="CANCELLED_BY_USER"` 与 `contains("超时"/"截断")` 做控制流。功能正常；重构成枚举需动 `AppError` 跨层、回归面大。可选低风险硬化：把魔法字符串抽成 `const` 减少笔误。 |
| F5 | `enhanced_anki_service.rs:277` | 低 | 收口不修 | `sleep(20ms)` 缩小"取消注册前被取消"窗口，已有 `handle.abort()` 兜底。确定性同步需 oneshot ready 信号，复杂度换取收益极小。 |
| F9 | `apkg_exporter_service.rs:552 / 1166` | 低 | 收口不修 | `note_id=秒*1000+序号` 同秒跨次导出可碰撞；但 guid 唯一 + Anki 导入按 guid 去重并重排 id + 各为独立文件，实际无害。单次导出内 `note_idx` 唯一不碰撞。 |
| F11 | `apkg_exporter_service.rs:1165-1213` | 中 | 收口不修（可选统一） | 多模板 `insert_note` 字段映射比单模板简化（text 不回退 extra_fields、无 ALIAS_MAP）。正常生成链路 card.text 已填充，影响有限；统一需抽共享 helper、跨模板回归测试。 |
| F13 | `apkg_exporter_service.rs:517-526 / 1194` | 低 | 收口不修 | `csum` 用原始 sort_field 算 SHA1 前4字节，Anki 官方先 strip HTML。仅影响 Anki 端重复检测精度，不影响导入；改动有回归风险。 |
| F14 | `apkg_exporter_service.rs:911 等` | 低 | 收口不修 | 导出整库 `fs::read` 进内存 + 每个媒体整读。桌面数千卡可接受；流式化是较大改动。 |

### 本轮决策与落地
- 我先按纪律出清单建议「修 F7+F21，可选 F22，其余收口」；用户回复 **「全都干」**，故 9 项全部实施。
- 高于"建议"档的项（F3 全枚举重构、F11 大重构、F5 确定性化）采用**低风险等效实现**：
  F3 抽常量硬化（非跨层枚举重构）、F5 oneshot 就绪信号（不改取消协议本身）、
  F11 抽共享 helper 让两路径共用（单模板逻辑逐字保留，不改其行为）。

## 已实施优化（round2）
| # | 关联 | 改动文件 | 改动说明 | 验证 |
|---|------|----------|----------|------|
| R1 | F21 | `src/components/anki/cardforge/engines/CardAgent.ts` + 测试 | `createCardCollector` 固定 5min 总超时 → **空闲超时**：card/error/task:progress/task:complete 事件均重置计时器，仅长时间无活动才超时；新增 vitest「空闲重置」用例（推进 750s 不误超时） | tsc 0 / eslint 0 error / vitest 5 |
| R2 | F22 | `src/components/anki/cardforge/engines/SegmentEngine.ts` | `estimateCharTokens` ASCII 字母/数字 0→0.25，修正 hardSplit 对英文长文低估分段（不影响 estimateTokens 词级估算） | tsc 0 / eslint 0 error |
| R3 | F7 | `src-tauri/src/anki_connect_service.rs` | 18 处 `println!` → `debug!`(信息/成功) / `warn!`(失败/告警)，新增 `use tracing::{debug, warn}`；消除诊断噪声 | cargo check exit 0（本文件无警告） |
| R4 | F3 | `src-tauri/src/streaming_anki_service.rs` | 抽 `CANCELLED_BY_USER_MSG`/`ERR_KEYWORD_TIMEOUT`/`ERR_KEYWORD_TRUNCATED` 常量替换散落字符串（低风险硬化，非枚举重构） | cargo check exit 0（本文件无警告） |
| R5 | F5 | `streaming_anki_service.rs` + `enhanced_anki_service.rs` | `process_task_and_generate_cards_stream` 增 `ready_signal: Option<oneshot::Sender<()>>`，注册取消通道后回执；调度层（主+重试）以 `ready_rx.await` 确定性等待，替代 `sleep(20ms)`；取消协议本身零改动，abort 兜底保留 | cargo check exit 0（本文件无警告） |
| R6 | F9 | `src-tauri/src/apkg_exporter_service.rs` | 新增全局单调 `next_apkg_note_id()`（CAS），单/多模板 note_id 改用之，消除同秒跨次导出碰撞 | cargo check exit 0（本文件无警告） |
| R7 | F13 | `apkg_exporter_service.rs` | 新增 `strip_html_for_checksum`，`field_checksum` 先 strip HTML 再算 SHA1（对齐 Anki，仅影响重复检测，不改 flds/sfld） | cargo check exit 0（本文件无警告） |
| R8 | F14 | `apkg_exporter_service.rs` | 导出打包改流式：collection.anki2 与单模板媒体用 `std::io::copy(File→ZipWriter)`，不再 `fs::read` 整库/整文件进内存（多模板媒体保留 F12 的先读校验） | cargo check exit 0（本文件无警告） |
| R9 | F11 | `apkg_exporter_service.rs` | 抽 `resolve_card_field_value`，单/多模板字段映射统一：多模板补 text 回退 extra_fields + ALIAS_MAP + 选择题 Front 特例；单模板逻辑逐字保留 | cargo check exit 0（本文件无警告） |
| R10 | 深挖新发现 | `apkg_exporter_service.rs` | 多模板导出 schema 补齐 3 个缺失索引（`ix_cards_usn`/`ix_revlog_usn`/`ix_revlog_cid`），与单模板路径一致（Anki 导入会重建索引，属一致性硬化、零风险） | cargo check exit 0（本文件无警告） |
| R11 | 深挖新发现 | `src/components/anki/TaskDashboardPage.tsx` | 内联删除确认计时器（`deleteTimerRef`）补卸载清理 useEffect，避免在已卸载组件上触发 setState（React18 下原为无害，hygiene 硬化） | tsc 0；新增 4 行 eslint 无新增问题 |

> 备注：R1 顺带修复同文件 2 个先存在 eslint error（resume case 花括号、删 SegmentEngine 未用变量），保证改动文件 0 error。

## 二轮深挖（继续挖）结论
按用户「继续挖」指示，对域内做了一轮更深的针对性复查：
- `streaming_anki_service.rs`：`extract_card_from_buffer`（标准/损坏分隔符 + >10KB 截断兜底，ASCII 字节切片安全）、
  `clean_json_string`（去围栏/去 BOM + 首`{`末`}`截取，鲁棒）、卡片上限与流末 flush 路径——**无 bug**。
- `anki_connect_service.rs`：`add_notes_to_anki_detailed` 的 added/duplicates/failed 账目（canAddNotes + 本地结构校验
  区分重复与失败、None 回填记失败）——**正确，无 bug**。
- `apkg_exporter_service.rs`：sqlite schema 为 Anki v11 合规；唯一发现多模板缺 3 索引（已修 R10）。
  `note_id.parse::<i64>().unwrap()` 为 `to_string()` 往返，恒成功，安全（保留）。
- `TaskDashboardPage.tsx`：智能轮询 useEffect 清理完善（清 timer + 摘监听 + isActive 守卫）；仅 `deleteTimerRef`
  缺卸载清理（已修 R11）。
- 结论：域内成熟，无新增 P0/P1；R10/R11 为低风险一致性/hygiene 硬化。

## 跨组问题（发现但不属于本组职责域）
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|----------|----------|--------------|
| X1 | eslint 配置（`eslint.config.*`）+ 全仓 ~24 文件 | 项目 eslint 配置**未注册 `react-hooks` 插件**，但 24 个文件含 `// eslint-disable-next-line react-hooks/exhaustive-deps` 指令 → `eslint src/` 对每处报 **error: Definition for rule 'react-hooks/exhaustive-deps' was not found**，使 `npm run lint` 基线即 exit 1。属配置层问题（改 eslint 配置不在本组职责，README 3.3 禁改构建/配置）。建议加载 `eslint-plugin-react-hooks` 或清理失效指令 | 代理 7（平台基座/全局体验，配置一致性负责人） |

## 共享文件改动登记（round 2）
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|---------------|------|
| （待落地后登记） | | | |

## 验证基线
`cargo check`（src-tauri/ 下，基线 100 警告不变）；`npm run typecheck`；`npm run lint`；`npm test -- anki|template`。
