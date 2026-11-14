# L18-media-docs 等价语料（WAVE0 v0）

本目录包含两个工作包：WP-054（下文前半部分，本地媒体/文档提取 14 条命令）与
WP-231（文末 “WP-231 语料 v1” 一节，清单 43 条命令）。

## WP-054 本地媒体/文档提取

范围：本地媒体/文档提取、文件路径与格式错误组，14 个前端可达命令。
本目录语料**未运行 A/B、不计 C**；`normalize` 全部为 `[]`，`expect:"error"` 只是注释，
真实 Rust 运行（A）是唯一判据，未伪造任何 expected 值。TESTMAP/SPEC 未改动。

文件：`documents-parse.json`（7 场景）、`ocr-handout-heic.json`（4）、`textbooks-files.json`（14）、
`media-transcripts.json`（4），共 29 场景、240 步；`fixtures/` 14 个自有夹具。

## 命令

Rust 路径相对 `src-tauri/`；行号为 `pub async fn` 所在行。

| 命令 | 前端调用点 | Rust | 错误类型 |
|---|---|---|---|
| `parse_document_from_base64` | src/components/TranslateWorkbench.tsx:607 | src/commands.rs:4122 → crates/dstu-docs/src/document_parser.rs:933 | String：`Base64文档解析失败: <ParsingError>` |
| `test_ocr_engine` | src/features/settings/components/OcrEngineTestPanel.tsx:127 | src/cmd/ocr.rs:613 | AppError；OCR 失败为 Ok(`success:false`) |
| `handout_vlm_caption` | src/features/media-handout/api.ts:45 | src/cmd/handout.rs:97 | AppError |
| `convert_heic_to_jpeg` | src/utils/heicConversion.ts:192 | src/heic_decoder.rs:79 | AppError |
| `textbooks_add` | src/dstu/adapters/textbookDstuAdapter.ts:178；src/utils/chatApi.ts:354 | src/cmd/textbooks.rs:115 | AppError；单文件失败只发 `textbook-import-progress` stage=error |
| `textbooks_relink` | src/features/learning-hub/apps/views/TextbookContentView.tsx:580 | src/cmd/textbooks.rs:701 | AppError |
| `textbooks_update_bookmarks` | src/api/vfsFileApi.ts:129 | src/cmd/textbooks.rs:822 → crates/dstu-vfs/src/textbooks_db.rs:66 | AppError |
| `vfs_get_file_blob_path` | src/features/learning-hub/apps/views/FileContentView.tsx:466（另 7 处） | src/cmd/textbooks.rs:786 | AppError |
| `get_image_as_base64` | src/components/crepe/features/imageUpload.ts:20；src/utils/configApi.ts:13,18 | src/commands.rs:8494 → crates/dstu-storage/src/file_manager.rs:389 | AppError |
| `notes_export_docx` | src/features/notes/noteDocxExport.ts:72 | src/cmd/handout.rs:147 → document_parser.rs:2151 | AppError |
| `media_transcript_get` | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:291 | crates/dstu-media/src/media/commands.rs:383 | String：`MediaError.to_payload_string()` JSON |
| `media_transcript_import` | 同文件:296 | crates/dstu-media/src/media/commands.rs:423 | 同上 |
| `media_transcript_export` | 同文件:301 | crates/dstu-media/src/media/commands.rs:505 | 同上 |
| `media_transcribe_estimate` | 同文件:278 | src/media/commands.rs:20 → crates/dstu-media/src/media/commands.rs:296 | 同上 |

### 可达 Err / 提前返回分支

- **parse_document_from_base64**：data URL 无逗号（Base64DecodingError）；解码前大小上界
  `check_base64_decoded_size`（200MB）；base64 解码失败；无扩展名且不在纯文本白名单
  （`无法确定文件扩展名`）；不支持的扩展名；PDF 加密检测 / pdfium 加载 / 解析失败；
  DOCX 加密（CFB 头）/ ZIP bomb / 解包失败；Excel 加密 / 解析失败；PPTX 大小 / 加密 / bomb / 解析；
  EPUB 大小 / bomb / 解析；RTF 解析；spawn_blocking join 失败（不可构造）。
- **test_ocr_engine**：`图片解析失败`（data URL 无逗号、base64 错）；临时目录创建 / 写入失败；
  system_ocr 在 Linux 返回 Ok `success:false` +
  `不支持的功能: System OCR is not available on this platform…`；非 system 引擎走 LLM。
  未知 engineType 回退为 `paddle_ocr_vl`（types.rs:28）；config_id 找不到时名称回退到适配器名。
- **handout_vlm_caption**：`prompt is empty`（trim 后空）；`prompt too long`（>120000 字符）；
  `invalid frame image`（空或 >8MiB）；`get_vlm_config` 配置错误；LLM 调用错误；取消。
- **convert_heic_to_jpeg**：非 raw body → `HEIC_INVALID_INPUT: expected raw binary request body`；
  raw 空 → `…empty image body`；raw >50MB；非 Android → `HEIC_UNSUPPORTED_PLATFORM`；Android 插件错误。
