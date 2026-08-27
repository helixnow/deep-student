# 0824 Wave2-E 第 2 轮 · 报告 09:兼容性复核(审阅员-兼容)

- 角色:第 2 轮「审阅员-兼容」(0824 Wave2-E)
- 模型:claude-fable-5-thinking-high
- 纪律:只读复核。未编译/未测试/未跑 CI,未改产品代码,未 commit
- 审阅对象:`anki_gold_set.rs`、`anki_critic.rs`、`apkg_importer_service.rs`、
  `apkg_exporter_service.rs`、`streaming_anki_service.rs`、
  `chat_v2/tools/chatanki_executor.rs` 的工作区 diff
- 对照文档:`wave2-E-r2-06-gold.md`、`wave2-E-r2-03-apkg.md`、`wave2-E-r2-02-ingest.md`

## 结论先行

| 项 | 结论 |
|---|---|
| **兼容阻断** | **0 条** |
| KeptUnedited 正例桶是否被误杀 | **否** |
| 非阻断观察项 | 4 条(见 §6,均为边缘场景或已在 r2-06 §8 登记的遗留) |

五项复核逐条通过。所有旧数据路径(无 `_occlusion` 旧卡、无
`_content_provenance` 旧卡、旧 GoldCandidate JSON、旧 APKG 往返)均为
恒等变换或保守降级(Unlabeled / 剥离机器字段),无 panic 路径、无破坏性
语义变更。

## 1. 旧卡无 `_occlusion`:导出是否零行为变化

**通过(除 `_` 泄漏修复这一期望变化外为恒等变换)。**

- 转换器 `convert_occlusion_card_for_export` 首行
  `parse_occlusion_field(&card.extra_fields)`(exact-key `_occlusion` 查找
  + serde 解析,坏 JSON 亦返回 `None`)→ `let-else` 提前返回。无
  `_occlusion` 的旧卡 text / images / front / back / extra_fields 全部不被
  触碰,测试 `normalize_keeps_cards_without_occlusion_unchanged` 固化了
  恒等断言(含 `AnkiIvl` 调度键与业务字段)。
- 随后的 `extra_fields.retain(|k,_| !k.starts_with('_'))` 只删 `_` 前缀键
  ——这正是本轮的泄漏修复(此前 `_qa_flags`/`_original_generation` 等会
  进入 model 字段表与 note 字段值),属期望变化。
- **`Anki*` 调度键不受 retain 影响**:`card_sched_restore`(两条导出路径
  的 1269 / 1946 行调用点)在 normalize 之后从内存 `card.extra_fields`
  读取 `AnkiIvl/AnkiReps/...` 回写复习进度,复核确认 retain 谓词只匹配
  `_` 前缀,调度还原链路完整。字段表层的 `Anki*` 过滤
  (`is_reserved_import_metadata_field`)是既有行为,本轮仅并入统一谓词,
  口径不变。
- 五个导出入口全部收敛:`export_cards_to_apkg` →
  `..._with_template` → `..._with_full_template` →
  `..._with_full_template_report`(normalize 落点);
  `export_multi_template_apkg` → `..._report`(normalize 落点)。
  无绕过 normalize 的入口。
- normalize 作用于按值传入的导出副本,不写回卡片库,库内
  `_original_generation`(critic 修正对数据源)不受影响——与 r2-03 §1
  声明一致,代码核实无写回路径。

## 2. 旧卡无 `_content_provenance`:读写崩溃 / classify 保守性 / KeptUnedited

**通过。无崩溃路径;classify 保守 Unlabeled;KeptUnedited 未被误杀。**

- **读**:`parse_content_provenance` 键缺失走 `?` 返回 `None`;非法
  JSON / 非对象 / 缺 actor 均 `.ok()?` 返回 `None`(测试
  `content_provenance_malformed_values_are_fail_closed` 覆盖四种坏值 +
  空 map)。`is_user_proven_edit` / `is_llm_critic_actor` 对 `None` 均
  `unwrap_or(false)`。无 unwrap/panic。
