# F7 原生适配器测试去向

F7 没有生成的测试归属表；下表记录引擎适配器直接承接的 Rust 用例，业务 lane 可将对应行
指向这些测试。ledger 尚不读取 F7（见 SPEC），因此这里不声明 ledger 百分比。
未移植项只在文末按“真实引擎缺失”列出，不计为已移植。
`dstu-learning/src/fsrs_scheduler.rs` 的权威归属是 L15
（`host/plugins/review/TESTMAP.md`）；本 lane 已删除重复调度实现与测试，不再记录该文件。

## `dstu-util/src/utils/token_budget.rs`

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `estimate_tokens_with_model_short_text_matches_exact_encoding` | L247 | ported:host/platform/native/tests/tokenizer.test.ts |
| `estimate_tokens_with_model_huge_repetitive_text_is_fast_and_reasonable` | L258 | ported:host/platform/native/tests/tokenizer.test.ts（原200K“数”、<5秒、100K..400K全部保留；Rust/WASM BPE实测约494ms） |
| `estimate_tokens_with_model_heterogeneous_text_does_not_average_away_dense_segments` | L279 | ported:host/platform/native/tests/tokenizer.test.ts（补回原20K英文+20K中文+20K英文及完整精确对照；旧8400字符例仅作为补充保留） |
| `estimate_tokens_with_model_varied_huge_text_extrapolates_close_to_exact` | L307 | ported:host/platform/native/tests/tokenizer.test.ts（原120K多样文本及ratio 0.8..1.25断言全部保留） |

## `fsrs = "=6.6.2"`（外部 crate，数值来源）

2026-11-05 同 crate WASI 引擎（`host/platform/native/tests/fsrs-optimizer.test.ts`，经 `ctx.nativeFsrs`，样本集为 crate 测试所用
`collection.anki21`，固定在 `tests/fixtures/fsrs/collection.anki21.zip`，convertor_tests.rs 仅测试用移植）：

| Rust 测试 | 去向 |
|---|---|
| `convertor_tests.rs::test_conversion_works` / `test_ordering_of_inputs_should_not_change` | ported（计数 24394/14290/63672、单卡展开、首项） |
| `inference.rs::tests::test_evaluate` | ported（三组 log_loss/rmse_bins，crate 容差 1e-4；universal_metrics 未发布，不移植） |
| `training.rs::tests::test_compute_parameters_with_card_ids_matches_without_card_ids` | ported |
| `training.rs::tests::test_disabled_short_term_compute_parameters_zeroes_short_term_parameters` | ported |
| `training.rs::tests::test_compute_parameters_rejects_mismatched_card_ids` / `rejects_invalid_items` | ported |
| `inference.rs::tests::test_next_states` | 另以 crate 本体为 oracle 再核对一次（crate 与 TS 移植均逐位等于期望） |
| L15 `optimize_parameters` 调用形状（card_ids、short-term、样本集全量、log_loss 改善） | 契约测试 |
| 同步 f32 移植对 crate 的偏差界限（样本集每 40 条，≤16 ulp，架构师裁定的已知偏差） | 契约测试 |


| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `fsrs-6.6.2/src/model.rs::tests::test_convert_parameters` | L631 | ported:host/platform/native/tests/fsrs.test.ts |
| `fsrs-6.6.2/src/model.rs::tests::test_power_forgetting_curve` | L647 | ported:host/platform/native/tests/fsrs.test.ts |
| `fsrs-6.6.2/src/inference.rs::tests::test_next_states` | L1484 | ported:host/platform/native/tests/fsrs.test.ts；另由 `fsrs-service.test.ts` 用 `@open-spaced-repetition/binding` 的 FSRS-6 实现交叉核对 |

`optimize` 没有可移植的 Rust 端到端期望向量：6.6.2 的 `training.rs` 只断言 Adam
单步/梯度中间值，公开的 `compute_parameters` 入口无法复现这些内部状态。binding 0.6.0
的优化器又与 6.6.2 的 Adam/L2 数学不同（见 SPEC），因此不注册、不声明 ported。