- **textbooks_add**：`sources` 为空 → `Ok([])`；VFS 未配置；逐文件跳过（只发事件、继续）：
  不支持扩展名、无法识别格式、>200MB、读取/哈希失败、PDF 缺文件头、PDF 加密、文档解析失败、
  入库失败（锁/忙重试 3 次后跳过）；全部跳过时发一条汇总 error 事件仍返回 Ok；
  sha256 已存在 → 复用（非 active 则 restore，blob 缺失则自愈）；`folderId` 挂载失败 →
  `VFS 挂载教材失败`（教材已创建）；PDF 渲染失败记入 `processing_error` 但仍成功；
  bilibili 链接条目 LinkOnly 分支。
- **textbooks_relink**：VFS 未配置；`教材不存在`；哈希读取失败；
  `所选文件与原文件内容不一致，请选择同一个文件`；更新 original_path / 读取 / 补存 blob 失败；参数反序列化失败。
- **textbooks_update_bookmarks**：VFS 未配置；id 不存在 → `update_vfs` 返回 Ok(None)，命令仍 Ok(true)；
  DB 更新失败；`bookmarks` 非数组 / 缺失 → 参数反序列化错误。
- **vfs_get_file_blob_path**：VFS 未配置；取连接 / 查询失败；无行或 `blob_hash` 为空 → `null`；
  blob 路径不存在 → `null`。
- **get_image_as_base64**：canonicalize app_data_dir 失败；`拒绝访问：超出应用数据目录`；
  `图片文件不存在`；存在性检查失败；读取失败（如目录）。
- **notes_export_docx**：非 image 块 / 已有 data / src 非字符串 / http(s) → 跳过；本地取图失败只 warn；
  DOCX 生成或 pack 失败（`internal`）；spawn_blocking 失败；`spec` 缺失 → 参数错误。
- **media_transcript_get**：`媒体文件不存在: {id}`（id 或 resource_id 都不匹配）；
  `不是音视频文件: {name} ({mime})`；DB / join 错误。
- **media_transcript_import**：load 失败（同上）；读取失败 / >20MB（Io）；
  `无法识别的字幕格式（支持 .srt / .vtt / B 站 BCC .json）`；BCC JSON 解析失败；
  `字幕文件中没有可用的字幕条目`；写段 / 刷新检索失败；导入后异步 `start_pipeline` 失败只记日志。
- **media_transcript_export**：load 失败；`不支持的导出格式: …（可选 srt / vtt / txt）`（先 load 后校验格式）；
  `还没有可导出的字幕（请先转写或导入字幕）`；写目标失败（Io）。
- **media_transcribe_estimate**：load 失败；已有段 → 直接返回 exact；LinkOnly 链接条目错误；
  `媒体文件内容缺失`；探测 / 解码失败；≤20 分钟实测、否则启发式；ASR 未配置只影响 `asrConfigured`，不报错。

## 覆盖表

场景 id 省略文件前缀；“✓”表示语料中有对应步骤，“—”表示未覆盖（原因见下节）。