- **写**:`insert_content_provenance` 的 `expect` 仅作用于
  `ContentProvenance`(三个纯字符串字段)的 `serde_json::to_string`,
  该序列化不可能失败,`expect` 不可达。
- **classify 保守性**:`classify_candidate` 第 5 通道内,
  `original != current` 且 `edit_actor != Some("user")`(旧卡为 `None`)
  → `Unlabeled`,reason 含「缺编辑者证明」。旧卡真实用户编辑与路径 A
  污染卡不可区分,一律不挖——方向正确(宁可漏挖不可污染),测试
  `edited_content_without_actor_proof_is_unlabeled` 固化。
- **KeptUnedited 未误杀**:编辑者闸门位于
  `if let Some(orig) = &c.original { if *orig != c.current { ... } }`
  内部;`original == current`(或无 original 且未超宽限)的候选**不进入
  该分支**,直接落到第 6 通道按留存信号判 `KeptUnedited`,完全不看
  `edit_actor`。测试
  `user_actor_proof_keeps_kept_unedited_channel_untouched` 明确锁定
  「original == current + 无 actor → KeptUnedited」。第 1 通道新增的
  `edit_actor == Some("llm_critic")` 排除只影响带 critic 溯源戳的卡
  (旧卡不可能带),不触及旧卡正例。
- **收集器侧**:`gold_references_from_cards` 的 provenance 过滤对无
  provenance 的旧卡 `unwrap_or(true)` 放行,交由 classify 闸门兜底;该
  路径本就只产修正对(`review_count` 置 0,KeptUnedited 在此路径不可能
  产出),不存在正例桶损失。

## 3. 导入旧 APKG / 再导出:用户字段是否保留

**通过。用户可见字段完整保留。**

- **导入**:`map_card` 仅新增一个 `continue` 分支,剥离范围锁死在
  `UNTRUSTED_IMPORT_PROTOCOL_FIELDS` 三个可信凭证键
  (`_original_generation` / `_content_provenance` / `_qa_flags`,
  大小写不敏感)。正常旧 APKG(外部 Anki 生态或本产品修复后导出)不含
  这些键,导入零变化;用户业务字段(`Subject` 等)、`Anki*` 元数据注入、
  核心字段映射、媒体路径均未动,测试
  `import_strips_forged_internal_protocol_fields` 断言 front/back/
  `Subject`/`AnkiNoteId` 正常。剥离而非改名/打戳的选择与「导出侧从不写出
  `_` 前缀字段」自洽:合法往返不会经过该分支。
- **再导出**:非 `_` 用户字段照常进 model 字段表与 note 值
  (`is_internal_protocol_field` 对 `Subject`/`Extra`/`Occlusion` 等
  明确不命中,有测试);`Anki*` 键从字段表过滤是既有行为。
- **历史泄漏包的特例**(旧版导出器泄漏过 `_qa_flags`/
  `_original_generation` 的 APKG):再导入时这两个键被剥离——这正是
  期望行为(经外部往返的凭证不可信,防伪造回灌 gold),损失仅为该卡
  不再产修正对(保守方向),用户可见内容无损。

## 4. chatanki_update_library_card 打点:CAS/冲突语义

**通过。CAS/冲突语义零变化。**

- 打点位置在 patch 应用、内容校验之后、
  `update_anki_card_if_version_for_library` 之前,只改内存副本的
  `extra_fields`。CAS 判定依据是 `updated_at == expected_updated_at`
  字符串比较(`database/mod.rs` 5326 行),与 extra_fields 内容无关——
  打点不影响冲突判定。
- **Conflict / NotFound 路径**在任何写库之前返回,内存戳随副本丢弃,
  不产生任何持久化——与 r2-06 §4 声明一致。
- **Updated 路径**:该 DB 函数本就无条件 UPDATE(不做 no-op 跳过),
  local_version 递增、updated_at 刷新行为与改动前逐字节一致,唯一差异是
  `extra_fields_json` 多一个 `_content_provenance` 条目。同步链路 /
  版本冲突面无新增写入源。
