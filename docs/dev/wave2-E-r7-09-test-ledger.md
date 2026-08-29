# Wave2-E 第 7 轮 · 09 测试台账（只登记，不执行）

- 角色：0824 Wave2-E 第 7 轮「测试台账」。模型 `claude-fable-5-thinking-high`。
- 纪律自证：本轮**未改任何产品代码、未 commit、未跑任何测试/编译**；只读工作区
  与既有提交，产出本文档并追加主台账 §13。
- 写作基准：tip `a07a44d1`（第 6 轮提交）+ 工作区未提交改动（第 7 轮 01–07 号
  代理产物，`git status` 与本文 §1 一致）。红绿判断**全部为静态推断**，零执行。
- 截至写作时工作区仅见 r7-01 ~ r7-07 七份报告 + 本文（09）；未观察到 r7-08 产物。

---

## 1. 第 7 轮测试清单（新建 3 + 扩展 5）

Rust 集成测试（`src-tauri/tests/`，Cargo autotests 自动发现，无需改 Cargo.toml）：

| 文件 | 性质 | 用例数（存量+新增=合计） | 归属报告 | 覆盖面 |
| --- | --- | --- | --- | --- |
| `occlusion_export_roundtrip.rs` | 扩展（r2-05 首建） | 7+4=**11** | r7-01 | 遮挡生成/入库/导出全链、`vlm://` 占位不入 images、IO 0–1 坐标 clamp/舍入 |
| `gold_provenance_excludes_critic.rs` | 扩展（r2-07 首建） | 11+3=**14** | r7-02 | qa_pass 洗白真管线、`update_anki_card` user 戳、import/sync/未知 actor 产品符号 + 本地常量对齐锁 |
| `qa_pass_critic_combo.rs` | **新建** | **11** | r7-03 | 三 QA 留痕来源（字段规则/确定性 lint/critic relint）× enable_qa_pass 两态；wire 缺省 true 与残缺 JSON fail-open |
| `qbank_verdict_three_paths.rs` | 扩展（r4 首建） | 7+6=**13** | r7-04 | grading_method 三起点矩阵、auto/ai→manual 收敛、同向幂等零写入、计数钳 0、守卫零副作用 |
| `mastery_qbank_correction.rs` | **新建** | **3** | r7-06 | pub 补偿入口 `record_qbank_verdict_correction`：破首判锁、同向幂等、与产品判分链互操作 |
| `anki_nullable_card_reads.rs` | **新建** | **5** | r7-07 | 手建历史 schema（无 NOT NULL）× 六条 pub 读 API 的 NULL 兜底 + 归属校验不放宽 |

前端 vitest（只增不删）：

| 文件 | 性质 | 用例数 | 归属报告 | 覆盖面 |
| --- | --- | --- | --- | --- |
| `src/features/anki-tasks/__tests__/classify.mixed.test.ts` | 扩展（r3-06 首建） | 6+6=**12** | r7-07 | (failed, active, paused) 零/非零 8 组合真值表、hasWarnings 正交性、三组全划分、failed+paused 快轮询、计数漂移不翻组 |
| `src/stores/__tests__/recordPracticeAnswer.regrade.test.ts` | 扩展（r4 首建） | 14+4=**18** | r7-05 | 重答→权威覆盖→再练交织时序、快照灌入题改判空操作、apply 字段边界（不动 answered_results）、daily/timed 并行隔离 |

合计：第 7 轮新增 **42** 个用例 —— Rust **32**（r7-01 新增 4、r7-02 新增 3、
r7-03 新建 11、r7-04 新增 6、r7-06 新建 3、r7-07 新建 5）+ 前端 **10**
（r7-05 新增 4、r7-07 新增 6）；以上计数与各文件 `#[test]`/`it(` 实际提取
逐一对账通过。存量用例**零删除零改动**
（`git diff -U0` 复核：8 行删除全部为 use 合并、`#[allow(dead_code)]` 与
「待第 8 轮对齐」注释摘除、import 增项，无断言删改）。

## 2. 既有 r2/r4（及 r3/r5）测试存量对照

本轮扩展落点即 r2/r4 存量文件，另有本会话前端存量本轮未动、第 8 轮应一并回归：

