# L16-anki 独立验收（R5-review-learning，2026-11-04）

## 2026-11-05新main X6-LP-0062三处fragment日志窄复验

固定正常main`f2c6d46c468f57e920a55e1e59defb8dcf53f764`，仅审相对9b05e915a新增`generation-service.ts`日志差异。Rust `streaming_anki_service.rs:1553-1570,1713-1731,1778-1792`分别要求stream不可读片段带错误详情、residual不可读不带详情、wrapper截断错误卡专用文案，均用chars计数；当前TS通过phase区分、保`[ANKI_CARD_DEBUG]`前缀并以Array.from计Unicode字符，原丢弃/错误卡统计不变。

独立job **20261105034117-eb0f16**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t X6-LP-0062 --maxWorkers=1 --no-file-parallelism`，**1file/4pass/20标题过滤skip、20.86s、原始exit0，无Errors/Unhandled/FAIL或Warning段**；原件`/home/dsdev/.oc-jobs/done/20261105034117-eb0f16.{json,log}`。4条中3条为新stream/residual/truncated，1条是标题筛选同时命中的既有结构化协议拒绝→delimiter单次回退，不称4条新增用例。

- [x] **X6-LP-0062上述三处fragment日志子项**：真实trigger_task_processing、生产parser/残留wrapper修复、SQLite、Host logger exporter与事件/运行句柄清理实际执行；warning精确数组、Unicode8/15字符、dropped/failed/cards计数、截断错误卡正文与不可读片段事件均保留并通过。上游llm/llmStreaming/docs为原fixture替身，不是模型或网络真实链；故不签LP0062全域、A1/A2完整生成或其余日志。报告提交后§5最终tip门禁仍必需。

### 后继59451501c：LP0063 residual错误分支复核

正常main父cf92ce1eb；相对56eecb90a新增generation-service.ts:655-657 residual解析失败debug并返回false，随后:727-735只保存原payload且失败静默best-effort；truncated:696-705同样不额外记error。对照Rust streaming_anki_service.rs:1713-1733/1794-1806，不把普通stream错误分支的errorCardContent包装与error日志套到residual。新3例为field-error正常保存、field-error拒绝保存、truncated拒绝保存，经真实trigger/parser/SQLite trigger/Host exporter，验证仅一次INSERT尝试、原payload、无error日志、failed_cards恰1及运行完成；db.run spy原调用透传。llm/stream/docs依旧fixture替身，不签真实供应商链或所有residual成功/去重日志。

- [x] **LP0063上述三分支窄项**：独立job **20261105041542-b91f8c**，`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t X6-LP-0063 --maxWorkers=1 --no-file-parallelism`，**1file/3pass/24标题过滤skip、19.97s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原receipt/log在`/home/dsdev/.oc-jobs/done/20261105041542-b91f8c.{json,log}`。该最小集因官方594 gate实际只选Chatanki而补，不冒称27条全执行或完整生成/全部LP0063闭合；最终报告tip仍须§5。

旧最终gate `56eecb90a/basef2c6d46c4`原tests job20261105034708-504797 exit1，1277pass/1fail/1外部APKG skip，唯一document-processing.test.ts:454 CJK/emoji硬切测试超30000ms（30581ms），无额外Errors/Unhandled。失败用例本次未改，原因未确认，不改预算/输入/断言、不以LP0062独立4pass冒充旧gate通过。

### a94bf2aa6遮挡draft单次消费窄复验（ac92e40cb，2026-11-05）

C1指定复验前，库列表最终gate已完成。另固定已正常merge的`ac92e40cbe0b4cf858e1797e557d03084a86b008`（main父`92365bc5c85d947c12d442a2b02fbf1ab0675b7c`），a94bf2aa6祖先核验为true，不使用供方Node/Electron29或旧parser35代本次证据。

Rust `streaming_anki_service.rs:1522-1543,1742-1763`仅在parse_and_save返回Some(card)且card含OCCLUSION_FIELD时清pending；TS `generation-service.ts:614-631`同条件调用clearOcclusion，null重复返回在前。正文循环`:532-536`本来清外层变量；残留调用`:587-591`把对象传到processResidual的局部参数，旧callback只清外层，下一payload仍读局部旧引用。新`:716-724`callback同时置局部pending=null再清外层，匹配两卡序列只首卡消费。

独立job **20261105045055-29b2d4**：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t 'consumes the pending occlusion draft only after the first saved card' --maxWorkers=1 --no-file-parallelism`，**1file/2pass/27标题过滤skip、20.06s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。原receipt/log在`/home/dsdev/.oc-jobs/done/20261105045055-29b2d4.{json,log}`。

- [x] **遮挡draft正文两卡控制/收尾两卡局部引用清理子项**：真实trigger、draft marker、生产parser/残留wrapper展开、SQLite保存/读取及运行完成；first的imageRef/images/tag/cloze/答案断言保持，second的机器字段不存在、images空、无image-occlusion标签、text null和独立答案均通过。上游llm/stream/docs仍fixture替身；原统计路径真实执行，但这两例没有独立GenerationStats字段断言，不扩为统计全域证据。重复卡/保存失败保留draft仅静态核条件，未由两例动态穷尽；不签完整遮挡、模型或全部失败路径。

C1转述供方首040703为1pass/1fail/27过滤/exit1，修后29pass/exit0，保来源且不代R5独立运行。报告统一提交后§5最终tip gate，完成后不再追加确认文档。

### estimateTokens U+3000 guard等价性及原硬切保证（7fc4bf00b，2026-11-05）

C1指定正常main eaa17bc7e的任务与在途树一致：固定`7fc4bf00bd72761a9740cfe8e1b869811b7c3249`、main父`eaa17bc7e27ea6e522d3b51e093a7d2e05b2c290`，25efce989/faff8b6b9均祖先核验true。唯一生产变化为`document-processing-segment.ts:35`的`code <= 0x3000 && isRustWhitespace(code)`。共享`util/text.ts:9-22`全部White_Space成员≤U+3000，故高码点省略的是恒false调用；低码点仍经同一共享表。原Rust document_processing_service.rs:257-276的标量计数、split_whitespace词数、CJK范围、f32乘积/截断与字符数1/4下限均保留；二分切点/切片分配未改，不宣称复杂度降低。

实际diff只向测试加入9个向量；原31例、`汉字テスト한글😀🚀内容`样本、增长到≥25000 tokens循环、每段10000预算/无损/非空断言及30秒配置未改。新向量覆盖U+3000空白、U+3001非空白、NEL/U+2000、BOM、emoji及纯U+3000/BOM。已只读核配置/共享表/f32辅助常数相对上一被测树无diff，没有减少输入或用假数据计数替代原循环。

复用同树在途官方独立job **20261105050552-d1b549**（anki/chatanki目录），无需再重复新9＋原forced：**99files/1317pass/1外部APKG skip、323.52s、原始exit0，无Errors/Unhandled/FAIL段**。`document-processing.test.ts` **40条全过，无该文件skip/标题过滤**，文件16652ms，原`forced_char_split_preserves_cjk_and_emoji`测试体 **3801ms**。官方receipt 05:13:17.442Z、tip7fc4bf00b/baseeaa17bc7e、ok:true/failed:[]；typecheck2a2872/boundariesf6e5f3/importable5bd985（同前缀20261105050552）均code0。原metadata/log在`/home/dsdev/.oc-jobs/done/`。

- [x] **该guard语义等价性与原CJK/emoji硬切保证窄项**：源码逻辑与新9＋原forced实际运行共同确认。3801ms是本次测试体观测，不是隔离benchmark；旧034708的30581ms超时仍保留，先前88df通过发生在guard之前，不能归功新补丁。不把减少恒false调用说成减少码点扫描复杂度，也不推断profile占比/唯一CPU或RPC根因/全局负载已解。C1提供的043441旧实现9pass、043803 Node69/Electron40及042845规模元数据保持供方分类，未用其替代本轮独立结果，未另执行4631次增长loop或Rust。

仅此窄项闭合；报告统一提交→正常merge main→最终tip一次§5，结果后不追加确认文档改变tip。

结论：不通过

初审基线 `f23c98702`。原无 ACCEPTANCE；独立只读审读，未编译/运行 Rust。历史增量保留；最新正常main复验基线`1e80f32b4`，四项官方自检全过，窄签收及剩余范围见文末。前文“候选未main”描述均保留其原时间/快照含义。

## 必须修复