| 命令 | 成功分支 → 场景 | 错误/提前返回分支 → 场景 |
|---|---|---|
| parse_document_from_base64 | txt/md/markdown/html/htm/csv/json/xml/代码与无扩展名白名单/大写扩展名 → `docs.parse_b64.text_formats`；GBK/UTF-16 BOM/UTF-8 BOM/非法 UTF-8/GBK csv → `text_encodings`；data URL、空内容 → `data_url_and_empty`；PDF、大写 PDF → `pdf`；DOCX → `docx`；XLSX/EPUB/RTF → `xlsx_epub_rtf_pptx` | data URL 无逗号 → `data_url_and_empty`；非法/缺 padding/含空格 base64、无扩展名、空文件名、exe/tar.gz/doc/png 不支持 → `invalid_input_errors`；加密标记/损坏/伪 PDF → `pdf`；ZIP bomb/无 Content_Types/CFB 加密/非 zip → `docx`；伪 xlsx/xls/ods、伪 epub、epub bomb、伪 pptx → `xlsx_epub_rtf_pptx`；坏 json/xml/rtf 走哪支由 A 判定 |
| test_ocr_engine | system_ocr/别名 SYSTEM/native/system、未知 configId 回退、webp 扩展推断、空图 → `ocr.test_engine.system_ocr_platform`（Linux 下为 Ok+`success:false`） | data URL 无逗号、非法 base64（system/paddle/未知引擎）→ `ocr.test_engine.invalid_image_errors` |
| handout_vlm_caption | — | 空、全空白、120001 字符 prompt；120000 字符边界+空图；空图（带/不带 mime、requestId）→ `handout.vlm_caption.input_validation` |
| convert_heic_to_jpeg | — | 无参数、`{}`、JSON 字节数组 → `heic.convert.json_body_rejected` |
| textbooks_add | 新建 txt、sha256 复用 → `textbooks.add_text.relink_bookmarks_blob`；`[]`（含 folderId=null）→ `add.empty_and_unsupported`；PDF 渲染成功 → `add.pdf_render_success`；PDF 渲染失败入库 → `add.pdf_render_error_recorded`；部分成功批次 → `add.parse_failures_and_partial_batch`；csv/html/json/xml/rtf/py/markdown/大写 TXT 批次 → `add.text_format_batch`；纯数字文件名 → `add.opaque_numeric_name` | 不支持扩展名、无扩展名（LICENSE/tiny）、文件不存在、目录不存在、全部跳过汇总事件 → `add.empty_and_unsupported`；缺 PDF 头、PDF 加密 → `add.pdf_validation`；DOCX/EPUB 解析失败 → `add.parse_failures_and_partial_batch`；`folderId` 不存在 → `add.folder_id_missing` |
| textbooks_relink | 同路径、内容相同的新路径 → `textbooks.add_text.relink_bookmarks_blob` | 内容不同、新路径不存在 → 同上；教材不存在、缺 `newPath` → `textbooks.missing_ids` |
| textbooks_update_bookmarks | 对象书签、空数组、非对象元素 → `add_text.relink_bookmarks_blob`；不存在 id 仍 true → `missing_ids` | `bookmarks` 非数组、缺失 → `missing_ids` |
| vfs_get_file_blob_path | 文本教材 blob、PDF blob → `add_text.relink_bookmarks_blob`、`add.pdf_render_success`；不存在/空 id → `missing_ids`；内联小文件 null → `media.transcript.not_found_and_not_media` | —（仅 DB 故障） |
| get_image_as_base64 | 相对/绝对/file:///asset:///tauri:// 路径、png/GIF/webp/bmp/heic/heif/jpeg/txt MIME、`%20` 解码与空格名 → `image_b64.path_forms_and_mime`；blob 绝对路径 → `add_text.relink_bookmarks_blob` | `/etc`、file:///etc、不存在的外部绝对路径、`C:/`、不存在（相对/绝对）、`..` 逃逸、目录、空串 → `image_b64.rejections` |
| notes_export_docx | 空 spec、全部块类型与未知块、handout 模板、official 模板、null/字符串/数组 spec、blocks 非数组 → `notes_docx.spec_shapes`；本地图、缺失图、http(s) 跳过、越界图、已有 data、非法 data、src 非字符串、handout 模板图 → `notes_docx.image_resolution` | —（生成失败需构造 docx-rs pack 错误，未找到输入可达路径） |
| media_transcript_get | 未导入、导入后、按 resourceId 别名 → `media.transcript.srt_import_get_export`、`import_formats_and_errors`；新上传 → `no_segments_and_fresh_estimate` | 不存在、空 id、非媒体 → `not_found_and_not_media` |
| media_transcript_import | SRT → `srt_import_get_export`；VTT、BCC JSON、按内容嗅探 .sub → `import_formats_and_errors` | resource_hash 当 id（不匹配）、无法识别、空字幕、坏 BCC、文件不存在、目录 → `import_formats_and_errors`；不存在、非媒体 → `not_found_and_not_media` |
| media_transcript_export | vtt、`.SRT`、` text `、webvtt → `srt_import_get_export` | docx 格式、写入目录 → `srt_import_get_export`；无段、bogus 格式 → `no_segments_and_fresh_estimate`；不存在（load 先于格式校验）→ `not_found_and_not_media` |
| media_transcribe_estimate | 导入后 exact → `srt_import_get_export`；新文件实测（解码+VAD）→ `no_segments_and_fresh_estimate` | 坏 WAV 探测失败 → `no_segments_and_fresh_estimate`；不存在、非媒体 → `not_found_and_not_media` |

## 阻塞与未覆盖

- **raw body**：v0 `args` 只能表达 JSON，`convert_heic_to_jpeg` 的 raw 空 body、>50MB 与
  `HEIC_UNSUPPORTED_PLATFORM` 需要运行器支持 raw 二进制调用。Android 成功路径需真机插件，阻塞。
- **mock LLM/VLM**：无离线模拟服务。`test_ocr_engine` 的 LLM 引擎成功/失败、`handout_vlm_caption`
  的 `get_vlm_config` 及之后分支均未写。待 X5 提供端点后用参数化环回地址
  （例如 `http://127.0.0.1:<port>/v1`，两后端同一端点、无 API key、不联网）补场景；
  空 seed 下 `get_vlm_config` 是否报 `未找到可用的 VLM 模型…` 取决于默认配置，不能预设。
  （WP-231 已用 X5 端点补 `handout_vlm_caption` 的成功与上游 500 分支，见 `handout-llm.json`。）
- **平台**：macOS/Windows 系统 OCR 成功路径只能在对应平台录制，Linux 结果为 `success:false`，不得改判为成功。
- **pdfium**：PDF 解析/渲染依赖 pdfium 动态库；A 环境缺库时会走 `PdfParsingError` / 渲染失败分支，
  录制时须记录 pdfium 状态。
- **不可构造或不划算**：>200MB 文档、>8MiB 帧、>20MB 字幕、>20 分钟媒体的启发式估算；
  DB 锁重试（不确定）；VFS 未配置（应用启动即配置）；DB/IO 故障注入（v0 无故障协议）；
  `textbooks_add` 的 restore/自愈 blob 分支（需 L13 的删除/回收站命令或旧数据 seed）；
  bilibili LinkOnly（需联网创建链接条目，归本 lane bilibili 包）；有效 pptx 夹具未制作。

## 跨域辅助命令与 seed owner

步骤里用到但不列入 `commands`：