## `dstu-media/src/media/bilibili_transport/grpc.rs`

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `crates/dstu-media/src/media/bilibili_transport/grpc.rs::tests::rejects_truncation_missing_state_flags_and_bad_trailers` | L149 | ported:host/platform/native/tests/protobuf.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/grpc.rs::tests::parses_gzip_typed_tracks` | L166 | ported:host/platform/native/tests/protobuf.test.ts |

## `dstu-docs/src/document_parser.rs`（纯文本子集）

2026-11-04 `docx_handout.rs` 生成用例：`default_spec_renders_image_block`、
`broken_image_degrades_to_placeholder`、`handout_template_applies_official_layout`
→ ported:host/platform/native/tests/office-docx.test.ts（真实 `nativeOfficeWriter` provider）。
`decode_accepts_data_url_and_raw` / `fit_emu_scales_wide_images_to_content_width`
仍由L18拥有其对应纯函数测试，不在F7重复登记。

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_support` | L4187 | ported:host/platform/native/tests/office-text.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_with_unicode` | L4196 | ported:host/platform/native/tests/office-text.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_md_support` | L4205 | ported:host/platform/native/tests/office-text.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_gbk_decoding` | L4229 | ported:host/platform/native/tests/office-text.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_utf8_bom_decoding` | L4242 | ported:host/platform/native/tests/office-text.test.ts |

## `dstu-media/src/media/resample.rs`

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `crates/dstu-media/src/media/resample.rs::tests::output_length_tracks_global_grid_without_drift` | L223 | ported:host/platform/native/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::chunking_does_not_change_output` | L236 | ported:host/platform/native/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::impulse_lands_on_the_global_grid` | L246 | ported:host/platform/native/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::silence_fill_keeps_timeline` | L266 | ported:host/platform/native/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::passband_preserved_and_alias_suppressed` | L283 | ported:host/platform/native/tests/resample.test.ts |

## `dstu-docs/src/pdfium_utils.rs` / `dstu-vfs/src/vfs/repos/pdf_preview.rs`

2026-11-04：`linux_candidate_scan_finds_product_name_dir_with_spaces` 与
`linux_candidate_scan_skips_missing_root` → ported:host/platform/native/tests/pdfium-diagnostics.test.ts。
`test_pdfium_status`（命令，无 Rust 单测）→ 同文件经真实 Host service 验证最小 PDF；
L18 接入导出为 `nativePdfium.diagnostics()`。macOS/Windows 只验证候选顺序，未在目标平台验证。

Rust 侧只有 Linux 候选库路径扫描与 `PdfPreviewConfig::default()` 两个单测，前者依赖
Linux 文件系统布局，后者是配置常量，均不能直接验证 PDFium 调用。F7 用 Host 测试补充
真实调用语义：

| Rust 行为 | 去向 |
|---|---|
| `extract_text_from_document`：页序、`\f` 分隔、逐页 `trim()`、页内 `\f`→`\n`、空页跳过 | host/platform/native/tests/pdfium.test.ts |
| `page.text().all()`：`FPDFText_GetBoundedText` 整页矩形 | host/platform/native/tests/pdfium.test.ts |
| `render_with_config`：白底、RGBA、按像素尺寸、annotations 开关 | host/platform/native/tests/pdfium.test.ts |
| `load_pdf_from_byte_slice` 失败/密码/关闭生命周期 | host/platform/native/tests/pdfium.test.ts |
| `PdfPreviewConfig::default()`（150 DPI/1200 宽/1600 高/50 页/75 质量） | 未移植：属于 L18 预览配置，F7 只提供底层渲染 |

## `dstu-agent/src/chat_v2/tools/ptc_runtime.rs`（Starlark 解释器子集）