- [ ] **A1 / 真实生成已main，完整生成语义仍非整项签收。** 1e80f32b4已集成本lane生成服务消费llm/llmStreaming、路由/trigger及真实运行取消；本轮独立生成命令20条等通过，不能继续称仅候选/端口不存在。真实模型供应商、完整生成分支/日志及其它未覆盖范围不由门禁绿灯自动证明。
- [ ] **A2 / 路由、Context regex、独立运行信号已补，集成待验。** `18c563a46:src/generation-service.ts:390-436,1006-1022`消费llmAnkiRouting做Generator/Critic决策；`plugin-handlers-generation.ts:45-63`从Context取nativeRegex；`enhanced-service.ts`改Map运行句柄并传runSignal/onReady。后继b81395fe7配置成功/错误返回都先检查abort，见A4；ready已回执，完整main生命周期/日志链仍未签。
- [x] **A3 / main原FSRS双写及普通删除锁模式复验签收。** `1e80f32b4`删除/APKG通过真实L15公开owner共享tx，Anki生产仓储无直接fsrs_card_states/fsrs_review_logs写SQL；普通删除默认deferred、原CAS/APKG immediate保持。独立job20261104203909-c2516b中anki-db16、APKG50执行、review事务3及真实L24删除4例通过。只签已定位所有权/事务问题，不代表所有表/失败组合均穷尽验证。
- [x] **A4 / main运行句柄取消及config reject-after-abort修复签收。** 当前generation-service.ts:320-337使用独立runSignal，配置成功/失败返回都先检查abort，取消后不补handleTaskError。独立本轮anki-generation-commands20条通过，包含真实start/delete在配置等待及reject分支的无错误副作用断言；原Map/abort实现已main，不再候选待验。其它生命周期/日志全域不由此一并签收。
- [x] **A5 / 原七个公开服务面及指定真实消费者联合复验签收。** `1e80f32b4`正常main已补vfsRepos→notes→vfsIndex→vfs→chat真实宿主装配，原七项类型兼容断言保留；独立service-surface10例及真实L16造卡→L24 hydrate→L15 CAS4例通过、正式tsc通过。该签收关闭原缺公开面/真实装配证据缺口，不代签所有工具、APKG全域或完整L04事件链；更大范围仍由各自finding约束。下方候选/失败阶段保留历史。
  **最新main复验**：1e80f32b4已补真实vfsRepos/notes/vfsIndex依赖及安装顺序；A5服务面10条、旧L24SurfaceCompatibility类型检查及真实公开D34条均独立通过。原“候选未main/A5装配失败”已解除，七面/这些消费者子项签认；保留未覆盖的全部工具/完整L04事件等更大范围，不再以旧缺依赖阻塞当前main。
  **D3后继a47f42ded**：实际代码bcb3f2b61/c34dfbe14已将library/session删除CAS内部版本改bigint、typeof/TEXT精确读取，输入number|bigint|null；对应服务/SQL候选修复认可。5例提供方通过中list wire例withReview:false并注入快照，只证明L16命令+kernel投影。类型检查仍exit2于L24SurfaceCompatibility，不可删断言求绿；A3同事务删除与A5整链待正常main联合复验，详见文末。
  **987c446f1正常main独立阻塞**：job20261104172659-6c494f在A5文件beforeAll:181安装vfs时报PluginLifecycleError，缺notes/vfsRepo/vfsIndex，10条用例未执行；这是fixture真实依赖装配错误，不是业务断言失败或10秒hook超时。须由owner补齐依赖及正确安装顺序，不能改为假provider或删原断言。
- [ ] **A6 / 最新候选已修Option-null与body阶段两残差，待main最小复验。** `1e9f3a999`完整树中`3726cd69f`把result:null解成None，`997d629a8`将读body移到各调用方text/json阶段；原两反例静态确认修复。新Host回归9条属于提供方4文件50pass/exit0，不是整job9条。候选非main，真实undici/hyper底层source文案未完全复现，不能以阶段前缀修复签所有传输错误等价。
  **当前main状态**：本轮已集成并独立执行anki-connect-response-stages9条全部通过；Option-null、version/deck读取阶段及非2xx不读body子项已签认。底层source文案等剩余范围未证明完全等价，A6整项仍开放；上句候选状态保留为历史。
- [x] **X7-L16-OCCLUSION-IMAGE-TRIM / main原反例签收。** 1e80f32b4已用rustTrim，独立image-occlusion-rust-trim9条通过，NEL空引用拒绝/BOM保留及归一化符合Rust:219-224,350。只签该正式ID，非C级差分。
- [x] **X7-L16-OCCLUSION-LABEL-TRIM / main原反例签收。** 同组独立测试验证NEL默认“区域 1”、BOM保留及生产AnkiConnect rebuild/cloze文本；对齐Rust:332-336，不外推全部字符串或serde行为。
- [x] **X6-LP-0061 / main模板失败warn子项签收。** 本轮apkg-importer51条中50执行通过（唯一外部环境skip），包含真实importBytes＋SQLite模板失败trigger：按原顺序记录id/name/error，再report.warnings，已提交卡片保留且协议字段剥离。对应Rust:2591-2598的缺日志子项闭合，不签全部APKG日志。
- [ ] **X6-LP-0060 / 导出日志与清理候选部分修复，待main复验。** 实际e9c2b05a1/5c1559b10补字段/媒体warn、single丢report汇总及清理错误不覆盖主结果；54f513a66仅报告。multi-report原静默清理保持，测试caller-only multi丢report wrapper第8项未强行接生产。7条真实命令用例提供方通过不代表整组日志闭合，详见文末。

## 建议

- [ ] 清理拆分文件重复的大段未使用 imports（如 `src/plugin-handlers-cards.ts:13-174`），让业务依赖图反映真实调用，降低 A2 这类假阳性。
- [ ] 保留外部 APKG 环境样例 smoke 的跳过说明；真实库测试与环境 smoke 分开报告，避免把“568 passed”写成“569 passed”。

## 已核实通过

- [x] **X7-L16-SERDE-front / main窄范围闭合。** 固定原输入`front: 3`直接调用生产decodeAnkiCardInput，返回AnkiCardDecodeError；依据X7独立main复验`20261104163838-b3c3ab`及R5脚本/源码核对，详见文末。只签该String错类型拒绝，不签IPC绕过或整个serde。
- [x] **X7-L16-SERDE-tags / main窄范围闭合。** 固定原输入`tags: [3]`得到AnkiCardDecodeError，未把数字改成字符串；证据/范围同上。
- [x] **X7-L16-SERDE-extra_fields / main窄范围闭合。** 固定原输入`extra_fields: { key: 3 }`得到AnkiCardDecodeError；只签Map值错类型拒绝，原历史actual保留。

- [x] 复核确认：AnkiConnect 的15条 ported 抽查保留 Rust 原断言，调用真实生产 helper，见下表。
- [x] 复核确认：模板更新先存在性、expected_version、合并校验，再 CAS；内置模板 user_modified 写失败只 warn（`src/plugin-handlers-templates.ts:213-252`；Rust `src-tauri/src/commands.rs:4321-4391`）。
- [x] 复核确认：模板删除保留 builtin 停用/用户模板物理删除分支及引用数量返回形状（同 TS `:255-299`；Rust `commands.rs:4403-4461`）。
- [x] 复核确认：31个测试文件，568条通过、1条环境 smoke 跳过；原生入口可导入。服务 `anki` 及 meta.provides 已使用新名（`index.ts:68`、`src/service.ts:42`、`api.ts:20`）。
- [x] 复核确认：抽查生产文件无测试替身导入、无 `console.*` 调用；SQL 在 repository。跨表所有权不通过，见 A3。

## 命令等价抽查（初审18条快照）

TS 根为 `host/plugins/anki/`；Rust 简称 E=`src-tauri/src/cmd/enhanced_anki.rs`，C=`src-tauri/src/commands.rs`。契约 `contracts/ipc/L16-anki.json`；以下通过均仅覆盖列出的数据分支与错误形状。