| 命令 | owner | Rust |
|---|---|---|
| `get_app_data_dir` | F2-shell | src/commands.rs:563 |
| `save_text_to_file` | F2-shell | src/commands.rs:4272 |
| `read_file_text` | F2-shell | src/commands.rs:4150 |
| `vfs_upload_file` | L13-vfs-api | crates/dstu-vfs/src/vfs/handlers.rs:2108 |

所有场景 `seed:"empty"`，不依赖其他 lane 的 seed；restore 分支所需的“已删除教材”seed 归 L13-vfs-api。

## 运行器约定（需 X5/X7 确认）

- `${0}` 指第 0 步的**整个字符串结果**（`get_app_data_dir`），与后缀拼接使用（同 L07 `skills-local.json`）；
  运行器需支持裸 `${n}` 和数组下标 `${2.0.id}`。
- 文本类夹具和 PDF 在运行时用 `save_text_to_file` 写入 `${0}/w0-*`、`${0}/notes_assets/w0/`。
  三个 PDF 均为纯 ASCII，按 UTF-8 写入后字节不变（生成脚本有断言）。二进制夹具以 base64 内联。
- `textbooks_add`（PDF）、`media_transcript_import`、`vfs_upload_file` 会启动异步流水线；
  采 DB/事件前需要静默屏障，否则 `processing_*` 列与后续事件不确定。

## normalize 候选（未写入 JSON）

- 绝对路径：`${0}` 展开值、`original_path`、blob 路径、导出 `path`、错误信息中的路径（`图片文件不存在: …`、读取失败）。
- 时间：`created_at` / `updated_at`（ISO 与毫秒）、`processing_started_at`、`elapsedMs`、
  DOCX `docProps/core.xml` 时间戳（影响 `notes_export_docx` 返回的 base64）。
- id：`file_*`、`res_*`、`sourceId`、OCR 临时文件名、自动命名 `导入文档_%Y%m%d_%H%M%S`。
- 事件：`textbooks.add.pdf_render_success` 之后的异步 PDF 流水线事件、`dstu:change` 顺序。

## 夹具（sha256  字节数  文件）

```
a899fb4496afa7230c378d5be03cf3461990994993110fd2dad3257111081275  512  cfb-header.docx
c079c1103475687056f0740f5485ccbb93758b5da26edbea01fd226406500be5  48  corrupt-body.pdf
cd43d69376bf50764159f4811f6228d9a790f3ee31cde7bfaa8dc04209f8f4a3  613  encrypted-marker.pdf
58b2260e988b11ae520c2b7859774dd5728a6dc6912a494dfc21ff1e36798951  30  gbk.txt
3c416a8ab69634746f717fd1bcb86a0ff79e9f1becc03b69787664346baf597e  11  invalid-utf8.txt
880f86e21699849cf7a7e6097786f2a77c7714609a9c5d998e94899e5304ab0d  143  no-content-types.docx
2e9b06dc65a4dec84a3eb3124553ec93ca27c78221e64ab2177d0f1412cfcb20  69  pixel.png
d264b7946e5e4fb9b26c7c8fbd421a49db696d8bb1d5ab5f351f4d4aed014aef  1751  tiny.docx
78eebc24f8d07f24b668bf40475fdfaf1064dff892407b1a22c10af887936bcc  1706  tiny.epub
843fc1337ee10567a488cb90c21221395a1a221fae2fac5e462139c05d6c8254  583  tiny.pdf
9bd2a20dacd1a16514c982984cfe3e1bcff9802eda038d172bef53dd44afe584  2482  tiny.xlsx
aaf16b611b73a35c74210d54d0ca23a919b848456dc37d11240c09035f8ef33d  38444  tone-1s2.wav
a052e662423c96428495f30e0f43d7a11d3a48f319555f167a005ca641918b26  20  utf16le-bom.txt
38eb217900f1782376d7d8065e27a2a3e22b169cb270512e0aec95c7773a4157  1595  zip-bomb.docx
```

## 剩余命令

无前端调用、两个包都未覆盖：`parse_document_from_path`、`compress_image`。
WP-054 时列为“剩余”的 OCR 引擎配置、handout、媒体播放/台账、bilibili、tts、
`voice_input_transcribe`、`test_pdfium_status` 已由 WP-231 覆盖（见下节）。PDF OCR 会话类命令不在 WP-231 清单中，未写。

---

## WP-231 语料 v1（43 条命令）

清单：`.oc-runs/board/corpus/WP-231-L18-media-docs.md`。语料**未运行 A/B、不计 C**；`normalize` 全为 `[]`，
`expect:"error"` 只是注释，真实 Rust 运行（A）是唯一判据，未写任何 expected 值。TESTMAP/SPEC/Rust 未改动。

| 文件 | 场景 | 步 |
|---|---|---|
| `ocr-config.json` | 4 | 50 |
| `handout-llm.json` | 6 | 49 |
| `voice-input.json` | 4 | 24 |
| `media-player-ledger.json` | 6 | 96 |
| `bilibili-offline.json` | 6 | 104 |
| `tts-pdfium.json` | 2 | 10 |
| `docs-boundaries.json` | 1 | 8 |
| `pending-network/bilibili-live.json`（需联网，见“阻塞”） | 2 | 14 |
| 合计 | 31 | 355 |