F7 只承接解释器层；`call` 的准入/预算/审批、`object_read`/`object_write` 的
artifacts/ManagedLocator/血缘属于消费方 L10 的 PTC 执行器，由 `nativeStarlark`
的宿主回调实现。下表“消费方”项因此不记为本 lane 的未移植。

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `script_final_expression_is_result` | L1235 | ported:host/platform/native/tests/starlark.test.ts |
| `script_top_level_loop_and_dict_result` | L1242 | ported:host/platform/native/tests/starlark.test.ts |
| `script_parse_error_reported` | L1258 | ported:host/platform/native/tests/starlark.test.ts |
| `script_fail_propagates_as_error` | L1266 | ported:host/platform/native/tests/starlark.test.ts（硬错误中止断言） |
| `load_statement_is_disabled` | L1274 | ported:host/platform/native/tests/starlark.test.ts |
| `tick_limit_interrupts_infinite_loop` | L1283 | ported:host/platform/native/tests/starlark.test.ts |
| `callstack_limit_interrupts_recursion` | L1304 | ported:host/platform/native/tests/starlark.test.ts |
| `call_allowed_tool_returns_envelope` | L1327 | ported:host/platform/native/tests/starlark.test.ts |
| `call_accepts_json_string_args` | L1343 | ported:host/platform/native/tests/starlark.test.ts |
| `call_denied_tool_is_hard_error` | L1357 | ported:host/platform/native/tests/starlark.test.ts（回调抛硬错误路径） |
| `call_self_recursion_is_hard_error` | L1368 | ported:host/platform/native/tests/starlark.test.ts |
| `tool_failure_returns_error_envelope_without_aborting` | L1389 | ported:host/platform/native/tests/starlark.test.ts |
| `cancellation_interrupts_blocked_call` | L1433 | ported:host/platform/native/tests/wasi-cancellation.test.ts（真实挂起宿主调用与CPU脚本取消；原deadline/预取消用例仍在starlark.test.ts） |
| `call_budget_exhaustion_interrupts_script` | L1376 | 消费方 L10：预算账本在 `call` 回调 |
| `trace_records_successful_call` | L1420 | 消费方 L10：trace 在回调/审计层 |
| `whitelist_exact_membership_and_fail_closed` | L1094 | 消费方 L10 |
| `ptc_whitelist_delegates_to_descriptor_registry` | L1131 | 消费方 L10 |
| `controlled_write_*` | L1174/L1204 | 消费方 L10 |
| `args_fingerprint_is_key_order_independent_and_stable` | L1224 | 消费方 L10：审计指纹不在 F7 引擎 |
| `object_read_*`（6 项） | L1515–L1731 | 消费方 L10：artifacts/ManagedLocator |
| `object_write_*`（3 项） | L1746–L1823 | 消费方 L10：artifacts/血缘 |

## `dstu-media/src/media/decoder.rs`

| Rust 测试 | 位置 | 去向 |
|---|---|---|
| `decodes_stereo_44k_wav_to_mono_16k_on_grid` | L444 | ported:host/platform/native/tests/audio.test.ts（40,000 采样、2500 ms、峰值 `0.3*32767±600`） |
| `probe_reports_duration_without_decoding` | L477 | ported:host/platform/native/tests/audio.test.ts（8 kHz/3 s） |
| `garbage_is_reported_as_unsupported` | L487 | ported:host/platform/native/tests/audio.test.ts（`media-unsupported` + MP4 提示） |
| `cancellation_stops_decoding` | L498 | ported:host/platform/native/tests/audio.test.ts（原预取消断言）；另由wasi-cancellation.test.ts验证真实WAV中途取消、无后续PCM，worker退出后才清理 |

## `regex = 1.12.3`（外部 crate，语义来源）

C2 08:17新增需求仍 **pending：全文captures有界替换/首超限bytes**。
当前预编译操作表没有captures_iter/captures_at/replace_all_projected；详见SPEC同名小节。
`regex.test.ts`新增两条测试仅验证现有公开API的全文边界、captures()首个结果、
可选/命名组、Rust替换引用与Unicode零宽推进，不代表分配前增长闸门已经实现。
`chatanki_transform.rs`的`security_regex_growth_is_rejected_before_result_allocation`、
`security_regex_growth_bomb_is_blocked_per_card`、`security_shrinking_or_keeping_oversized_field_is_allowed`
仍归L24记账，本lane不改其TESTMAP或用成功的unbounded replaceAll冒充bounded测试。

Rust 侧没有仓库内正则用例；`regex.test.ts` 直接以 crate 行为为 oracle：

| Rust 行为 | 去向 |
|---|---|
| `Regex::new` 失败时 `regex::Error` 的 `Display` 文本 | ported:host/platform/native/tests/regex.test.ts |
| Unicode `\w`/`\p{…}` 与内联 `(?i)`/`(?m)` | ported:host/platform/native/tests/regex.test.ts |
| `find_iter`/`captures`（含可选组、UTF-16 下标换算） | ported:host/platform/native/tests/regex.test.ts |
| `replace`/`replace_all` 的 `$name`/`${1}`/`$$` 展开 | ported:host/platform/native/tests/regex.test.ts |
| `split`（末尾空串、空匹配推进） | ported:host/platform/native/tests/regex.test.ts |

## 集成门禁：缺root依赖的测试状态（C2 v2 review后）

tokenizer改为首次调用时`createRequire`加载tiktoken（缺包时调用方得到真实MODULE_NOT_FOUND，
无估算回退），只解除`dstu.native`入口的模块加载失败，不表示tokenizer生产可用。
`NativePdfium.diagnostics`保持必需；曾为测试替身改为可选（cbf352f7b）已按C2撤销。
曾经的缺包`it.skipIf`（b38183a7a）已按C2撤销，原断言/测试名不变。