| 命令 | 结论/核对点 | TS 文件:行 | Rust 文件:行 |
|---|---|---|---|
| update_anki_card | 通过：Cloze允许空back；写user provenance；0/1/异常行数区分 | src/plugin-handlers-cards.ts:180-194 | E:267-283；crates/dstu-anki/src/enhanced_anki_service.rs:790-805 |
| delete_anki_card | 问题 A3；空ID校验、bool true 返回正确 | src/plugin-handlers-cards.ts:197-205；repository/anki-cards.ts:221 | E:288-302 |
| delete_document_task | 问题 A3；空ID/失败包装正确 | src/plugin-handlers-cards.ts:208-216；repository/anki-cards.ts:229 | E:307-321 |
| delete_document_session | 问题 A3/A4：只删库，没有取消运行态 | src/plugin-handlers-cards.ts:219-227 | E:327-344；crates/dstu-anki/src/enhanced_anki_service.rs:901-932 |
| get_document_cards | 通过：实际仓储返回卡片、DB错误前缀 | src/plugin-handlers-cards.ts:230-238 | E:381-394 |
| get_document_tasks | 通过：按文档读取并解码 TaskStatus | src/plugin-handlers-cards.ts:241-249 | E:231-244 |
| get_document_task_counts | 通过：读取失败返回全零，保留原行为 | src/plugin-handlers-cards.ts:252-259；repository/anki-cards.ts:152-186 | E:197-205；crates/dstu-anki/src/enhanced_anki_service.rs:1061-1079 |
| get_task_cards | 通过：按 task 读取，失败 DB 包装 | src/plugin-handlers-cards.ts:262-270 | E:248-263；crates/dstu-anki/src/enhanced_anki_service.rs:779-781 |
| list_anki_library_cards | 问题 A3；默认1/12、上限200、100张分批快照正确 | src/plugin-handlers-cards.ts:374-431 | E:478-512 |
| get_anki_library_card_content | 通过：缺卡null，读取失败Database | src/plugin-handlers-rest.ts:179-189 | E:461-473 |
| get_all_custom_templates | 通过：查询失败前缀、解码列表 | src/plugin-handlers-templates.ts:179-186 | C:4280-4287 |
| get_custom_template_by_id | 通过：Option→null、错误前缀 | src/plugin-handlers-templates.ts:189-197 | C:4292-4300 |
| create_custom_template | 通过：校验先于UUID/写库，返回ID | src/plugin-handlers-templates.ts:200-210 | C:4304-4316 |
| update_custom_template | 通过：存在→版本→校验→CAS→warn副作用 | src/plugin-handlers-templates.ts:213-252 | C:4321-4391 |
| delete_custom_template | 通过：builtin软停用与用户模板硬删、返回对象 | src/plugin-handlers-templates.ts:255-299 | C:4403-4461 |
| count_custom_template_references | 通过：计数与Database包装 | src/plugin-handlers-templates.ts:302-308 | C:4466-4473 |
| start_enhanced_document_processing | 问题 A1：命令未注册 | index.ts:11-64 | E:86-118 |
| get_anki_deck_names | 问题 A6：错误文本改写；默认5s请求存在 | src/anki-connect.ts:174-205 | crates/dstu-anki/src/anki_connect_service.rs:440-478 |

## 测试真实性抽查（初审15条 ported 快照）

Rust 文件统一 `src-tauri/crates/dstu-anki/src/anki_connect_service.rs`；TS 文件统一 `host/plugins/anki/tests/anki-connect-service.test.ts`；TESTMAP `:21-35`。测试对象为 `src/anki-sync.ts` 生产函数，生产同步命令在 `src/plugin-handlers-cards.ts:337-346` 调 `addNotesToAnkiDetailed`，不是测试自实现。

| 测试名 | Rust行 / TS行 | 结论、核实断言 |
|---|---|---|
| custom_model_identity_uses_template_id_and_version_not_note_type_or_title | 1715 / 113 | 通过：改名不变、改ID/版本变化 |
| existing_models_must_match_field_order_card_faces_and_css | 1730 / 125 | 通过：字段顺序/模板面/CSS/额外卡面 |
| can_add_false_with_valid_note_is_duplicate | 1788 / 142 | 通过：合法note归重复 |
| can_add_false_with_empty_first_field_is_failure | 1799 / 146 | 通过：空白首字段归invalid |
| can_add_false_with_unknown_model_fields_is_failure | 1810 / 150 | 通过：未知模型字段归invalid |
| can_add_false_with_missing_model_field_is_failure | 1821 / 155 | 通过：缺Back归invalid |
| note_serialization_omits_empty_media_attachments | 1833 / 161 | 通过：空audio/picture省略、附件url省略 |
| media_filename_classification_and_ref_extraction | 1854 / 176 | 通过：声音扩展名、HTML/sound引用顺序 |
| read_media_file_base64_reads_and_limits | 1876 / 190 | 通过：真实临时文件base64与缺文件；原Rust同样未断言超限 |
| duplicate_note_error_detection_is_case_insensitive | 1887 / 202 | 通过：Duplicate大小写及非重复 |
| sync_report_omits_empty_optional_fields_for_backward_compat | 1898 / 208 | 通过：旧键存在、新空键省略 |
| sync_report_serializes_structured_model_errors_when_present | 1921 / 227 | 通过：结构化模型错误、warning |
| internal_protocol_field_predicate_covers_underscore_and_reserved_keys | 1978 / 243 | 通过：保留字段大小写、正常字段不挡 |
| occlusion_json_never_leaks_into_emitted_fields | 1989 / 253 | 通过：Occlusion/AnkiNoteId无泄漏 |
| occlusion_card_prefers_card_text_and_mounts_image_ref | 2019 / 271 | 通过：保留已创作Text、挂原图、无warning |

另查的模块级接线问题见 A2；上面15个通过样本不能为其余503个 ported 背书。TESTMAP 无 merged/obsolete；112 pending 尚未满足“原测试全部移植”。`external_apkg_env_smoke` 被条件跳过，证据 `tests/apkg-importer.test.ts:1872`，不是本次通过用例。

## 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/anki
Test Files  31 passed (31)
Tests       568 passed | 1 skipped (569)
Duration    59.59s
exit 0
(node:...) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ node scripts/electron-migration/wiring.mjs --lane anki
合计 ported 518，其中所测模块未从 index.ts 接入 0（0.0%）
```

四入口合并调用 `node scripts/electron-migration/importable.mjs`，包含 `host/plugins/anki/index.ts`，输出 `importable: ok`，退出0。测试在测试自身创建的临时 SQLite/文件目录运行，未运行 Rust。

## 语义差异与缺口分类（初审快照）

- 应修：A1–A6。特别是“生成未注册”与“helper已单测”是两个不同事实；不能用后者推导生产流程完成。
- 已登记平台差异：`docs/dev/electron-migration/decisions.md:52-59` 的毫秒精度；同文件 `:34-35` 的诊断细节豁免不覆盖 A6 的用户可见返回错误。没有发现批准删除生成、取消或所有权分支的记录。
- 缺9命令：`cancel_document_processing`、`generate_anki_cards_from_document`、`generate_anki_cards_from_document_base64`、`generate_anki_cards_from_document_file`、`get_document_processing_state`、`pause_document_processing`、`resume_document_processing`、`start_enhanced_document_processing`、`trigger_task_processing`。

## 协调者指令1：A1/A2 增量复核

`355e79df1` 已在合并基线 `4b9c2809b`。该提交本身修改 SPEC 和生成测试；实际生成端口/handler来自其祖先 `e492d1001`、`840b04705`，本次审的是累积生产树。

真实入口与断点：

```text
index.ts / plugin.ts → createGenerationHandlers
  generate_anki_cards_from_document → requireCardGeneration → ctx.get('ankiGeneration@1') → null → Configuration
  start_enhanced_document_processing → enhancedDeps → generation null → Configuration（尚未分段/创建任务）
  若测试注入该端口：startDocumentProcessing → DocumentProcessingService（真实）
    → processAllTasksAsync → generationDouble.processTaskAndGenerateCardsStream（只记录task，无切卡/入库）
```

对 `host/plugins` 所有 TS 检索该服务名/方法，只有 Anki消费及测试提供，未发现L02运行时提供方。当前生产 `src/streaming-anki.ts` 有 `parseAndSaveCard`，但 `new StreamingAnkiService` 在生产无调用；Rust 同一流式服务负责task状态、parse/save和critic，不能把这些自有业务全算作外部LLM缺口。

定向测试核实了两类事实：无生成服务确实失败且不写任务；注入替身时命令封装/分段调度确实能通过。`start_creates_tasks_emits_started_and_runs_each_task_to_completion` 只断言任务创建、seen IDs、文档事件/运行态，没有断言流式正文切卡后卡片入库；`generate_from_document_maps_success_and_passes_subject_and_options` 的端口甚至不接收/记录入参，只返回预置cards（`:84-87,174-185`），不能用标题宣称验证了subject/options传递。

```text
npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts -t 'generate_from_document_fails_configuration_without_generation_service|start_fails_configuration_without_generation_service_and_writes_no_tasks|start_creates_tasks_emits_started_and_runs_each_task_to_completion|generate_from_document_maps_success_and_passes_subject_and_options' --maxWorkers=1 --no-file-parallelism
Test Files  1 passed (1)
Tests       4 passed | 13 skipped (17)
Duration    8.95s
exit 0