另有 `harness.sidecar.json`：把 7 个场景绑定到 X5 LLM 脚本（`success.answer` / `error.http-500`），格式同
`host/plugins/chatanki/equivalence/harness.sidecar.json`。同时修了 WP-054 旧文件：`get_app_data_dir` 步补 `"args":{}`；
`convert_heic_to_jpeg` 第一步补 `"args":null`（与第二步 `{}` 区分）；`textbooks.add.folder_id_missing` 第 2 步补
`expect:"error"`；`media-transcripts.json` 的 `commands` 补 `vfs_get_file_blob_path`。

### 命令覆盖表

Rust 路径相对 `src-tauri/`，`dm/` = `crates/dstu-media/src/media/`。前端路径相对 `src/features/`（`utils/`、`voice-input/` 除外）。
场景 id 省略前缀时以所在文件为准；“—”表示无此类场景，原因写在最后一列。

| 命令 | 前端 | Rust | 成功分支 → 场景 | 错误/提前返回 → 场景 | 未覆盖与原因 |
|---|---|---|---|---|---|
| get_ocr_engines | settings/components/OcrEngineCard.tsx:87 | src/cmd/ocr.rs:38 | 静态列表 → `ocr.config.defaults_and_thinking` | — | 无 Err 分支（固定返回 Ok） |
| get_ocr_engine_type | settings/components/ModelsTab.tsx:214 | src/cmd/ocr.rs:56 | 默认 `paddle_ocr_vl`、写入后读取 → `defaults_and_thinking`、`malformed_setting` | — | 只有 DB 读取失败，v0 无故障注入 |
| get_ocr_thinking_enabled | OcrEngineCard.tsx:96 | src/cmd/ocr.rs:70 | 默认、true、false → `defaults_and_thinking` | — | 无 Err 分支 |
| set_ocr_thinking_enabled | OcrEngineCard.tsx:365 | src/cmd/ocr.rs:76 | true/false → `defaults_and_thinking` | 缺 `enabled`、字符串 → 同上 | DB 写失败不可构造 |
| get_available_ocr_models | chat/readiness/autoAssignModel.ts:189；OcrEngineCard.tsx:78 | src/cmd/ocr.rs:154 | 默认、增删改后、旧模型名迁移（SF/智谱 GLM-4.1V、PaddleOCR-VL）、孤儿 configId → `engine_lifecycle`、`migrations_and_discontinued`、`malformed_setting` | 设置值非 JSON → `解析 OCR 模型配置失败`（`malformed_setting`） | — |
| save_available_ocr_models | settings/components/SiliconFlowSection.tsx:1006 | src/cmd/ocr.rs:356 | 6 条混合列表、空列表 → `migrations_and_discontinued`；VLM 引擎注册 → `handout.vlm_caption.*` | 缺必填字段、缺 `models` → `migrations_and_discontinued` | — |
| update_ocr_engine_priority | autoAssignModel.ts:320；OcrEngineCard.tsx:118 | src/cmd/ocr.rs:403 | 重排+未知 configId+禁用、空列表 → `engine_lifecycle` | 元素缺 `enabled` → `engine_lifecycle`；设置损坏 → `malformed_setting` | — |
| add_ocr_engine | autoAssignModel.ts:255；OcrEngineCard.tsx:198 | src/cmd/ocr.rs:447 | glm4v/推断类型/null 类型/孤儿 configId → `engine_lifecycle` | `该模型已在 OCR 引擎列表中`、`系统 OCR 引擎由系统自动管理，无需手动添加`、缺 `name` → `engine_lifecycle`；SF GLM-4.6V 停服 → `migrations_and_discontinued`；设置损坏 → `malformed_setting` | — |
| remove_ocr_engine | autoAssignModel.ts:217；OcrEngineCard.tsx:173 | src/cmd/ocr.rs:527 | 删除 → `engine_lifecycle` | 再删 `未找到该 OCR 引擎`、系统引擎 `…无法删除`、缺 `configId` → `engine_lifecycle`；设置损坏 → `malformed_setting` | — |
| handout_llm_complete | media-handout/api.ts:33 | src/cmd/handout.rs:74 | 普通、jsonMode、120000 字符边界 → `handout.llm.success_answer`（X5 `success.answer`） | `prompt is empty`（空/空白）、`prompt too long`、预取消 `cancelled`、缺参/类型错 → `validation_and_cancel`；`对话模型未配置`、配置不存在/嵌入模型/停用 → `model2_unconfigured`；上游 500 → `upstream_500` | 生成中途取消需并发 cancel，v0 串行步骤表达不了 |
| handout_cancel | media-handout/api.ts:54 | src/cmd/handout.rs:129 | 未注册 id、空 id、运行后取消 → `validation_and_cancel`、`success_answer` | 缺 `requestId` → `validation_and_cancel` | — |
| handout_release | media-handout/api.ts:58 | src/cmd/handout.rs:135 | 重复释放、未注册、空 id → `validation_and_cancel`；运行后释放 → 各 LLM 场景 | 缺 `requestId` → `validation_and_cancel` | — |
| handout_vlm_caption | media-handout/api.ts:45 | src/cmd/handout.rs:96 | 带/不带 mime 与 requestId → `handout.vlm_caption.success_answer` | 预取消 → `handout.llm.validation_and_cancel`；上游 500 → `vlm_caption.upstream_500`；输入校验 → WP-054 `input_validation` | “未配置 VLM”分支：空 seed 会回落到内置厂商（可能带编译期 key 联网），不写 |
| voice_input_transcribe | voice-input/providerRegistry.ts:29 | crates/dstu-media/src/voice_input.rs:21（端点解析 :867，配置映射 :321） | 指定 configId、按分配回落、空音频 → `voice.transcribe.success_answer` | `语音识别模型配置不存在`、`…已停用`、缺 key（settings-required）、realtime/filetrans/anthropic（provider-unavailable）、只给 providerId（`needs a model configuration (configId)`）、空白 configId 回落、`Invalid audio payload`、缺字段 → `config_errors`；`缺少 Base URL` → `missing_base_url`；上游 500 → `upstream_500` | 空转写结果需自定义 X5 脚本（owner X5）；无配置时的 siliconflow 默认 ASR 会用内置 key 联网，不写 |
| media_progress_get | learning-hub/apps/views/media/mediaTranscriptApi.ts:305 | dm/commands.rs:533 | 未写入、写入后、resourceId 别名 → `media.progress.set_get_clamp` | 不存在、空 id、非媒体、缺参 → 同上 | — |
| media_progress_set | mediaTranscriptApi.ts:309 | dm/commands.rs:544 | 正常、负数/越界钳制、接近结尾、finished、只给 id → `set_get_clamp`；B 站链接条目 → `bili.link_item.offline_descriptor` | 不存在、非媒体、`positionMs` 类型错 → `set_get_clamp` | — |
| media_transcribe_start | mediaTranscriptApi.ts:283 | src/media/commands.rs:28 | 启动、重复启动、按 resourceId → `media.transcribe.start_cancel_scripted_asr`（X5） | ASR 守卫配置（无 key）→ `asr_unconfigured`；`媒体文件不存在`、`resourceId 不能为空`、`不是音视频文件`、缺参 → 同上；LinkOnly → `bili.link_item.offline_descriptor` | AsrFatal 在后台流水线中发生，结果依赖静默屏障（见风险） |
| media_transcribe_cancel | mediaTranscriptApi.ts:287 | dm/commands.rs:366 | 空闲取消、别名、运行中取消、链接条目 → `asr_unconfigured`、`start_cancel_scripted_asr`、`offline_descriptor` | 不存在、非媒体、缺参 → `asr_unconfigured` | — |
| media_library_list | media-studio/api.ts:219 | dm/library.rs:410 | 空库、音频/视频/文本/链接混合、limit null/缺省/1/0/u32 上限 → `media.library.list_limits` | limit 负数、字符串 → 同上 | — |
| media_related_notes | media-studio/api.ts:223 | dm/library.rs:440 | 无笔记、resource/chat/畸形 `_origin`、前后空白 → `media.related_notes.chapters` | 空串、空白（`resourceId 不能为空`）、缺参 → 同上 | — |
| media_chapters | learning-hub/apps/views/media/mediaChapters.ts:47 | src/media/ledger.rs:19 | 无笔记、带 `[媒体@…]` 标题、空白裁剪、不匹配、空 id → `media.related_notes.chapters` | 缺参 → 同上 | — |
| media_checkpoints | learning-hub/apps/views/media/mediaCheckpoints.ts:93 | src/media/ledger.rs:11 | 无题、多题（含小时级时刻、无出处）、裁剪、不匹配、空 id → `media.ledger.checkpoints_and_tallies` | 缺参 → 同上 | — |
| media_study_ledger | media-studio/api.ts:229 | src/media/ledger.rs:27 | 空/多资源、去重与空白、includeCardIds true/false/null、空数组 → `checkpoints_and_tallies` | 缺参、非数组 → 同上 | 卡片统计需 chatanki 的 document_tasks seed（owner chatanki） |
| media_bilibili_transport_status | learning-hub/apps/views/media/bilibiliTransport.ts:39 | dm/bilibili_transport/bridge_server.rs:485 | 各配置与配对/断开后 → `bili.transport.configure_validation`、`bili.bridge.pair_approve_disconnect` | — | 无 Err 分支 |
| media_bilibili_transport_configure | bilibiliTransport.ts:57 | bridge_server.rs:494 | native、browser_bridge（字符串与对象形式）、auto+https+proxyInAuto、无尾斜杠、空 proxy → `configure_validation` | `请先配置可信代理地址`、`代理地址无效`、`代理需使用无内嵌凭据的 HTTP / HTTPS 地址`（凭据、socks5、路径、query、fragment）、未知 mode、缺字段 → 同上 | — |
| media_bilibili_bridge_pair | bilibiliTransport.ts:54 | bridge_server.rs:509 | 配对、重复配对 → `pair_approve_disconnect` | — | 只剩端口绑定失败，不可构造 |
| media_bilibili_bridge_approve | bilibiliTransport.ts:55 | bridge_server.rs:523 | — | 未配对、配对后未知/空 connectionId（`配对请求已失效`）、断开后、缺参 → `pair_approve_disconnect` | 成功需要真实油猴脚本 WebSocket 客户端（owner X5/X7） |
| media_bilibili_bridge_disconnect | bilibiliTransport.ts:56 | bridge_server.rs:529 | 配对后断开、重复断开 → `pair_approve_disconnect` | — | 无可达 Err（只剩生命周期写失败） |
| media_bilibili_auth_status | learning-hub/apps/views/media/bilibiliAccount.ts:55 | dm/bilibili_auth.rs:461 | 未登录 → `bili.auth.logged_out_and_qr_key`；已登录 → `pending-network` `bili.live.qr_login` | — | 无会话时直接 Ok；有会话时网络错误也回 Ok |
| media_bilibili_logout | bilibiliAccount.ts:65 | dm/bilibili_auth.rs:529 | 未登录 → `logged_out_and_qr_key` | — | 已登录退出需联网会话（pending） |
| media_bilibili_login_qr_start | bilibiliAccount.ts:58 | dm/bilibili_auth.rs:488 | `pending-network` `bili.live.qr_login` | — | AuthClient 直连 passport.bilibili.com（绕过传输设置），离线错误会真实联网，不写 |
| media_bilibili_login_qr_poll | bilibiliAccount.ts:61 | dm/bilibili_auth.rs:500 | `pending-network` `bili.live.qr_login` | `登录二维码无效，请刷新后重新扫码`（空、过短、过长、含 `-`、含空格）、缺参 → `logged_out_and_qr_key` | 格式合法的 key 会联网，只放 pending |
| media_bilibili_cancel | bilibiliLinkApi.ts:230 | dm/bilibili_transport/session.rs:440 | 未知、空、刚失败的 taskId → `logged_out_and_qr_key`、`bili.link.network_refused_via_proxy` | 缺参 → `logged_out_and_qr_key` | — |
| media_bilibili_probe | bilibiliLinkApi.ts:198 | dm/bilibili.rs:1172 | `pending-network` `bili.live.probe_create_reimport` | `请粘贴 B 站视频链接`、番剧/课程/直播/音频（unsupported）、非链接/短 BV/av0（invalid-link）、page 负数、缺参 → `bili.link.parse_errors_offline`；代理拒绝（含 b23 短链）、`浏览器桥未就绪，请连接浏览器` → `network_refused_via_proxy`；page 越界 → pending | 成功需 B 站 mock（owner X5/X7，D-062） |
| media_bilibili_create | bilibiliLinkApi.ts:204 | dm/bilibili.rs:1212 | `pending-network` `probe_create_reimport`（新建与复用） | 空、unsupported、非链接、缺参 → `parse_errors_offline`；代理拒绝、桥未就绪 → `network_refused_via_proxy` | 同上 |
| media_bilibili_import_subtitle | bilibiliLinkApi.ts:217 | dm/bilibili.rs:1311 | `pending-network` `probe_create_reimport` | 链接条目+代理拒绝、空 input、不存在、缺参 → `offline_descriptor`；BV 不匹配 → pending | 同上 |
| media_bilibili_link_get | bilibiliLinkApi.ts:228 | dm/bilibili.rs:1353 | 离线描述符（id 与 resourceId）→ `bili.link_item.offline_descriptor` | `不是 B 站链接条目`（wav）、`不是有效的 B 站链接条目`（坏 bvid）、不存在、缺参 → 同上 | — |
| media_bilibili_stream_quality | bilibiliAccount.ts:198 | dm/bilibili_stream.rs:512 | `pending-network` `probe_create_reimport` | 链接条目+代理拒绝、非链接、不存在、`res_` 前缀、空、超长、`../`、`%2F`、缺参 → `offline_descriptor` | 成功需 B 站 mock |
| tts_check_available | utils/tts.ts:32 | src/tts.rs:25 | Linux 检测 espeak → `tts.check_speak_stop` | — | 无 Err 分支（各平台都返回 Ok） |
| tts_speak | utils/tts.ts:116 | src/tts.rs:59 | 中英法文、rate/volume、空文本 → `tts.check_speak_stop`（未标 expect：结果取决于 A 机器是否装 espeak） | 缺 `text`、rate 类型错 → 同上 | — |
| tts_stop | utils/tts.ts:130 | src/tts.rs:93 | 两次 → `tts.check_speak_stop` | — | 无 Err 分支 |
| test_pdfium_status | chat/debug/attachmentPipelineTestPlugin.ts:1296 | crates/dstu-docs/src/pdfium_utils.rs:192 | 诊断 map → `pdfium.status` | — | 加载失败也写进 map 返回 Ok，无 Err 分支 |
| convert_heic_to_jpeg | （见 WP-054） | src/heic_decoder.rs:78 | — | 见 WP-054 `heic.convert.json_body_rejected` | 成功只在 Android 插件可达；raw body 分支需运行器支持二进制调用 |