依赖tiktoken / @node-rs/argon2 / pngjs / jpeg-js的20条测试（tokenizer 8、argon2 2、
image-operations 7、image-crop组合PNG 1、office-docx含图片2）在root无四包的环境中**失败**，
状态为pending/缺root依赖，不计为main已验证；须四包经架构师裁定进入root后，以真实依赖
重跑原测试才可签收。

更新（架构师转L18请求）：生产PNG/JPEG已改用D5批准的root sharp，不再加载pngjs/jpeg-js。
相应图像编码/带图DOCX缺包阻塞已在分支解除；tiktoken/argon2仍缺root依赖。上述20条是
旧失败快照，不是本轮状态。Node20261104145405-0df76d/Electron20261104145405-8e8128
各21 passed、exit0，范围image-operations/image-crop/office-docx三文件。新增透明RGB无损PNG、
JPEG不合成alpha、固定独立PNG→DOCX不退化[image]回归；未改原测试名/断言、未skip。
Electron仍有GLib-GObject critical警告。D5 PSNR证据仍缺，相关等价测试保持pending。
macOS/Windows未在目标平台验证。nativeOffice多格式抽取仍未提供，见SPEC逐格式不可行结论。

## 非 Rust 测试补充

- C2整数crop增量：`image-crop.test.ts`5项经真实nativeImage provider，Node作业
  20261104071616-5c130f / Electron20261104071617-c8597a均exit0。覆盖固定像素/alpha/
  不变源buffer、零尺寸/越界、u32上限与负数/分数拒绝、组合PNG无损；不把私有依赖测试当
  正式集成通过，也不借此把D5的缩放/JPEG等价pending改为ported。
- vector新增真实1792/2560维schema/持久化/f32及错维拒绝测试，仍属原生适配器补充，
  不代替L12/L17的业务生命周期或Rust↔Node库互读C级证据。
  首次Node/Electron作业20261104072237-758916/35253a均exit1（发现JS Arrow静默补齐/截断
  错维数组）；修复add按真实FixedSizeList schema校验后，作业20261104072942-b73f74/
  029166均3passed、exit0；没有弱化原断言。混合批次错维时不写入任何行。

- `argon2.test.ts`：真实@node-rs/argon2与noble原始key逐字节比较（Unicode/NUL、p1/p4、
  DSBK默认64MiB/t3/p4），异步timer正常送达；Node26.5与Electron45.2.1均验证。
- `wasi-cancellation.test.ts`：真实无限量级Starlark循环期间Host timer可运行，终止worker后
  新请求仍可成功；真实pending宿主调用只产生一次副作用并可取消；一分钟WAV中途取消后无PCM。
- `office-edit.test.ts`：真实XLSX读取/定点编辑/公式覆盖/缺表跳过与返回计数；L18安全门禁不被替换。
- `office-xlsx-reader.test.ts`：readSpec/tables/metadata/replace的真实生产provider；移植
  `test_xlsx_replace_rejects_empty_find_term`与原始XFD1048576输入的
  `test_xlsx_replace_iterates_only_populated_sparse_cells`断言。因Rust公共方法自身还含
  L18安全门禁，F7这里只标codec测试通过，原Rust行由L18接线完整门禁后再标ported。

- `sandbox.test.ts`：真实bubblewrap文件/网络namespace、prlimit、环境白名单、进程组kill/reap；
  曾在Linux用Debian0.8.0解包二进制运行。WP-280核实main已有L05公开backend适配器与F7 provider；
  固定5f806c95e消费者9F及beforeAll阻断的7项e2e不能按早期通过记录签收。唯一provider probe
  作业20261106154532-9f84be exit1，原stderr为`bwrap: Creating new namespace failed: Resource temporarily unavailable`；
  实际CPU130/FSIZE4GiB/NPROC2048与Rust相同，同UID线程7910→8007超过2048；blocked交C2。
  逐9条+1suite链与原件路径见`migration/spec/F7-native.md`的WP-280节；本包没有改变任何测试去向/断言。
- `windows-files.test.ts`：`windows_runtime_root_and_file_identities_use_handle_information`
  的真实Win32路径已写出，按win32条件执行；Linux跳过此目标测试，不声明目标验证通过。