node scripts/electron-migration/importable.mjs host/plugins/review/index.ts host/plugins/anki/index.ts
importable: ok
exit 0
```

13 skipped 为 `-t` 过滤。结论：A1/A2均保持未勾选；已认可新增声明、真实分段/调度代码，不重复要求实现这些已有部分。需要接通 L16-owned streaming 的真实调用，再以模型传输边界替身验证切卡/入库/事件/critic。仅Linux Node，未验证Windows/macOS/Electron；未重跑整目录、未改其他验收项勾选。

## C1 06:00Z新交付：`ecccdc845` 定向静态复核

### 基线与运行记录边界

审读HEAD=`b2394fbe4`，检查时main=`fa99dd561`；`ecccdc845`对二者祖先检查均exit1。静态读取 `f00b1f8d2/871ff7045/00d643968` 等累积在候选中的实现，未摘入审读分支、未运行旧代码测试、未执行候选。下面路径均相对于该候选 `host/plugins/anki/`。

C1本次交付提供的运行时间线：增强后定向6文件56/56干净exit0，随后全目录719用例断言通过但RPC errors/exit1；更早719pass/exit0早于最后测试增强，**不可覆盖后续修改**。候选 `SPEC.md:1329-1339` 自述亦区分了该时间线，但本报告以C1交付为来源，不将SPEC自述当R5亲跑。未提供原始完整flags/错误数量，不补造；本轮R5测试命令/作业号/退出码不适用。任何后续重测试须经全局job队列，不直接执行Vitest/tsc/build。

### A1/A2：生成真实入口和测试真实性进展

生产链已静态确认：

```text
index.ts → plugin.ts/createGenerationHandlers
  → plugin-handlers-generation.ts:generationService
  → new StreamingAnkiService + new AnkiGenerationService
  → llm配置/密钥 + llmStreaming.singleShotCompletion（模型传输边界）
  → DeltaQueue → extractCardFromBufferImpl → StreamingAnkiService.parseAndSaveCard
  → SQLite卡片 + NewCard/GenerationStats/TaskCompleted
  → opt-in collectGoldReferences/runCriticPass → CriticSummary
```

关键行：`plugin-handlers-generation.ts:40-54`；`generation-service.ts:454-605,639-765,868-898`。generation-port已删除，旧“只是外部端口，没有流式业务生产调用”结论不再适用于本候选。

测试也有实质增强：`tests/anki-generation-service.test.ts:92-114`只替配置/模型传输；`:175-214`喂分段delta后断言真实库卡片/任务状态及事件，`:216-235`验证错误卡，`:260-284`调用真实critic并断言传输请求与摘要；命令测试`:295-309`检查生成卡字段、真实请求正文/解密key，不再只回预置AnkiCard数组。认可这些测试对象与生产链一致的局部证据。

仍不满足严格等价：

1. **路由分支省略。** `generation-service.ts:356-389`明确只用旧单模型回退，`:931` 的critic `resolveAnkiRoleDecision`固定null。Rust `src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:952-990`先做Generator路由/主槽降级，critic原调用链也解析角色；存在代码和缺接口记录都不能许可静默省略。应接真实已发布模型能力或保持明确未完成，不把整个生成主体再推给L02。
2. **trigger校验顺序改动。** 候选 `enhanced-service.ts:864-876`把运行句柄/取消通道判断放到状态判断前；Rust `enhanced_anki_service.rs:704-719`先拒绝不在Pending/Failed/Truncated/Cancelled的状态，再判重入。Processing且有运行句柄时返回错误从“任务状态不是待处理”变为“任务正在处理中，请勿重复触发”。不能以“更精确”注释改变原错误分支顺序。
3. **ready/abort保障未齐，见A4。** 生产生成经过配置await后才注册controller（`generation-service.ts:463-467,533-534`）；调度仅ID Set，未提供Rust的ready_signal/独立可abort句柄。
4. **Context可替换性未齐。** `plugin-handlers-generation.ts:18,45-51`直接import具体regex单例，未消费ctx.nativeRegex；即使同Rust引擎，也不证明profile覆盖生效。此项保留在A2架构接线范围。

### A4：生命周期恢复与仍存的终止漏洞

命令 `plugin-handlers-cards.ts:243-247` 已await `deleteDocumentSessionLifecycle`；`enhanced-service.ts:174-202`按epoch失效、尝试取消、删除数据库、清registry/tracker排序，认可该修复。

然而 `runningTaskHandles` 实际是 `Set<string>`（`:153-154`），并非可终止异步工作的句柄；`abortRunningTask`只是 `cancelStreaming(taskId)`（`:161-162`）。底层 `streaming-anki.ts:886-887`无controller时直接返回且不报错，已存在controller只abort而不remove。Rust `streaming_anki_service.rs:3470-3476`会移除sender，找不到则Err；删除侧 `enhanced_anki_service.rs:914-922`再abort独立task handle。因此配置读取仍在await、controller尚未注册时，TS删除路径的取消可能no-op，ID从Set删掉并不终止该异步任务；这是可由正常“生成中删除”路径触发的静态缺陷，不是假设外部攻击。

新增测试 `tests/enhanced-anki-service.test.ts:303-345` 人为标Streaming并让替身cancel抛错，只断言epoch、cancel次数、删库和registry移除；没有实际进行中的生成Promise/controller，更没有断言abort生效。它能验证编排顺序，不能证明Rust的真正终止保证。ready/cancel测试亦需走真实运行任务；本轮未执行复现。

### A5：七个提供面真实化，非仅类型声明

`api.ts`公开七面，`src/service.ts:51-74`构造实际适配器；`chatanki-service-adapters.ts:70-115`读写本lane卡/任务仓储，`:124-147`委托F4 settings和偏好实现，`:197-253`委托L04 chatSession及真实APKG导入器，`:263-290`提供文件/blob读取。`repository/chatanki-surface.ts:210-315,322-405`包含immediate事务、ownership、内容/review版本CAS的实际实现。

测试 `tests/anki-chatanki-service-surface.test.ts:170-184`从真实Host取ctx.anki并装真实chat/vfs；`:220-338`验证真实库读取、插入、CAS冲突、重模板、物理删除与FSRS行清理，`:387-467`操作真实L04块，`:470-575`走真实APKG文件/SQLite及blob。认可A5提供面和测试对象修复，不再笼统称cards/documents/APKG字段不存在。`:206-217`的类型兼容/对象存在断言本身不足，实质证据来自后续操作。

边界：没有安装完整真实L24工具链来证明所有消费者；且新session delete仍直接写FSRS（`repository/chatanki-surface.ts:348-378`）。这不是A5“未提供”旧问题，而是**A3仍未解决**。L15所有者事务接口、L24新服务名已有候选，阻塞应准确写“待集成/消费”，不能重复请求不存在的接口。

### A6：V8错误不是reqwest/serde Display

已修子项：结果数组元素的额外 `while parsing ...` 被删（`src/anki-connect.ts:36-46`）；固定行1列1不再硬编码。

仍有问题：`:53-60`直接透传JSON.parse错误，`:199-202`把V8消息放入前端可见字符串；Rust `src-tauri/crates/dstu-anki/src/anki_connect_service.rs:458-471`走 `response.json::<AnkiConnectResponse>()` 并格式化reqwest错误，合法JSON内的结果类型校验则是独立serde_json::from_value错误（`:463-465`）。V8的 `Unexpected token` / `not valid JSON` 不是两种Rust错误的等价文案协议，不能只检查位置包含column14就签收。

候选测试 `tests/anki-connect.test.ts:40-53`恰好接受上述V8消息/位置子串，而非原Rust精确错误；`:56-66`仅能证明数组元素错误附加文案已修。要求恢复按Rust阶段区分的错误形状/Display，不建议新增另一套猜测式JSON解析器；需要明确原错误对应值与真实命令断言。**A6保留开放。**

### 结论

A1/A2的生成主体、A4生命周期编排、A5七面均有实质进展；A2路由/ready/Context、A4真实abort、A6错误文本及A3单写者仍未闭合。保留所有验收勾选，四lane整体结论不变。旧测试exit0不覆盖新树，最新全目录RPC exit1按证据保留，未将RPC归因业务断言。无本轮运行、无作业号，Windows/macOS/Electron未验证。

## C1 07:56轮：`18c563a46` L15组合、真实abort与响应解码

### 基线与提供方作业

本轮审读HEAD=`1488f09fa`；检查时main=`0409f4c8f`。`18c563a46`、L15合并提交 `0857832cf`、`d6ed4f24d`均非HEAD/main祖先。候选在自己的分支已组合L15，**不等于main已消费**；未摘实现、未开混合worktree、未独立运行候选或重跑728条。下述TS行号统一指 `18c563a46:host/plugins/anki/`。

本轮亲自用job result读取了已完成的**提供方**作业（不是R5新提交/独立实跑）：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104074154-acbb9c
Test Files  36 passed (36)
Tests       728 passed | 1 skipped (729)
Duration    153.62s
[作业 20261104074154-acbb9c] npx vitest run -c vitest.host.config.ts host/plugins/anki --pool=threads --maxWorkers=1 --hookTimeout=120000
[作业 20261104074154-acbb9c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074154-acbb9c.log

node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104074725-5481ad
[作业 20261104074725-5481ad] npx tsc -p tsconfig.host.json --noEmit --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104074725-5481ad] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074725-5481ad.log
```

与C1核验一致：本次提供方结果无Errors失败段，只有WASI ExperimentalWarning；唯一skip仍为外部APKG环境未设置。它补充了较早719pass/RPC exit1之后的新运行记录，但不替代独立集成验收。本轮R5无新测试作业，跨平台/Electron未验证。