| 存量文件 | 首建轮 | 本轮 | 备注 |
| --- | --- | --- | --- |
| `occlusion_export_roundtrip.rs` 矩阵 1–7 + 三镜像 helper | r2 | 扩展 | 镜像 helper（IO cloze / `_` 过滤 / 媒体名）与生产实现逐字节交叉校验仍在 |
| `gold_provenance_excludes_critic.rs` 覆盖 1–6 + classify 4 + marker helper | r2 | 扩展 | r2 本地常量保留，漂移由新增对齐锁断言兜底（r2 预告的「第 8 轮替换常量」不再必要） |
| `qbank_verdict_three_paths.rs` 旧 7 例 | r4 | 扩展 | 真实迁移建库夹具（`MigrationCoordinator::migrate_single`），新增用例复用同款 |
| `recordPracticeAnswer.regrade.test.ts` 三组 14 例 | r4 | 扩展 | R4 差量转移表 / 旧会话 fail-closed / apply 门禁全保留 |
| `classify.mixedState.test.ts`（13 例） | r3 | 未动 | 逐例断言，与 r7 真值表分工明确 |
| `AnkiTasksApp.statsOnlyFailure.test.tsx`（8 例） | r3 | 未动 | list/stats 拆分 + 混合态 UI |
| `tests/vitest/chat-v2/plugins/blocks/AnkiCriticSummaryBanner.test.tsx` | r3 | 未动 | CriticSummary 前端 |
| `tests/vitest/chat-v2/plugins/blocks/AnkiCardsOcclusionPreview.test.tsx` / `AnkiCardsQaMedia.test.tsx` | r5 | 未动 | 遮挡预览 a11y / QA badge |
| `src/components/anki/__tests__/ImageOcclusionOverlay.test.tsx` | r5 | 未动 | overlay aria |

## 3. 预期第 8 轮命令（5 条）

第 1–7 轮禁跑令解除后，按下列顺序执行（1/2 为 Rust 两组，3/4 为前端两组，5 为门禁）：

```bash
# 1. Anki 侧集成测试（遮挡 / gold / QA 组合）
cd src-tauri && cargo test --test occlusion_export_roundtrip --test gold_provenance_excludes_critic --test qa_pass_critic_combo

# 2. qbank / mastery / nullable 集成测试（真实迁移建库，可与 1 分开看失败面）
cd src-tauri && cargo test --test qbank_verdict_three_paths --test mastery_qbank_correction --test anki_nullable_card_reads

# 3. 本轮扩展的前端测试 + 同目录 r3 存量
npx vitest run src/features/anki-tasks/__tests__ src/stores/__tests__/recordPracticeAnswer.regrade.test.ts

# 4. 本会话 r3/r5 前端存量回归（chat 块 + 遮挡 overlay）
npx vitest run tests/vitest/chat-v2/plugins/blocks src/components/anki/__tests__/ImageOcclusionOverlay.test.tsx

# 5. 前端类型门禁（cargo test 已隐含 Rust 编译）
npm run typecheck
```

说明：命令 1/2 的 `--test` 多目标为 cargo 原生支持；vitest 配置
（`vitest.config.ts` include 同时覆盖 `src/**` 与 `tests/vitest/**`）对命令
3/4 的路径过滤直接可用。B 路 e2e（`qbank_executor_e2e`，harness=false）不在
本清单——是否随第 8 轮扩展见 §5 缺口 1。

## 4. 预期红绿（只静态推断，零执行）

**总预期：8 个文件全绿。** 依据：本台账已逐一核对各测试引用的产品符号在
tip 工作树真实存在且可见性正确——`anki_image_occlusion` 5 函数 +
`ValidatedOcclusionSpec` 字段 pub；`anki_gold_set` 的
`CONTENT_PROVENANCE_FIELD`/`PROVENANCE_ACTOR_{USER,LLM_CRITIC,IMPORT,SYNC}`/
provenance 三判定/`ContentProvenance`；`anki_critic` 的
`parse_critic_response`/`plan_updates`/`sanitize_plan_for_disabled_qa_pass`/
`gold_references_from_cards`；`anki_protocol::StructuredOutputOptions::{from_options_json,qa_pass_enabled}`；
`anki_qa_lint` 的 `codes::*`（含 `PLACEHOLDER_RESIDUE`/`MULTI_CONCEPT`/
`TAGS_EMPTY`/`FIELD_RULE_*`）；`mastery::record_qbank_verdict_correction`；
`database` 六条读 API 与 `fsrs_review_service::list_feedback_rows`；
`question_bank_service::{submit_answer,regrade_submission}` pub（原语
`apply_submission_verdict_in_tx` 为 pub(crate)，r7 测试均未直接引用）；
前端 `types.ts` 导出 `classify`/`hasWarnings`/`SessionGroup`、store 导出
`recordPracticeAnswer`/`applyAuthoritativeDailyProgress`。

分文件风险分级（红 = 需人工介入；「契约演进红」= 设计上会红以暴露漂移，非缺陷）：