- `windows-sandbox.test.ts`：真实AppContainer profile/SID、Job限制+挂起启动与预取消测试按win32执行。
  L05 W3增量：full-access Job退出码/预取消/运行中取消、ACL mutex进程内互斥与等待中取消，
  以及windows-files的同handle readAt/refreshInformation，均按win32执行；Linux只验证明确拒绝。
  Windows未在目标平台验证；L05的ACL/写目录/网络/e2e仍pending，不在F7擅改其TESTMAP。

- `office-generation.test.ts`：真实Host provider生成PPTX/XLSX，验证标题/副标题/要点/表格、
  幻灯片数量/尺寸、Excel工作表顺序/名称/数值与布尔类型/粗表头、无效spec拒绝。
  对应Rust生成入口没有同名仓库单测；不把本补充冒充L18抽取/编辑测试移植。
- `host/platform/vector/tests/vector.test.ts`：真实临时Lance目录、固定f32向量schema、
  无损Int64(9007199254740993)、重复append、SQL筛选投影、cosine搜索、列升级、
  删除/关闭/重开、损坏目录区别、Rust非prefix CJK ngram FTS/_score、btree与all优化。
  Rust↔Node实际库互读仍为C级，不运行Rust。

- 2026-11-04 `image-operations.test.ts`：`test_crop_figure_default_bbox_yields_minimal_crop`、
  `test_crop_figure_inverted_and_out_of_range_bbox`（vlm_grounding_service.rs）→ pending（D5要求PSNR，不自行签收）；
  image 0.24.9 外部 crate 的 `test_resize_same_size`、`test_issue_186`、`bug_1600`、
  `roundtrip_sanity_check` → pending（RGBA8实现/测试已接入，但D5像素证据未齐）；另测反向/越界框、独立alpha采样、
  PNG精确像素、JPEG大小硬上限。Rust JPEG实产物容差对照仍是C级，不声明逐像素等价。

- `compression.test.ts`：Zstd 原始帧、串联帧、截断、解压大小限制、gzip 单 member 与 CRC。
- `heic.test.ts`：桌面 raw-body 的四个 Rust 分支及 AppError 形状。
- HEIC桌面扩展：最新架构师D5不批准libheif-js，已撤回本轮专为该扩展新增的测试/样本；
  原 `heic.test.ts` 的Rust桌面分支断言未删改。此前Node/Electron扩展测试通过不作为签收依据。
- `protobuf.test.ts`：请求帧字节、gRPC 分帧/截断、gzip data frame、trailer、
  prost 字段合并与 UTF-8/wire 校验；另验证 `dstu.native` 插件实际提供该服务。
- `office-text.test.ts`：csv-core 默认 dialect 向量、flexible 行、多行字段、
  双引号转义与 Rust 空白裁剪。
- `tokenizer.test.ts`：cl100k/o200k token id、模型家族选择与 `o1` 词边界、
  f32 启发式、8,000 字符阈值、稠密段采样不低估、`dstu.native` 注册。
- `pdfium.test.ts`：3 页文档的页数/页尺寸、页序文本、`\f`、RGBA 像素、损坏输入、
  重复 close 与插件注册。
- `image.test.ts`：`image = 0.24.9` 的 PNG/BMP 宽高与 RGBA 像素、未知格式的
  `ImageError` Display、`dstu.native` 注册。
- `fsrs.test.ts`：FSRS-6 默认参数、17/19/21 参数补全、f32 数值向量、
  forgetting curve 常量。
- `fsrs-service.test.ts`：`nativeFsrs` 与 binding 的 FSRS-6 `nextStates` 逐位一致；
  `optimize` 未注册。
- `regex.test.ts`：`regex::Error` 逐字文案、Unicode 类、UTF-16 偏移、Rust 替换语法、
  `Regex::split`。
- `starlark.test.ts`：重放式宿主调用、tool failure envelope、方言/限制/取消、
  object_read/object_write 默认参数、插件注册。
- `audio.test.ts`：与 `decoder.rs` 相同的 WAV 向量、错误码/文案、分块/进度、
  预取消、插件注册。
- `api.test.ts`：Rust 引擎版本来源（fsrs 6.6.2、starlark 0.14.2、pdfium_7350、
  lancedb 0.22.1）。

## 未移植：真实引擎缺失（不计为已移植）

- `document_parser.rs` 的 docx/xlsx/pptx/rtf/ods/xlsb/epub 用例（含
  `test_file_too_large`、`test_markdown_extension_alias`、`test_base64_*`、
  `test_bounded_xlsx_writer_*`、加密检测与 zip 炸弹用例）：需要 docx-rs、
  umya-spreadsheet、zip、EPUB/XML、RTF 引擎；当前未声明或未安装。扩展名分派
  还依赖 L18 的文档命令层。