### A2/A4：旧Set/no-op缺陷已改，核实真实命令删除配置等待窗口

- `enhanced-service.ts:162-220`改成Map保存独立AbortController与ready Promise，trigger在spawn前注册（`:957-964`）；普通调度也在调用生成前注册并传signal/markReady（`:639-656`）。abort删除Map项并真正触发运行signal，不再只是删ID或重复cancel。
- `streaming-anki-cancel.ts:25-31`恢复Rust的“缺通道报错；有通道先移除再abort”，删除侧缺通道进入独立运行handle abort。`registerCancellation:50-64`把runSignal联到流controller；生成配置调用前后及注册流前检查signal（`generation-service.ts:531-544,606-611`），并回执onReady。
- `tests/anki-generation-commands.test.ts:656-695`是真实start/delete命令：只在LLM配置边界挂gate，等真实任务Processing后删除，释放gate并检查没有singleShot调用/任务行。不是旧“假标Streaming+只数cancel次数”证据；认可**配置成功返回**路径被终止的修复。
- `enhanced-service.ts:925-940`已恢复Rust先状态再运行句柄校验；测试 `tests/enhanced-anki-service.test.ts:311-348`同时锁住Processing错误与Pending运行中错误。`b36cefb22`不是这项校验修改，不能混淆提交归属。
- Generator/Critic路由已消费L02 api，nativeRegex从ctx获取，不再重复旧“固定null/具体import”的判断（`generation-service.ts:390-436,1006-1022`，`plugin-handlers-generation.ts:45-63`）。

**A4仍存的可达错误路径**：配置await若在删除/暂停abort后 **reject**，`:539-541`直接handleTaskError，直到成功路径`:544`才检查runSignal。删除后会尝试写失败状态并发TaskProcessingError（`:1173-1200`），暂停后还可能把Paused覆盖为Failed；Rust `enhanced_anki_service.rs:914-922` 的JoinHandle abort不会在配置future恢复后继续该分支。新增gate用例只resolve配置（测试`:155-157,658-660,685`），没有覆盖reject。应保留这一剩余分支，不把正常路径修复撤回，也不把局部signal等价成全部Drop/abort语义。

ready Promise已创建并回执，但生产代码没有等待 `handle.ready`；本轮只认可“可用回执/独立signal”的事实，不凭变量名认定完整就绪/取消调度保证。测试在Map删除后等待 `!has`，不等同等待原生成Promise全部settle，尚需对应的失败分支证据。

### A3：真实所有者同事务调用已形成，不再是fallback SQL

- `src/fsrs-owner.ts:19-25`直接Pick L15公开ReviewService四方法，`:43-50`缺失时显式失败；`tests/env.ts:40-48`默认装真实review，候选已删fsrs-owner-double。生产src/repository的 `INSERT/UPDATE/DELETE ... fsrs_` 文本检索零匹配；逐段diff亦确认原写SQL已移除。
- 普通删除：`repository/anki-cards.ts:225-263`同一 `db.transaction(tx)` 先传tx调用cleanup*，再删本lane卡/任务；不拆为独立commit。session/library CAS删除也把当前tx传owner，不再写FSRS。
- APKG：`src/apkg-import-persist.ts:136-202`创建task/card与 `fsrsOwner.enqueueImportedCardsInTx(tx, reviewSeeds)`共享一个事务，异常出闭包，模板导入仍在提交后（`:208-209`）；提供方 `Review`→其仓储用传入conn的路径已由前轮静态核实。
- 真实成功/幂等证据：`tests/apkg-importer.test.ts:131-135`绑定 `env.host.ctx.review`；`:1719-1814`真实APKG导入5张含历史/挂起状态并复查FSRS及重复入队。缺owner测试`:1817-1835`让卡/任务插入后失败，断言整批回滚；`:1273-1295`用真实数据库trigger使第二卡失败并断言全回滚。
- 删除测试 `tests/anki-db.test.ts:266-318`真实命令验证卡/任务/文档清理；L15同事务服务回滚测试仍是原review测试，不冒充新增的真实L16失败路径。当前成功、APKG插卡失败、缺owner回滚证据有效，但还未测试“真实owner部分写入后故障”及全部删除失败矩阵，不能把零匹配视为全部事务语义证明。

**原锁模式还须保持**：普通三种删除现在统一 `{behavior:'immediate'}`（`repository/anki-cards.ts:233,245,260`）；Rust `dstu-storage/src/database/mod.rs:6055,6072,6097`使用默认deferred `conn.transaction()`。单次事务边界恢复不授权改变锁获取模式，需按原方法区分普通删除与原本immediate的CAS/APKG路径。故A3不自动全项勾选，但不再称候选仍复制FSRS写入。

### A5/夹具修正：公开导入与Rust rename_all核实

`tests/anki-ai-native-chatanki-integration.test.ts:14-48`只从L24 `api.ts`导入；对本lane检索未见L24私有src/repository导入。该文件仍有自己的NativeRegexDouble（`:50`起），因此“公开导入边界修好”不等于这些纯函数/regex测试都证明生产引擎等价。

`b36cefb22`实际只修改 `tests/library-query.test.ts` 的snapshotJson：snake_case改camelCase。已对读Rust `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs:857-883` 的 `#[serde(rename_all = "camelCase")] struct FsrsStateBeforeSnapshot`，其snapshotVersion/cardStateId/ankiCardId/deckId/elapsedDays等应为camelCase；**这次夹具修正符合原存储序列化契约**，不是为了变绿反转断言。不据此签收其他测试或L24完整消费者链。

### A6：实际两条响应解码路径仍有最小可达差异

依据：Rust `src-tauri/crates/dstu-anki/src/anki_connect_service.rs:112-116` 为直接派生Deserialize的 `AnkiConnectResponse { result: Option<Value>, error: Option<String> }`。版本探测 `:371-408`先text再 `serde_json::from_str`；牌组 `:458-471`先 `response.json::<AnkiConnectResponse>()`，成功后再 `from_value::<Vec<String>>`。候选统一走 `src/anki-connect.ts:54-76` 的“全文语法扫描→JSON.parse→手写typed检查”，不能视为同一反序列化流程。

| 最小响应/场景（均为静态推导，本轮未执行候选） | Rust与候选差异及源码证据 |
|---|---|
| version响应体 `{` | Rust from_str错误直接拼入“解析AnkiConnect响应失败…响应内容”；候选parseResponse对所有SerdeJsonError加 `error decoding response body:`（`:62-63`），version caller又拼该文本（`:165-169`）。把仅牌组等response.json路径的reqwest前缀误加到version路径。 |
| deckNames响应 `{"result":[],"error":1}` | Rust typed错误发生在response.json，应带reqwest Decode包装及serde位置；候选语法通过后`:73-74`抛未包装/无位置的invalid type。只给syntax errors加前缀不能覆盖typed decode。 |
| `{"error":1,"result":[}` | Rust先遇到error的整数→Option<String>类型错误；候选先扫描整个JSON，在后面的非法数组报syntax。错误优先顺序改变（`serde-json.ts:88-108,142-145`）。 |
| `{"result":["A"],"result":["B"],"error":null}` | Rust派生struct拒绝重复result字段；候选扫描器未记录成员、JSON.parse保留末值，最后返回B。相同JSON语法不等于相同typed struct行为。 |
| version响应 `{"result":5.0,"error":null}` | Rust Value.as_u64对float词法不返回整数，走warn后放行（`:384-401`）；候选JSON.parse变number5，Number.isInteger为true，报版本过旧（`:172-175`）。不是仅错误措辞差异。 |
| deckNames响应 `{"result":[9007199254740993],"error":null}` | Rust保留数值后from_value报告精确整数；候选JSON.parse先舍入到9007199254740992，serdeDescription再拼错误整数（`:25-31`）。`dstu-anki/Cargo.toml:37`还显式启用arbitrary_precision，不能擅以JS范围替换或拒绝合法数字。 |
| deckNames UTF-8 body在result字符串内含非法字节，例如 `{"result":["` + FF + `"],"error":null}` | Rust response.json按原响应字节typed decode拒绝非法UTF-8；候选先 `response.text()`（`:122-129`）替换为U+FFFD，再Buffer.from(text)扫描（`serde-json.ts:19`），原字节/位置已不可恢复，可能成功返回替换字符。version的Rust本身走text，必须分路径，不可将这一规则统一套用。 |

合法UTF-8语法错误的扫描器确实按Buffer字节计列（`serde-json.ts:19-28`），认可其意图；但typed错误在解析后失去span，例如含中文前文的error字段类型错不会带原字节位置，不能据两条ASCII语法断言签UTF-8/typed全覆盖。递归扫描只辨语法，最后JSON.parse仍丢数字词法/重复成员；本轮没有编译/运行Rust，也没有为其另造JSON框架。