清单外、按任务要求补的错误场景（`docs-boundaries.json` `docs.boundaries.ipc_shape_errors`）：
`notes_export_docx` 缺 `spec`；`textbooks_add` 缺 `sources`、非数组、元素非字符串、`folderId` 类型错；
`vfs_get_file_blob_path` 缺 `id`、数字、null。`notes_export_docx` 的 DOCX 生成失败仍无可达输入；
`vfs_get_file_blob_path` 其余错误只有 DB 故障。

### 统计

- 43/43 条命令都出现在语料中。离线成功场景 35 条；只有 pending-network 成功场景 6 条
  （probe、create、import_subtitle、stream_quality、login_qr_start、login_qr_poll）；
  无成功场景 2 条（`convert_heic_to_jpeg`、`media_bilibili_bridge_approve`）。
- 有错误场景 31 条；无错误场景 12 条，原因见上表（10 条无可达 Err 或只有不可构造的故障，
  `media_bilibili_login_qr_start` 离线会联网，`get_ocr_engine_type` 只有 DB 故障）。

### 环境守卫（所有场景都遵守，不联网、无真实 key）

- **LLM**：配置里写 `"baseUrl":"${llm.baseUrl}"`，由 X5 runner（`host/e2e/streaming/wave0/runner.ts`）按
  `harness.sidecar.json` 换成本地 mock 地址。其他“故意失败”的配置指向 `http://127.0.0.1:9/...`（discard 端口）。