- LanceDB0.37 Rust↔Node双向互读仍为C级；Node真实建表/持久化/FTS已经实现。
- HEIC桌面扩展由架构师D5明确否决，不列为“缺少原生库导致业务未迁移”；保持原错误。
- tokenizer原4条测试已由Rust/WASM核心完成，不再用旧JS性能理由标pending。

## C 级动态向量（本轮不运行 Rust）

- Zstd/flate2 实际写出字节与 Rust 产物对照；现有测试验证解码/帧语义，不声明压缩字节恒等。
- 音频完整 PCM 与 Rust 运行产物逐字节比对（当前用 `decoder.rs` 的生成 WAV 向量，
  未在 Rust 侧动态运行）。
- PDFium 7350 逐像素/逐字体对照（当前 wasm 为 chromium/7689）、Lance 0.37 真实库
  双向读写（Arrow已经安装）、FSRS 优化器全量数值、Office 真实文档。
- 四目标平台 win-x64、linux-x64、mac-x64、mac-arm64 的 wasm 加载与
  audio/starlark/regex/image 测试。

## 2026-11-05 第二次 WASI 重建的新增测试

- `regex-projected.test.ts`：L24 验收表 8 条（第 3 条 bytes 按 Rust 改为 6，见 SPEC）、UTF-8 计数、>1MiB 首超限、limit 校验。
- `office-structure.test.ts`：DOCX structured/tables/as_spec/metadata 与 PPTX metadata，document_parser.rs 无对应 Rust 测试，为契约测试。
- 全量回归作业 20261104200158-b8309d：`vitest host/platform/native` 30 文件 181 passed / 5 skipped。

## 2026-11-04 nativeOffice（docx/rtf）与 D10 编码

- `host/platform/native/tests/office-extract.test.ts`（真实 `nativeOffice` provider，经 createTestHost）：
  docx 段落/run/tab/br/hyperlink/ins/del、Markdown 表格、docx-rs 流式 quirk（行内 sdt、正文 sdt、公式、Fallback、
  文本框、instrText、CDATA）、生产 DOCX 生成器回读、ReaderError 文案；rtf-parser 0.3.0 crate 测试
  `document.rs::get_text_from_document`、`parser.rs::{parse_header_and_body, should_parse_escaped_char, parse_unicode,
  parse_two_characters_compound_unicode, parse_unicode_with_fallback, parse_ignore_group_with_crlf}` 以 get_text 结果断言；
  Lexer/Parser 错误 Debug 文案；格式分派。document_parser.rs 本身无 docx/rtf 文本测试，以上为契约测试。
- 带图 DOCX / 图片编码用例依赖 root 安装 pngjs@7.0.0、jpeg-js@0.4.4（D10）。（2026-11-05 起由 D12 同 crate 编码取代：
  image-operations / image-crop / office-docx 去掉 `skipIf(imageEncoderMissing)`，无条件运行。）
- 批次2 pptx：同文件 `nativeOffice pptx` 组——自制 slide（排序/页码/Markdown run/列表计数/表格/图片换行/grpSp 忽略）、
  生产 PPTX 生成器回读、pptx-to-md 整份失败条件（无 txBody、无 blip、无 cSld、未绑定前缀、非 ZIP）。
- 2026-11-04 改为同 crate WASI 引擎后同文件重写为 19 项（docx 5、rtf 5、pptx 3、spreadsheets 3、html 2、dispatch 1），全部经 `host.ctx.nativeOffice`；新增 `nativeOffice spreadsheets`（生产 XLSX 生成器回读的表头检测/行数/表序；ODS 经 `open_workbook_auto_from_rs`；无法识别字节→`Excel解析错误: 无法解析Excel数据: Cannot detect file format`）与 `nativeOffice html`（标题/强调/列表/链接引用、80 列折行、trim；非法 UTF-8 有损解码为 U+FFFD）。这些 html/xlsx 期望值写测试时由 crate 行为推断，已用真实产物验证全部成立，无需更正。document_parser.rs 无对应 Rust 文本测试，均为契约测试。
- 重建后回归：作业 20261104154637-f2ea71 `vitest host/platform/native` 27 文件 151 passed / 5 skipped（skip 均为 Windows/沙箱平台门控），含 office-extract 19、regex 9、starlark 14、audio 6、image 4、image-operations 12、image-crop 5、wasi-cancellation 3、resample 5。