整改应限于原AnkiConnect响应契约与两条Rust解码调用的语义：保留错误先后、包装、位置与数值表示，补相同输入对应的原断言；不要再以“更像serde”的通用扫描器或两条精确字符串测试推导全部等价。**A6仍开放。**

### 本轮结论

认可A2路由/Context/trigger、A3真实owner同事务和A4配置正常返回的abort修复；确认b36cefb22夹具camelCase正确。保留A4配置失败时取消副作用、A3原锁模式及A6上述解码差异；所有验收勾选不变。提供方728pass/1skip、类型检查exit0按实际结果更新，不继承为独立实跑或main消费。L14 Q2/Q5和已完成enqueue作业均未重做；跨平台/Electron未验证。

## 后继候选 `b81395fe7` / `6d0b01b7c` 新差异复核

审读工作树为正常main合并后的`add36c913`加审计文档；检查两个候选及`18c563a46`对HEAD/main祖先关系均exit1。只读git对象，未搭组合或运行候选内存副本。`b81395fe7`自身只改anki-cards，config catch及document-processing修复由前序检查点`90f6b4efb`带入；parser由`ecc6ee301`带入`6d0b01b7c`。按候选完整树核对，未根据提交说明误认每一hunk归属。

### 认可的修复

1. **A3**：普通三种删除去掉immediate；候选`repository/anki-cards.ts:225-263`、`repository/document-processing.ts:121-134`仍共享tx调用真实L15 owner。平台`host/platform/storage/database.ts:408-410`默认deferred，符合Rust `dstu-storage/src/database/mod.rs:6055/6072/6097`。原锁模式反例已修；CAS/APKG本来immediate，不需一并改成deferred。
2. **A4**：候选`src/generation-service.ts:537-547`在config catch内先`if(signalAborted(runSignal)) return`。`tests/anki-generation-commands.test.ts:697-738`真实命令删除期间reject配置，断言无TaskProcessingError、无LLM调用/任务行、运行handle释放。此反例已修；源码也覆盖pause使用同signal的路径，测试实际执行的是delete，不冒充pause实测。
3. **A6已修子项**：`src/anki-connect.ts:28-48,168-178,199-211`按调用路径分别包装；`src/serde-json.ts:185-216`在字段顺序中检查error类型及重复字段，`:42-47`保留u64词法，byte parser避免先text替换非法UTF8。之前七个具体反例中的version前缀、error-before-syntax、duplicate result、version5.0、大整数类型文案及UTF8模式区分均有对应修复/新测试；提供方14条通过，不再写“先全文扫描后JSON.parse”的旧判断。
4. L11公共API复用认可；候选文档明确承认resources.deleted_at不可见仍是实际过滤缺口，不再把它描述成等价完成。该缺口与A6响应解码无关，保留消费者集成限制。

### A6仍未闭合的新可达反例（静态审读，未运行Rust）

| 输入/分支 | Rust原行为 | 候选`6d0b01b7c`行为 |
|---|---|---|
| deckNames返回`{"result":null,"error":null}` | `AnkiConnectResponse.result:Option<Value>`（`anki_connect_service.rs:112-116`）解成None；`:462-468`报 **AnkiConnect返回空结果** | parser`:196-197`直接把value()的`{kind:'null'}`存入result；`anki-connect.ts:207`仅比较JS null未命中，`:209-211`最终报 **解析牌组列表失败: invalid type: null, expected a sequence**。这是合法空结果响应，不是非法输入加固。 |
| 同一null结果用于version | Rust`:398-399`日志显示`None` | 候选debugJsonNode显示`Some(Null)`；同属Option-null丢失，不另增finding。 |
| 已收到HTTP响应，消费body时连接中断/读取reject | version在Rust`:371-374`返回“读取响应内容失败”；deck在`:458-471`属于response.json解码错误，走“解析AnkiConnect响应失败” | `postAnkiWithStatus:128-137`在返回status前await arrayBuffer；调用方version`:156-165`和deck`:194-198`把这个reject当发送请求失败，走连接/请求失败前缀。拆了JSON parser仍未保留send→body→decode的错误阶段。 |

因此A6仍开放；修复限定于响应契约的Option及阶段传播，不要求再造通用JSON系统。此轮不以未核实的浮点格式猜测追加硬finding，也不将旧反例重新派回。

### 提供方作业（本轮已取result，非R5独立运行）

| 作业 | 实际命令/结果 |
|---|---|
| `20261104085943-d7822b` | `npx tsc -p tsconfig.host.json --noEmit --incremental --tsBuildInfoFile .lane.tsbuildinfo`，exit0 |
| `20261104085943-f88dce` | `npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-generation-commands.test.ts host/plugins/anki/tests/anki-db.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，2 files/36 pass、exit0，无Errors/Unhandled |
| `20261104090738-901599` | 同tsc命令，exit0 |
| `20261104090738-ac233d` | `npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/anki-connect.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，1 file/14 pass、exit0，无Errors/Unhandled |

日志均位于`/home/dsdev/.oc-jobs/done/<ID>.log`，运行目录显示L16-anki。本轮没有重复728条提供方suite或enqueue测试。当前main独立三目录作业`20261104105734-f5cb83`是1200pass/13skip/Errors1/exit1；新main六目录门禁`20261104112238-eb7e77`另已提交。最新外部门禁通知的streaming hook timeout发生于默认10秒钩子，当前`tests/streaming-anki.test.ts:93-97`在beforeAll内建真实迁移环境而未单设timeout；具体耗时归因仍需完整job结果，不能以提供方120秒hook配置推定默认门禁已经通过。

### §5统一自检的独立失败证据

基线`9299fa83e`的统一lane-gate返回1/4项失败，typecheck/boundaries/importable均exit0。测试job **20261104120822-dcf771**，原命令为六目录Vitest、无worker/hookTimeout覆盖：**1 file failed/192 passed/2 skipped，1874 passed/109 skipped，Errors4，exit1，1233.60s**。完整日志`/home/dsdev/.oc-jobs/done/20261104120822-dcf771.log`明确指向本目录`streaming-anki.test.ts:93` beforeAll内createAnkiTestEnv，`Hook timed out in 10000ms`；另外4个Unhandled Error为RPC onTaskUpdate超时。定位为测试初始化/运行阻塞，不直接当业务生成断言失败，也不能把94条未执行用例算通过。未改超时/断言，未以提供方更宽hook参数替换当前门禁结论。

## C1后继 `1e9f3a999`：只核新增A6与X7输入解码

当前独立工作树为`4d2054c6f`及审计增量；`1e9f3a999`、`9de6ab07b`、`1e2356b29`、`3726cd69f`、`bdc3861c8`对检查时HEAD/main均非祖先。`95d567a50`已为HEAD/main祖先，不再重做旧服务键测试或要求兼容旧名。

### A6两项后继修复认可

- **result:null**：候选`src/serde-json.ts:195-198`把null节点映射成JS null，符合Rust `anki_connect_service.rs:112-116`的Option<Value>；`anki-connect.ts:253-254`进入“AnkiConnect返回空结果”，版本日志也走None而非Some(Null)。该修改在`3726cd69f`，不是报告提交才出现。
- **body读取阶段**：候选`anki-connect.ts:148-169`的post只取得response，body()延迟消费并返回Body类别错误；version`:204-217`分别处理非2xx读体失败的“无法读取错误内容”和成功响应体的“读取响应内容失败”；deck`:246-251`先判status，非2xx不读body，2xx读体失败归解析响应阶段。对齐Rust`:371-418,458-477`原阶段分流。代码实际由`997d629a8`保存；`bdc3861c8`是新增测试，不能把它当body实现提交。
- **测试范围**：`tests/anki-connect-response-stages.test.ts`9条经真实Host invoke，覆盖两个deck别名、model、version None日志、version/deck body失败及非2xx分支。fetch/port是外部边界替身，Response使用真实失败ReadableStream；这能验证阶段和外层载荷，不能证明真实undici source与hyper source文字逐字一致。A6旧两残差不再派回，main整项签收仍待集成及最小独立验证。

### X7-L16-SERDE-front/tags/extra_fields：直接decoder与IPC分开

`1e2356b29:src/anki-cards.ts`按 `dstu-core/src/models.rs:1380-1412`逐字段检查String/bool/Vec<String>/Map<String,String>：缺失才default，Option显式null有效，非Option显式null/错类型报错，未知字段忽略。`decodeCardArg`保留invalid args包装，并在update/export调用写库/写文件前执行。`9de6ab07b`为测试检查点，实际decoder改动在`1e2356b29`，`1e9f3a999`自身仅报告及hook预算调整。