- 后端统一覆盖写入(不信任调用方 payload 自带 provenance)是正确的
  收口方向,戳与内容同事务落盘。

## 5. serde default 是否覆盖 GoldCandidate 旧 JSON

**通过。**

- 新增字段为 `#[serde(default)] pub edit_actor: Option<String>`,默认
  `None`;既有 `critic_revised` 已带 `#[serde(default)]`。结构体无
  `deny_unknown_fields`,新旧版本互读双向安全(旧 JSON 缺字段 → 默认值;
  旧代码读新 JSON → 忽略未知字段)。
- 测试 `gold_candidate_old_json_without_edit_actor_deserializes` 用完整
  旧形状 JSON(同时缺 `edit_actor` 与 `critic_revised`)锁定零迁移。
- `edit_actor: None` 在 classify 中的落点即 §2 的保守闸门,旧 fixture
  经新代码重分类只会从 EditedMinor/Major 降级为 Unlabeled(离线数据
  重挖时的预期收紧),不会 panic、不会误入正例桶。
- `ContentProvenance` 本身:camelCase(三个字段均单词,实际 no-op)、
  未知字段忽略(`content_provenance_uses_camel_case_and_ignores_unknown_fields`
  测试含 `futureField`)、actor 用 String 而非 enum 保证未来新 actor 在
  旧二进制上可解析且 fail-closed。wire 契约向前向后兼容。

## 6. 非阻断观察项(不计入阻断)

1. **`_` 前缀用户自定义字段不再往返**:外部 APKG 若携带用户自造的
   `_xxx` 字段(非三个凭证键),导入仍保留,但再导出时被 normalize
   retain 剥离(改动前会随泄漏 bug 一起导出)。`_` 前缀已被声明为机器
   协议命名空间(r2-03 §1),方向合理;真实外部生态里 `_` 前缀模型字段
   极罕见。损失面≈0,记录备查。
2. **自定义模板显式声明 `Anki*` / `_` 字段名时 note 值变空**:
   `resolve_card_field_value` 新兜底闸门对协议字段名返回空串。改动前此类
   字段会输出 extra_fields 中的值。属防御性加固的预期代价,仅影响刻意
   声明保留字段名的极端模板。
3. **actor=user 戳的归因宽度**:`chatanki_update_library_card` 是聊天
   Agent 工具,LLM 代用户发起的库卡更新也会盖 actor=user;且 no-op patch
   同样落库并覆盖既有 llm_critic 戳(last-writer-wins)。在
   `enable_qa_pass=false`(marker 已剥)且 Agent 对 critic 修订过的卡做
   内容不变的更新这一多重叠加场景下,critic 手笔理论上可被"洗白"进
   修正对。r2-06 §8 已把"critic 修订后再编辑的回收"登记为超出 P0-2
   范围的遗留;此为该遗留的一个具体变体,建议第 3 轮 append-only 修订
   历史时一并覆盖。非旧数据兼容问题,不计阻断。
4. **用户 UI 编辑路径尚无 user 戳**(`cmd::update_anki_card` /
   `enhanced_anki_service` / anki_connect 保存):这些路径的真实用户编辑
   在新闸门下保守 Unlabeled,只损失挖掘量不引入污染,r2-06 §8 已登记,
   与本轮独占文件边界一致。

## 7. 审阅方法说明

逐行阅读六个文件的工作区 diff(共 1721 行),并对照产品代码核实:
`classify_candidate` 完整决策树(anki_gold_set.rs 505–656)、
`update_anki_card_if_version_for_library` CAS 实现(database/mod.rs
5310–5350)、五个导出入口的委托链、`card_sched_restore` 的两处调用点、
`parse_occlusion_field` 的失败语义、`GoldCandidate` 全部构造点
(仅 `gold_references_from_cards` 与测试)。未执行任何编译/测试。