- **ASR 守卫**：上传音频前先保存 `w0-asr-guard`（custom、空 key、`authMode:none`、`http://127.0.0.1:9/v1`）并
  `save_model_assignments {voice_input_asr_model_config_id:"w0-asr-guard"}`。否则 VFS 上传后的自动转写可能用
  编译期内置的 siliconflow key 联网。守卫让自动转写停在 settings-required。
- **B 站守卫**：`media_bilibili_transport_configure` 设为 proxy `http://127.0.0.1:9/`、`proxyInAuto:false`，回退被拒
  （fixed-route）；场景结尾恢复 auto。AuthClient 不走传输设置，所以登录类命令只写格式校验错误。
- **B 站链接条目**：离线用 `vfs_upload_file` 上传 `*.bilibili` + `application/json` 的描述符 JSON 创建；
  `.bilibili` 扩展名使 `is_link_item` 为真（`video/x-bilibili` 不在 VFS MIME 白名单）。按 MIME 精确查找的
  `find_link_item` 找不到这类条目，复用分支只在 pending 场景里出现。
- **VLM**：配置模型 `glm-4.6v`（本地 baseUrl、isMultimodal），同时用 `save_available_ocr_models` 注册为 Tier0 的
  `glm4v_ocr` 引擎，内置厂商不会被选中。