`tests/anki-card-input-serde.test.ts`直接调用生产decoder的17类错值、default/Option/键顺序/未知字段断言，是修复旧宽松helper的证据；Host invoke三类错值拒绝且原数据库内容不变、导出不写文件，是入口边界证据。C1已核原IPC契约此前就会挡front=3、tags=[3]、extra_fields.key=3；本轮不把direct-decoder反例扩写成“旧IPC全部可panic/可写坏数据”，也不把invoke拒绝单独当成新decoder必然被执行的证明。

### 提供方result（本轮已读取，未独立重跑）

| 作业 | 命令范围与实际结果 |
|---|---|
| `20261104114623-b34c09` | Vitest：anki-card-input-serde、anki-db、enhanced-anki-service、gold-provenance-excludes-critic、anki-new-wiring、templates六文件；`--pool=threads --maxWorkers=1 --hookTimeout=120000`；**6 files/80 passed/exit0**，无Errors/Unhandled |
| `20261104120323-27bc51` | 命令传response-stages、anki-connect、command-logs、connect-service、serde-json五个路径，实际收集**4 files/50 passed/exit0**（14+9+21+6），无Errors/Unhandled；同threads/worker/hook flags |

日志均为`/home/dsdev/.oc-jobs/done/<ID>.log`，运行目录L16-anki；不是R5 main结果。新增response-stages文件9条不等于整个job9条。`1e9f3a999`把streaming beforeAll/afterAll与media beforeEach/afterEach改120秒，断言未改；只扩大初始化/清理预算，不证明生成业务等价或消除RPC根因。现有R5统一自检`sh_1a691f904001C137jct5SYLM2T`保持，未提交新的测试作业。

### 后续独立自检结果（tip 4d2054c6f）

作业`20261104123907-c1d800`已返回：六目录 **193 files passed/2 skipped，1968 passed/15 skipped，Errors1，exit1，769.53s**。本目录streaming文件94条通过/4889ms，本次未出现10秒hook失败；唯一未处理错误为Vitest RPC onTaskUpdate超时。120秒hook候选未集成，不把本次通过归功于该调整。整体自检仍失败，原hook失败及候选语义限制均保留历史与适用范围；仅补录结果，不重复运行。

### X7 cloze后继5e05f9bc0 / 4194d8827静态复核

检查时两SHA对HEAD/main均非祖先。`5e05f9bc0`包含实际trim代码及新9例；`4194d8827`本身只改LANE报告。独立核对F4 `util/text.ts:9-22,26-41`包含U+0085、不含U+FEFF，因此validateSpec的imageRef/label两处原反例已修。候选顺带对齐buildCardFields图片名/Extra及occlusionImageRefFromFields的Rust trim位置，分别对应Rust `anki_image_occlusion.rs:456-475,503-512`。其它VLM解析/草稿basename的trim不在本次两个ID签收范围，不能称整个文件已无字符串差异。

新`image-occlusion-rust-trim.test.ts`9例使用真实生产helper：NEL空引用、BOM反向保留、引用周围NEL、默认区域label、BOM label、图片名/Extra两向及AnkiConnect `rebuildOcclusionClozeText`、extra_fields引用解析；`anki-sync.ts:367-374`真实rebuild直接调用validateSpec/buildCardFields。这里只审代码与断言，未运行候选/Rust。

C1亲取提供方 **`20261104143330-c19e5e`：3files/62pass/exit0（新9例在内）**、**`20261104143547-0d045c`：785pass/1skip/exit0**；本轮未重新取result或重跑。共享ledger dirty前置未动、未运行gate按C1/owner说明如实记录，不伪造selfgate通过。质量拆分保留旧导入路径是组织层证据，不替代A3/A4/A6及其它语义签收。两X7项待正常main后的最小复验，R7/C3的D3同根问题不受这些trim测试绿灯影响。

### L16 D3删除/快照候选a47f42ded：数值链认可，联合接线仍待

`a47f42ded`仅LANE报告，实际实现/测试在`bcb3f2b61`、`c34dfbe14`；三者检查时非HEAD/main。本轮独立静态核对：

- `src/library.ts`的AgentReviewStateSnapshot.reviewVersion为bigint；仓储SELECT local_version为TEXT并读取typeof，非INTEGER仍报错，合法有符号i64读成BigInt，不经Number。
- expectedReviewVersionI64接受number|bigint|null，null保留“未入队”的断言，非null归一bigint并检查非负/i64MAX；library/session比较采用精确值，不新增MAX_SAFE拒绝。对应Rust `database/mod.rs:5722-5745,5887-5928`的Option<i64>/非负检查与双CAS。
- `repository/anki-library.ts:40-55`、`chatanki-surface.ts:338-358`继续在同tx内读版本、比较并调用L15 cleanup，原卡删除SQL/事务模式未被该差异改变。这里只确认此次精度修复及连接传递，不把静态同tx当所有失败回滚矩阵已独立实测。
- 公共api、service、cards签名同步为number|bigint|null；library command保留owner快照内部bigint，最外kernel转换wire。

已取**提供方**job `20261104151313-17fc61`：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/review-version-i64.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，1file/5pass/exit0，无Errors/Unhandled段。其中4例验证真实L16服务/SQL：library/session邻值Conflict、精确token删除、MAX/越界、number大值、signed MIN冲突快照；**第五例**list wire显式withReview:false并provide getReviewStatesForLibrary快照，验证真实L16命令/kernel输出number及输入snapshot未变，**不是L15真实owner联合读取**。

已取typecheck `20261104150842-c6c169`：`npm run typecheck:host`，exit2，唯一诊断`anki-chatanki-service-surface.test.ts(210,7): TS2322 Type 'boolean' is not assignable to type 'never'`。`:87-95`的L24SurfaceCompatibility仍在，指出与L24旧number服务协议不兼容；保留这条断言，不能删掉或用强转冒绿。该tsc失败与共享ledger dirty导致gate前置exit2是不同原因，分别记录。旧24条文件通过仅来自交付说明，本轮未取其result。

L24 `de19f72a0`补回输出bigint/wire断言的进展在C3报告；其api:173/234/507/510仍number，需与L15/L16同批对齐。候选全未main，本轮未跑旧组合或全suite。正常main后只核原R7/C3公开服务链、返回值/wire及同事务删除必要场景，A3/A5整项不提前勾选。

### b789b9954接口兼容补证：不是正式typecheck或provider运行

后继L24 `6962cbfed`（部分代码e8b2046c1）已将内部API/六个decoder对齐bigint；“L24仍number”仅是de19快照，不套到后继。已取提供方`20261104153009-ff06f8`：L16输入`1df97b515`，读取原测试并抽出原七项L24SurfaceCompatibility，compiler host仅在内存读取6962的api.ts，noEmit，**diagnostics0/exit0**；argv中未写文件，未执行provider。b789b9954只是报告且非main。

该证据保留原兼容保证，认可两候选接口可兼容；**不覆盖**正式`20261104150842-c6c169` exit2，亦不代表正常main typecheck或真实L15+L16+L24联合通过。L24自己的正式`20261104152119-87836d`也exit2于旧L16树同一断言，两份历史失败分别保留。L16 list wire注入快照的限制保持；没有因候选类型绿灯关闭A3/A5/R7/C3或重跑旧测试。

### 474e38f29本地anki_decks owner接缝（与i64 CAS分开）

检查时非HEAD/main。`api.ts`直接reexport生产`repository/fsrs-decks.ts`的两个同步函数ensureDefaultFsrsDeckWithConn/writeFsrsDeckConfigWithConn，**不是等待ctx.anki新增异步服务方法**。实现只调用传入conn.run，不取新连接、不自开事务、不改写JSON文本；owner不包装错误，由L15原边界加一次Database上下文。

逐SQL对照Rust `fsrs_review_service.rs:1346-1352,3634-3644,3680-3690`：默认INSERT OR IGNORE不重置现有/墓碑行；config UPDATE只写deleted_at IS NULL行，同内容也递增COALESCE(local_version,0)，caller now与configJson原文直接绑定，missing row不新增拒绝。静态认可这些提供方语义，不签L15消费者已迁移。

已取**提供方**`20261104155443-cf2669`：`npx vitest run -c vitest.host.config.ts host/plugins/anki/tests/fsrs-decks-owner.test.ts --pool=threads --maxWorkers=1 --hookTimeout=120000`，**1file/4pass/exit0，无Errors/Unhandled段**。通过公开api、真实迁移库验证默认值/墓碑、JSON字节与同内容增版本、caller immediate事务回滚、trigger原始StorageError；fixture withReview:false，因此不能据此证明L15包装及实际业务同tx消费。

L15已按C1接收消费请求；后续正常main只核两写点传原conn/tx和原错误前缀，不能以此前3例基线通过声称review SQL已消除。该SW事项不与a0515的fsrs_card_states版本CAS合并签收，dirty前置及旧L24:210类型检查exit2继续分列。无新测试或自检。

### B2候选1a21bc98a / 8c2c4fb73：live关联与raw alias分阶段