| 文件 | 预期 | 编译红风险 | 断言红风险（转红即信号） |
| --- | --- | --- | --- |
| `occlusion_export_roundtrip` | 11 绿 | 低（全 pub、r2 部分曾在位） | 矩阵 10 的 f32 舍入字面值系手工推演（`.3333`/`.6667`/`.1235`），若与 `{:.4}` 实现有出入会红；`ValidatedOcclusionSpec` 直构被封住 → 编译红（r7-01 §4.1 已预告） |
| `gold_provenance_excludes_critic` | 14 绿 | 低 | 对齐锁：本地常量 ↔ 产品符号逐字断言，产品改常量即红（契约演进红，正是其职能） |
| `qa_pass_critic_combo` | 11 绿 | 低（符号全核对） | fixture 触发特定 lint code 依赖启发式阈值（双问号 → `multi_concept`、`{{DOCUMENT_CONTENT}}` → `placeholder_residue`）；lint 阈值调整会红。残缺 options JSON fail-open（false 不生效）断言锁定当前实现语义，若后续改为宽松解析会红 |
| `qbank_verdict_three_paths` | 13 绿 | 低（夹具与旧 7 例同源） | B→C 交接用「终态种子 + 覆写 grading_method='ai'」逼近（r7-04 §1），schema 列名/约束漂移会红；守卫错误分支断言依赖具体错误路径 |
| `mastery_qbank_correction` | 3 绿 | **最低**（r7-06 已过 `cargo check`，属过程违规但客观降低了编译红概率） | EMA 常数 0.35/0.65 依赖 α=0.30、起点 0.5、weight=1 三参数，任一调整即红 |
| `anki_nullable_card_reads` | 5 绿 | **最高**——手建历史 schema 的列集合必须覆盖六条 mapper 读取的全部列（缺列 = InvalidColumnType 运行红甚至查询报错）；`AnkiLibraryCard`/`FsrsFeedbackRow` 字段签名靠静态核对未经编译 | 断言语义与 r5-03 声明逐条对齐（front/back→空串、tags/images→空 Vec、text 保持 None），读侧兜底被改动即红 |
| `classify.mixed.test.ts` | 12 绿 | —（typecheck 覆盖） | 真值表预期由 types.ts **注释声明的优先级**独立推导而非照抄实现；实现分支序与注释不一致时会精确红出翻掉的组合（设计信号） |
| `recordPracticeAnswer.regrade.test.ts` | 18 绿 | — | 用例 2 的空操作断言依赖 `questionId in results` 门禁的短路实现（r7-05 已标注第 8 轮首查点）；apply 字段边界（不动 answered_results）若产品侧扩大覆盖面会红 |

横向风险（影响命令 1/2 整体）：六个 Rust 文件中五个**从未经过任何编译**，
第 8 轮首跑最可能的失败形态是编译错误（符号拼写/签名/借用）而非断言失败；
建议第 8 轮先跑命令 1/2 收编译面，再看断言面。

## 5. 缺口（第 8 轮及以后）

1. **B 路（AI 判分）integration 仍不可直接测**：`QbankGradingEmitter` 强依赖
   `tauri::Window`、无 trait 注入点；补 harness=false 注册须改 Cargo.toml
   （产品文件）。r7-04 §2 已给 manual/auto 转移表；第 8 轮若扩展
   `qbank_executor_e2e.rs` 可把 B2/B5 升级为 auto，并将 manual 步骤降级为回归项。
2. **in-crate 欠账**（tests/ crate 触不到，r7-07 §二已写入测试头注释）：
   `map_due_row` 的 Option 双保险（SQL 已 COALESCE）、私有
   `load_review_cards_for_states` 的「NULL 兜底 vs 非法 JSON 硬错」区分语义、
   `is_error_card` NULL 不在 r5-03 契约内未扩面。
3. **模块内单测归属未越界但需第 8 轮确认存在**：`update_anki_card` DB 事务语义
   （NotFound/CAS/tombstone）、apkg `map_card` forged-field 剥离、
   `chatanki_update_library_card` 执行器接线（构造子形态已由 r7-02 覆盖 8 锁定）。
4. **vlm:// 占位 text 的 `<img src="pending-image">` 残留未锁**：r6-01 §三.2
   遗留项，r7-01 刻意只断言 images 侧契约以避免修复时误红；归后续轮裁决。
5. **前端 r3/r5 存量零扩展**：banner/preview/QaMedia/overlay 本轮未加用例；
   命令 4 仅回归存量。CriticSummary 的 `gold_references` 前端消费（r6 补丁）
   无新增断言。
6. **无跨进程/运行时验证**：事件时序（TaskCompleted/CriticSummary）、真实
   Anki 导入、AnkiConnect 实机、SSE 断流取消（B5 manual）均无自动覆盖。
7. **r7-08 未观察到产物**：若该位存在且晚于本台账落盘，其清单需在第 8 轮
   开跑前补录（本文件与主台账 §13 不回改，按只追加纪律另行补记）。

## 6. 过程违规记录（不补救、不作门禁证据）

- r7-06（mastery）代理执行了 `cargo check --test mastery_qbank_correction`
  并自述通过。第 1–7 轮禁编译；与第 5/6 轮两次 cargo check 违规同类处理：
  记录在案，不据此宣称编译门禁已绿，第 8 轮照常全量跑。
- 其余六位代理自述且经 `git status` 佐证：只落盘未执行、零产品代码改动。