### 跨域辅助命令与 seed owner

| 命令 | owner | 用途 |
|---|---|---|
| `save_api_configurations`、`save_model_assignments` | L02-llm-manager | LLM/VLM/ASR 配置与分配（snake_case 键） |
| `save_setting` | L19-mcp-browser | 写损坏的 `ocr.available_models`、`ocr.engine_type` |
| `vfs_upload_file`、`dstu_create`、`dstu_set_metadata` | L13-vfs-api | 媒体/链接条目上传；笔记与 `_origin`（`props._origin` 为 JSON 字符串）；题目集 |
| `qbank_create_question` | L14-qbank | 带 `[媒体@<rid>:mm:ss]` 出处的题目，供 checkpoints/ledger |
| `media_transcript_get` | L18（WP-054） | 转写运行后读结果 |
| document_tasks 卡片 seed | chatanki | `media_study_ledger` 卡片统计（未写） |

### 阻塞

- **B 站联网成功路径**（`pending-network/bilibili-live.json`）：probe/create/import_subtitle/stream_quality 成功、
  login_qr_start、合法 key 的 login_qr_poll、已登录 auth_status。地址在 Rust 里写死为 HTTPS 的 api.bilibili.com /
  passport，需要确定性 B 站 mock + CA 注入（owner X5/X7，D-062）。这两个场景录制时会联网，不能进默认运行集。
- **bridge_approve 成功**：需要一个连上配对端口的真实 userscript WebSocket 客户端（owner X5/X7）。
- **X5 脚本**：语音空转写需要一个返回空文本的自定义脚本（owner X5）。

### 风险

- `${llm.baseUrl}` 只有 X5 runner 支持；X7 `scripts/electron-migration/record/scenario-v0.mjs` 的 `resolveReferences`
  要求引用占满整个值，会拒绝它，也会拒绝 WP-054 用的 `${0}/w0-src/...` 拼接引用。本包未改 runner，需 X5/X7 统一。
- WP-054 `media-transcripts.json` 上传 wav 前没有 ASR 守卫，录制时自动转写可能用内置 key 联网。插入守卫会移动步骤
  下标、改变所有 `${1.file.id}` 引用，本包未改，需录制方确认网络隔离或另行修订。
- 转写与上传后的流水线是异步的：`start_cancel_scripted_asr` 的 start→cancel→get 顺序结果依赖时序，
  采 DB/事件前需静默屏障（同 WP-054）。
- `media_bilibili_bridge_pair` 返回随机端口与 challenge；`test_pdfium_status` 返回绝对路径。

### normalize 候选（未写入 JSON）

- 端口与 challenge：`media_bilibili_bridge_pair` 的 `url`/`scriptUrl`、`transport_status.bridge`。
- 路径：`test_pdfium_status` 的 `exe_path`/`exe_dir`/`candidate_*`。
- id：`file_*`、`res_*`、笔记/题目集/题目 id、taskId 派生的事件。
- 时间：`updated_at`、进度 `updatedAt`、`diagnostics` 时间戳、转写任务时间。
- LLM：X5 mock 的 origin（`${llm.origin}`，X5 已有规则）。