实际代码/测试在1a21bc98a，8c2c4fb73只更新说明；检查时均非HEAD/main。`repository/chatanki-vfs.ts:44-50`对file_/att_/tb_关联资源改用L11 getLiveResource，文件自身仍getFile核存活；对齐Rust `chatanki_executor.rs:10642-10668`。外层res_元数据`:112`继续getResource，允许其source_id重定向到另一个live文件，符合Rust`:10570-10579`，不能机械改成所有res_墓碑都拒绝。

关联资源查file先用公开attachments.resolveFileId，再经getFile确认live且resourceId相等（`:75-86`）；该候选L11 resolver确实优先资源ID匹配并按live优先，再做宽泛source回退，因此后置校验收窄为Rust `:10535-10546`要求的存活关联file。`:124-133`区分“没找到关联file→mapping error”和“找到file但最终live resource不可用→null”，保留Rust`:10615-10622`两阶段。

已读提供方job `20261104155245-9f5dbc`元数据/摘要：服务面文件按apkgVfs标题过滤，**1pass/9 filtered skip/exit0**，不算10条都执行。断言涵盖resource/file墓碑及恢复、NULL resource_id缺hash、软删res_ alias仍指向live文件、blob读取；静态认可B2具体缺口修复，正常main后只核原B2最小场景。LP0059八warn的提供方静态对应不等于八分支动态覆盖，本轮也不签D3联合。

### SW deck状态更正：consumer已撤回，owner-first仍待正常集成

`77c4bef2a`确曾把L15两写SQL改调474e38f29公开函数，原conn/tx、JSON.stringify位置和try/catch原前缀保留；但L15当前交接HEAD`84f328310`已显式revert77，恢复两写点，避免owner尚未main的缺导出依赖阻塞D3。不能仅按77在历史中存在就宣称当前consumer已接。L15已parked，不追加派工；按C2已收顺序先正常集成owner，再重应用consumer，SW仍开放。

提供方临时真实组合树`/tmp/opencode/l15-deck-owner-77c4bef2a` HEAD`5b728ccee`的父提交确为77与474；本轮只读状态clean，未创建/切换/执行该树。已取`20261104160521-9ce58d`：deck-owner-transaction3＋service-transaction-api3＋fsrs-decks-owner4，**3files/10pass/exit0，无Errors/Unhandled段**；`20261104160521-4c059f`正式tsc **exit2**，唯一旧L24SurfaceCompatibility:210 TS2322。组合结果不签正常main、不抹掉正式缺导出失败，也不覆盖旧D3联合验证限制。

### LP0061实际27b0712e8：日志与提交后best-effort范围

检查时27b0712e8/b2089e4e6均非HEAD/main。前者为代码/测试，后者仅LANE。`src/apkg-import-persist.ts:46-91`传入runtime.logger并在原模板create catch先warn `APKG 模板导入失败 <id> (<name>): <error>`，随后仍追加原结构化warning，匹配Rust `apkg_importer_service.rs:2588-2598`；调用位于`:211-212`，卡片事务`:205`已成功返回，模板错误不得撤销卡片。

新`apkg-importer.test.ts`经真实ctx.anki.apkgImporter.importBytes＋模板INSERT trigger，验证两条warn完整顺序：第一条是既有内部协议字段剥离warn（Rust`:2250-2253`），第二条才是本次补齐的模板id/name/error warn；同时检查report warning、1张卡保留、伪造_original_generation被剥离、模板未创建。没有把第一条已有warn称为新补实现，也不将两条动态观察扩成LP0059八分支或全部日志。

已读提供方metadata/log：`20261104161439-95b72a` **1fail/50标题过滤skip/exit1**，明确缺第二warn；`20261104161712-ea46c6` **2pass/49标题过滤skip/exit0，无Errors/Unhandled段**，包含新负向及原deep_student_template_metadata_recreates_missing_local_template成功/幂等用例。命令均为apkg-importer文件的`-t`定向，threads/maxWorkers1/hookTimeout120000，完整argv在同名.done.json。不是51条全执行，更不是APKG/785全量复验。候选正式gate未绿/shared ledger前置未变按交付保留；正常main后只复验该LP子项，本轮不重跑。

### X7三个AnkiCard decoder子项独立main复验闭合

已读X7工作树产物`fixtures/differential/recheck-L16-decoder.json`及生成脚本；该报告是作业生成文件，不存在于作业启动tip c9a9e1371本身，不能伪称它已包含在该提交。已取**独立X7** job `20261104163838-b3c3ab`，cwd X7-differential，命令`node scripts/electron-migration/record/recheck-l16-decoder.mjs`，exit0。报告tsRevision=`c9a9e1371`，该树正常merge main `fd925aa05`；祖先核实1e2356b29已进入该main，且所测decoder/相关入口文件在c9与fd925间无diff。

脚本从原static-findings选择恰好三ID，对原input structuredClone后直接调用生产decodeAnkiCardInput；固定id/created_at/updated_at，意外默认值调用会抛错。catch只接受instanceof AnkiCardDecodeError，其它异常重抛，因此不是“任意异常都算通过”。front=3、tags=[3]、extra_fields.key=3均得到`invalid type: number, expected a string`，status为matches-static-rejection。没有将原数字换成字符串；脚本仅写新的recheck报告，原static-findings历史actual不覆盖。

据Rust `dstu-core/src/models.rs:1380-1411`对应String/Vec<String>/HashMap<String,String>及上述独立main生产调用证据，三个正式X7 ID窄范围签收。报告kind明确`static-source-plus-production-recheck-not-C`，R5未亲跑该作业/未运行Rust；不计C级、不推断IPC可绕过或完整serde行列/错误wire等价。cloze5e05f9bc0仍非该main/当前main祖先，两trim项及A6/其它未决不随之关闭。

### LP0060 e9c2b05a1/5c1559b10窄差异复核

两代码SHA及报告54f513a66检查时非HEAD/main。生产plugin.ts及plugin-handlers-export.ts两exportRuntime都传ctx.logger；字段解析缺字段仍返回空串，先加原warn（Rust apkg_exporter_service.rs:948）；媒体收集在无文件名/同名冲突/超限/读取失败原分支加对应warn（:1737/1747/1764/1772），报告missing/warnings行为保持。single原丢report命令改用同义wrapper，在成功报告后记录缺媒体汇总（:1856），不是给所有report路径重复加汇总。

cleanupTempDir捕获删除错误：single finally记录原warn，multi-report静默忽略，均不替代已经产生的成功或主导出错误，匹配Rust:2059-2066及2379-2383。multi丢report wrapper的:2084汇总目前仅找到测试caller；生产同名command走report路径，不为补计数把第8项硬塞进生产，保留待裁定/未决。

真实Host命令测试覆盖精确warn顺序/字段、缺字段导出collection仍空、multi-report不额外汇总，single/multi清理失败分别保成功及原主错误；日志观察为call-through spy，清理/写文件故障使用定点fs注入，算法与卡片导出路径未替换。5c1559b10修正新增fixture误把create_custom_template字符串返回值当{id}，保留原命令断言目标。

已读提供方receipt/log：164200-1f5273 **4fail/exit1**；164831-278785 **三文件50pass/1fail/exit1**，原exporter41+integration3只是子集，新增fixture错误不能抹成全绿；已取165312-0de9a1（完整ID均前缀20261104）**单文件7pass/exit0，无Errors/Unhandled段**。命令为apkg-export-command-logs.test.ts，threads/worker1/hook120000；未重跑APKG/785。正常main只核触及LP分支，不签整个日志组、f32/i64、类型旧:210或dirty前置；没有新作业。

## 1e80f32b4正常main独立复验结果

官方固定tip1e80f32b4/base5b1b19055四项全部通过；原测试job **20261104203909-c2516b**，四目录 **160files/1709pass/1skip/exit0，618.35s，无Errors/Unhandled**。唯一skip为外部APKG环境fixture（tests/apkg-importer.test.ts:1982），不是A5/大i64路径skip。原typecheck兼容断言保留并通过，A5 fixture先装真实vfsRepos/notes/vfsIndex后装vfs/chat，10例实际执行。

窄签收A3、A4、两正式X7 cloze trim、LP0061；A5七面及真实公开D3链、B2 live-resource分阶段与raw alias（服务面测试含该场景）均已独立执行认可，不再标为候选待运行。A6两后继反例9条通过但保留真实传输source文案范围；LP0060实际触及的字段/媒体日志及single/multi清理7条通过，未给第8个仅测试caller wrapper制造生产路径，整个LP不一概勾选。

本次L16 review-version-i645条中list wire仍注入快照，保留该测试边界；另有L24真实documents/cards→hydrate→L15 CAS4条与provider5条共同补强，不互相冒充。旧类型2、A5缺依赖、hook/RPC及临时组合记录均保留历史，当前main这些具体阻塞已解除。SW deck仅474 owner发布，review两写SQL仍在；整体业务不通过结论不因门禁全绿改变。
