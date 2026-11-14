# F7 原生需求汇总（2026-11-04 恢复）

来源：全部 `host/plugins/*/native-needs.md`，以及各 lane 的 SPEC/BLOCKERS/LANE 中的 F7 引用。
已合并 main；Linux 基线 `typecheck:host` 通过，native 的 14 文件 / 85 测试通过。
当前等待状态见本目录 LANE.md；权威行为记录是 `migration/spec/F7-native.md` 与
`migration/testmap/F7-native.md`。F7 尚未纳入 ledger，不自报 A/B 百分比。
以下“已提供”表示本工作分支的真实生产provider+测试路径，不表示已合入main；截至末次合并，
main已声明docx/pptxgenjs/sharp，PNG/JPEG已切至sharp，无需安装pngjs/jpeg-js；仍缺
@node-rs/argon2/tiktoken。协调者安装并集成
本分支后消费lane才可启用；新dstu.vector仍需生成进入官方profile。

| 需求 | 消费 lane | Rust 原实现（crate 与调用点） | 方案 / 导出 | 状态 |
|---|---|---|---|---|
| 图片解码、尺寸、RGBA | L18/L12/L01/L04 | image 0.24.9；media.rs、vlm_grounding_service.rs、file_manager.rs | 同 crate 预编译 WASI；`nativeImage.dimensions/decodeRgba` | 已提供；Linux 实测通过 |
| Lanczos3 / Triangle、裁剪、PNG/JPEG、质量与输出上限 | L18/L12/F3 | image 0.24.9；cmd/media.rs:91–111、vlm_grounding_service.rs:188–239,1501–1533、docx_handout.rs:103–119、file_manager.rs:74–163 | `resizeRgba`/`resizeDimensions` 移植 imageops f32；`encode`已改D5批准的sharp worker；`cropFigure`/`encodeJpegWithinLimit`/`resizeAndEncodeJpeg` | root编码缺包解除，Node/Electron各21项通过；Electron仍有GLib critical警告；不等于D5 PSNR/16-bit与完整DynamicImage签收 |
| 整数像素crop_imm | L18 | image0.24.9 crop_dimms；exam_sheet_service.rs:521–539,744–751 | `nativeImage.cropRgba(input:RgbaImage,bbox:ImagePixelRect):RgbaImage`；bbox为u32 x/y/width/height，非normalized endpoints | Node/Electron各5项通过；精确复制RGBA、边界clip、保留0尺寸、u32-max不溢出；PNG组合改用已批准sharp，D5门槛保持 |
| HEIC→JPEG | L18 | src/heic_decoder.rs：桌面校验后拒绝；Android 经 Kotlin Bitmap JPEG90/16MP，不是 libheif Rust crate | 保留 `convertToJpeg` 原桌面错误 | **架构师D5明确暂缓/不批准libheif-js**（decisions.md:129）；已撤回本轮未合入main的扩展与专属新增测试/样本；前端HEIC退化交架构师统一评估 |
| Office 文本/表格抽取 | L18/L11 | dstu-docs/document_parser.rs：docx-rs / calamine / umya-spreadsheet / zip / pptx-to-md / rtf | `nativeOfficeText`纯文本/CSV；`nativeOffice.extractText/extractPptxPages`（同crate WASI：docx-rs0.4.19/calamine0.26.1/pptx-to-md0.2.0/rtf-parser0.3.0/html2text0.16.7）；`nativeOfficeWriter.readXlsx*`真实xlsx codec | 8种格式文本抽取已提供，office-extract 19项通过（作业20261104154637-f2ea71）；**偏差**：pptx-to-md的zip去掉bzip2/zstd/xz特性（无WASI C工具链），此类压缩条目报UnsupportedArchive，架构师已接受；`extractTables`结构抽取仍未提供 |
| Office 生成/编辑与讲义 | L18 | src/chat_v2/tools/{docx,pptx,xlsx}_executor.rs、office_fidelity_executor.rs；docx-rs0.4.19 / ppt-rs0.2.14 / umya-spreadsheet2.3.3 | `nativeOfficeWriter.generateDocx/generatePptx/generateXlsx/editXlsxCells`；XLSX另有readSpec/tables/metadata/replace | D9批准docx9.15.2/pptxgenjs4.0.1，已切正式共享依赖并通过6项最小结构测试；DOCX/PPTX round-trip仍缺抽取器；没有把生成冒充编辑 |
| PDF 文本/页尺寸/RGBA | L18/L12/L11 | pdfium-render 0.9.4 / pdfium_7350；pdfium_utils.rs、page_rasterizer.rs、pdf_preview.rs | `nativePdfium.open/extractText`；原始 FPDF API | 已提供；npm 引擎为 chromium/7689，非7350，逐像素 C 级待核对 |
| PDFium 加载诊断 / 最小 PDF | L18 `test_pdfium_status` | pdfium_utils.rs:191–238,248–349 | 原候选路径报告 + 实际 WASM 加载/最小 PDF 解析；显式披露实际引擎，不假装加载候选 .so | 已提供 `nativePdfium.diagnostics()`；4 个 Linux 测试通过 |
| PDF JPEG/表单/页间取消 | L18/L11/L12 | pdf_ocr_service.rs、page_rasterizer.rs、pdfium-render 默认 do_render_form_data=true | JPEG已可用nativeImage.encode；表单需 FPDF 表单 API；页间取消由消费方循环实现 | JPEG已提供；FPDF表单渲染生命周期仍缺等价封装 |
| 脚本沙箱（7项 e2e） | L24，依赖 L05 后端 | chatanki_transform_script.rs；shell_sandbox.rs Linux/macOS模块 | `nativeSandbox.probe/spawn`：bwrap/Seatbelt、进程组/资源限制/env白名单/取消/reap；policy构造仍L05 | D9已装系统bubblewrap0.8.0/prlimit；本轮jobs最小Node/Electron测试已通过，未用临时解包环境变量；L05→L24公开适配器待接，macOS/Windows未目标验证 |
| Windows AppContainer / ACL / Job /进程树取消 | L05（5项 pending） | tools/shell_sandbox/windows.rs、local_shell_execute_executor.rs | `nativeWindowsSandbox`：profile/SID/DACL读写/CreateProcessW/SECURITY_CAPABILITIES/Job130s与128进程/整树取消；无AppContainer的`runFullAccessJob`（relaxed Job）与`acquireAclMutex(signal)` | 原生桥已提供；L05仍须实现ACL策略/保护子树/helper接线，不宣称完整Windows沙箱；未在目标平台验证 |
| Windows 文件 identity / opened-handle reparse / 原始 IO 文案 | L05/F4 | runtime_roots.rs:210–233,585–600,2039–2068 | `nativeWindowsFiles.runtimeRootIdentity/openRegularFileNoFollow/ioError`：CreateFileW/GetFileInformationByHandle/FormatMessage，u64 bigint；同handle `readAt(offset:bigint,maxBytes)`/`refreshInformation()` | 已提供代码及win32条件原测试；未在目标平台验证，不以Linux通过冒充Windows验证 |
| 系统 OCR | L01/L04 | dstu-llm/ocr_adapters/system_ocr：macOS Vision / Windows.Media.Ocr | 依 L01 `SystemOcrNativeBinding.performSystemOcr` 契约提供原平台调用；Linux 原实现不支持 | 尚未提供；macOS/Windows 未在目标平台验证 |
| Lance 固定维 schema / CRUD / scan / FTS / index / optimize | L12/L17 | lancedb 0.22.1 / lance 0.37；vfs/lance_store.rs、lance_vector_store.rs | `dstu.vector` provider；createTableWithSchema/query/search/fullTextSearch/schema/addColumns/createIndex/optimizeAll | 已提供，真实磁盘/Int64/CJK-FTS测试通过；L12须用其业务schema接入新API；独立Compact/Prune/Index仍缺npm binding，不能伪用all |
| FSRS-6 推理 | L15 | fsrs =6.6.2 inference.rs/model.rs | `nativeFsrs.nextStates/memoryState`，f32 移植 | 已提供；crate 向量逐位通过；样本集抽检 2.2% 有 ≤13 ulp 差，架构师裁定为已知偏差（Rust 桌面 libm 三平台本就不一致），测试断言 ≤16 ulp |
| FSRS 参数训练 / evaluate | L15 | fsrs =6.6.2 compute_parameters / evaluate；fsrs_review_service.rs:4074传card_ids | `nativeFsrs.optimize(input)` / `evaluate(params, items)`：同 crate `fsrs =6.6.2` 编入 F7 WASI | 已提供（2026-11-05 重建，作业 20261104193343-0fb691）；crate 自带 evaluate/compute_parameters 测试通过 |
| Starlark / regex | L07/L05/L10/L16/L24/notes | starlark 0.14.2、regex 1.12.3 | `nativeStarlark.evaluate`、`nativeRegex`，同 crate WASI worker | 已提供；worker中途取消/挂起宿主call取消可用，不再阻塞Host；终止粒度与Rusttick边界有差别 |
| 全文captures有界替换、首超限bytes | L24 / C1 / R5 | chatanki_transform.rs:466–594；regex1.12.3 captures_iter + expanded_replacement_len + add_projected_bytes | `nativeRegex.replaceAllProjected(pattern,text,replacement,limitBytes)`，Rust 原码复制、u64 计数 | 已提供（2026-11-05 重建）；L24 验收表 8 条通过（第 3 条 bytes 应为 6） |
| 音频解码/重采样 | L18 | Symphonia 0.5.5；media/decoder.rs、resample.rs | `nativeAudio.probe/decodeToMono16k/createResampler`，同 crate WASI worker | 已提供；可中途abort并等worker退出，非每packet停止；进度数值顺序保留但仍在解码后回放 |
| Tokenizer | L03/L02 | tiktoken-rs；utils/token_budget.rs | `tiktoken@1.0.22`同发布方原始Rust/WASM核心；`nativeTokenizer`接口不变 | 原4条Rust测试完整输入/断言通过；200K重复字符约494ms；需新生产依赖，不改采样阈值或算法 |
| 试卷图片Triangle/JPEG与分阶段错误 | L02 | dstu-llm/llm_manager/exam_engine.rs:350–394 | `nativeImage.resizeTriangleJpeg(bytes,maxWidth,maxHeight,quality)`；`ImageOperationError.stage`区分decode/encode | 已提供代码/尺寸与错误测试；同其他图片路径，D5要求Rust输出PSNR与容差证据后再签收，≤1.5MB原样分支仍由L02负责 |
| prost / gzip / zstd | L18/L16/L23 | prost 0.13 / flate2 / zstd；bilibili_transport/grpc.rs、apkg_importer_service.rs | `nativeProtobuf`、`nativeCompression` | 已提供 |
| DSBK Argon2id 加速 | F4/L21 | argon2 v0x13；crypto/backup_crypto.rs，64MiB/t3/p4 | `nativeArgon2.deriveKey`，@node-rs/argon2@2.2.2；全参数显式、raw字节同noble | Node/Electron逐字节通过；Electron native113ms vs noble7563ms；需新生产依赖与F4接线 |
| 导图 XML 解析（D29/WP-058） | L13 `mindmap_import` | roxmltree 0.20.0 `Document::parse`；builtin_resource_executor.rs:3252,3437,3822,3944 | `mindmapXml.parse(text): MindmapXmlNode`（同步，类型取自 L13 api），同 crate WASI op `xml.parse` | 已提供（WP-095 增量构建 20261105165453-467913）；超过约 3000 层嵌套时栈溢出抛错（SPEC「WP-095」已知偏差）；L13 真实消费待合 main 后由 L13 复验 |
| SQLite busy handler（D17/D-022/WP-085） | F3 → L20b S06 | rusqlite 0.40.1 `Connection::busy_handler`；dstu-sync state.rs:626-657 | `nativeSqliteBusy.setBusyHandler(db, handler\|null)`（handler 抛错按 false，同 busy.rs:60，不重抛；WP-161），同一 better-sqlite3 连接经其 `loadExtension` 装 `sqlite3_busy_handler`（`sqlite-busy/busy_handler.c`） | linux-x64 已提供（WP-161 后 Node/Electron 各 13 passed，SPEC「WP-085」）。**2026-11-07 主代理决定：仅测试用**，生产只用 `busy_timeout` + `BEGIN IMMEDIATE`（Rust 的 busy_handler 只在 `#[cfg(test)]`），S06 生产路径不接线；darwin-arm64 测试预编译由 W06 补；守卫 `tests/sqlite-busy-production.test.ts`，见 `host/platform/API.md`「sqlite busy」 |

## 接入通知

现有导出不变，新增完成项逐次在此登记；本 lane 不越界改消费方接线。
L18 可调用 `nativePdfium.diagnostics(): Promise<Record<string,string>>`；返回原命令键，
另有 `engine` / `engine_path` 说明真实 WASM 引擎（不宣称候选 .so 已加载）。
L18/L12 图片可调用 `nativeImage.resizeRgba/resizeDimensions/encode/cropFigure/encodeJpegWithinLimit`。
`encodeJpegWithinLimit` 接受调用点的质量序列，不会返回超限末次结果。新增生产依赖
不再需要 **pngjs@7.0.0 / jpeg-js@0.4.4**；本轮已按架构师转L18请求切至D5批准的sharp。
sharp在Electron仍产生GLib-GObject critical警告，如实保留，不以测试exit0当“无警告”。
尚无Rust实产物PSNR，不申请把相关测试标ported。没有修改根包文件。
L18 HEIC：最新D5否决了后端桌面扩展，本轮新增decodePrimary/convertDesktopToJpeg已撤回，
**不要安装libheif-js**；继续使用原 `convertToJpeg` 的桌面错误行为。
L18 DOCX 导出 `nativeOfficeWriter.generateDocx(spec)`；D9已批准生产依赖 **docx@9.15.2**（MIT）。
与 docx-rs 相同的结构/字体/页边/图注/最大边与版心EMU，ZIP打包字节不要求相同。
L18 同服务新增 `generatePptx(spec)` / `generateXlsx(spec)`；新增生产依赖
**pptxgenjs@4.0.1**（MIT）已获D9批准并共享安装；现有 **exceljs@4.4.0** 无需新增。
核实本lane的office/node_modules不是链接后已移除它（含未使用的XML调查包），实际导入现在解析到
共享docx9.15.2/pptxgenjs4.0.1；未删除或覆盖共享node_modules。编辑仍不能用生成接口冒充。
L18 另可调用 `editXlsxCells(bytes, edits)` 返回 `{bytes,editCount}`；须先执行其容器/保真度安全门禁。
XLSX另增 `readXlsxSpec/readXlsxTables/readXlsxMetadata/replaceXlsxText`，后者返回
`{bytes,replacementCount}`；原XFD1048576稀疏替换测试经真实provider通过，不做dense扫描。
这些是编解码接缝，不代替L18的file-size/encryption/ZIP-bomb/fidelity安全门禁。
L12/L17：`host/platform/vector/index.ts` 默认插件已发布。`createTableWithSchema(name,columns)`
不复制业务schema；`query`支持无向量扫描，`search`现支持bypass/refine，`fullTextSearch`返回原始_score。
请L12适配其 `lance-engine.ts`（原来探测的createTable(name,dimension)/ftsSearch与低层返回不同）。
协调者需重生成 `host/profiles/desktop.json` 接入新 `dstu.vector`；依赖均已安装，无新增npm包。
L05/L24：`nativeSandbox` 接收已构造的bwrap/Seatbelt命令描述符并等待真实spawn；
L05须在公开api.ts提供其policy/backend适配器，L24的同步spawn契约需包装此异步底层启动。
Windows接口见 `windows/api.ts`、`windows/sandbox-api.ts`；不复制L05的ACL策略/业务payload。
F3：已按 `storage/native-needs.md` 追加 `resizeAndEncodeJpeg`，有1200×900→768×576测试；
当前编码器是sharp而非其要求的同crate WASI，不能据此把F3原测试直接标完整等价。

L18/L11 `nativeOffice.extractText(fileName, bytes)` 现支持 docx/xlsx/xls/xlsb/ods/pptx/rtf/html 全部 8 种格式（`formats` 即此 8 项），由与 src-tauri 相同版本的 crate 编译进 F7 WASI 模块；`OfficeEngineUnavailableError` 已删除，错误统一 `OfficeParsingError`，新增 kind `IoError`（`IO错误: …`）。文件大小/加密/ZIP 炸弹门禁仍由 L18 先执行。

2026-11-05：L15 可调用 `nativeFsrs.optimize({trainSet, cardIds, enableShortTerm, numRelearningSteps}, {signal})` 与 `nativeFsrs.evaluate(parameters, items)`，错误为 `FsrsError`（message 即 `FSRSError` 的 `{:?}`）。L24 可调用 `nativeRegex.replaceAllProjected`。L18 可调用 `nativeOffice.extractDocxStructured/extractDocxTables/extractDocxMetadata/extractDocxAsSpec/extractPptxMetadata`（门禁仍由 L18 先执行）。

## 新合入的消费者补充

L13b `vfs-handlers/native-needs.md`：PDF preview依赖L11的AttachmentProcessingAdapter接线。
F7已有PDFium与JPEG底层；预览blob引用/事务/资源表写入必须由L11负责，F7不越界直接写表。
F4/L21可接 `nativeArgon2.deriveKey`：新增生产依赖 **@node-rs/argon2@2.2.2**（MIT），
Electron45.2.1已验证，F4现有参数上限/DSBK错误包装/密码清零保持原位，不需要改容器格式。
L03/L02 tokenizer接口不变，新增生产依赖 **tiktoken@1.0.22**（MIT）；这是js-tiktoken同发布方
的Rust/WASM核心，不是不同算法。纯JS的连续CJK性能失败已解决，原完整Rust测试已恢复。
L02按最新 `llm/native-needs.md` 提供 `resizeTriangleJpeg`；decode/encode原始文案保留，
消费方根据导出的 `ImageOperationError.stage` 包装“加载试卷图片失败”/“压缩试卷图片失败”。
新 npm 包由协调者写入根 package.json/package-lock.json；工作树 node_modules 是共享链接，
不向该链接安装包，避免间接改主仓库。

## 本分支依赖安装清单（精确验证版本）

`docx@9.15.2`、`pptxgenjs@4.0.1`、`sharp@0.34.5`（root范围^0.34.2）、
`@node-rs/argon2@2.2.2`、`tiktoken@1.0.22`。已撤回pngjs/jpeg-js生产依赖请求，编码不再使用。
最新main已声明 `docx:^9.15.2`、`pptxgenjs:^4.0.1`；此两项不再是缺包阻塞，
sharp已批准且共享可解析；仅argon2/tiktoken还需协调者安装/批准，正式锁版本以本表精确版本为准。
不要安装被D5否决的libheif-js；FSRS历史beta仅作静态调查，不列为生产依赖。
fast-xml-parser仅作Office路线调查，生产未使用，不请求安装。
Linux已按D9安装系统bubblewrap/prlimit；早期临时解包记录仅为历史，本轮用默认/usr/bin/bwrap验证。
Windows/macOS真实运行待对应runner，不凭Linux结果签收。

## C2指令1–7增量回执（全局jobs，不复跑全套）

- 新增L18整数像素接口：`cropRgba(input,{x,y,width,height})`不round、不归一化、不交换反向端点；
  直接Rust crop_dimms的clip，零尺寸交L18按create/adjust各自原文拒绝。公开类型ImagePixelRect。
- PDFium的`diagnostics():Promise<Record<string,string>>`已在公开api.ts，不仅存在于实现。
  不提供pdf@1别名；业务lane仍需组装其PdfStageRuntime与业务错误包装。
- 已通过coord信箱向L12/L17发送精确vector签名与差异，向C2发送依赖阻断/当前接口回执。
  都明确“ds-mig/F7-native分支已实现、尚未合main”，没有以声明存在签收main消费者。
- vector真实1792/2560维读写/错维拒绝新增定向测试；不是只把2维测试的表名叫1792。
- 新作业结果（result原始exit，无Errors/Unhandled）：

| 作业 | 范围 | result |
|---|---|---|
| 20261104071241-72c49f | merge后的基线typecheck:host | exit0 |
| 20261104071756-ab86f0 | crop新增后的typecheck:host | exit0 |
| 20261104071616-5c130f | Node image-crop.test.ts | 5 passed，exit0 |
| 20261104071617-c8597a | Electron image-crop.test.ts | 5 passed，exit0 |
| 20261104071755-c2ff13 | 共享依赖Office生成/讲义2文件 | 6 passed，exit0 |
| 20261104072032-9b559b | 系统bwrap默认路径Node sandbox | 2 passed/1 macOS skipped，exit0 |
| 20261104072032-c86741 | 系统bwrap默认路径Electron sandbox | 2 passed/1 macOS skipped，exit0 |
| 20261104072356-504ba1 | 独立实际namespace probe | available:true，program:/usr/bin/bwrap，exit0 |
| 20261104072237-758916 / 20261104072237-35253a | 新增实际1792/2560维回归首次Node/Electron | 各1 failed/2 passed，exit1；JS Arrow静默接受错维，未删改失败断言 |
| 20261104072942-b73f74 | schema错维校验修复后Node vector.test.ts | 3 passed，exit0 |
| 20261104072942-029166 | schema错维校验修复后Electron vector.test.ts | 3 passed，exit0 |
| 20261104072942-82b46d | vector修复后的typecheck:host | exit0 |
| 20261104073438-a3f327 | 合并main后最终typecheck:host | exit0 |
| 20261104073438-07e65c | 分支隔离环境native/vector入口importable | importable: ok，exit0；不等于root缺包解除 |
| 20261104073438-42ae73 | strict边界 | exit1，全仓VFS四项，F7零违规行 |
| 20261104073438-8ce5fe | ledger --check --no-write | exit0，commands/tests/orphan problems均0 |
| 20261104073438-51a049 / 20261104073438-ff68c8 | native/vector wiring | 各exit0；F7手工表不在扫描器覆盖内，不虚报完整覆盖 |

以上裁剪/PNG组合仍加载本lane的私有tiktoken/pngjs候选，明确不是正式依赖集成成功。
vector入口只依赖已批准LanceDB/Arrow，无上述四个新包依赖；错维长度在整批write前检查，
错误给出列/expected/got，mixed batch末行错维也不写入前面的合法行。不是改变L12业务校验。
实际root依赖解析：docx/pptxgenjs/sharp存在；tiktoken/pngjs/jpeg-js/@node-rs/argon2为MODULE_NOT_FOUND。
已向L18、L05、L24、L15逐条发送crop/Office、沙箱公开接口与FSRS精确缺口通知；
向L12发送实际维度回归修复与Int64保持bigint的补充。已上报架构师：
`2026-11-04T074046118Z-F7-native.md`，内容为四依赖的待裁定状态与FSRS6.6.2+card_ids
预编译缺口；未自行运行Rust或安装共享包。没有新增后端HEIC入口或修改前端/契约。

本单元ledger原始最后一行（作业20261104073438-8ce5fe，exit0）：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

本单元两个wiring作业原文均为：

```text
合计 ported 0，其中所测模块未从 index.ts 接入 0（0%）
```

strict作业四个未豁免违规均是host/plugins/vfs/repository/{create,folders,resources,update}.ts，
native/vector无违规行。原始summary（exit1）：

```text
boundaries: scanned 2308 files, 4 violation(s) {"empty-catch":3,"console-log":1}, 176 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

以下旧“本次交付检查”保留为先前全套检查快照，不替代本单元jobs结果。

## 集成门禁修复与C2 v2 review返工

- R1独立复现（main，作业20261104131022-87fc5b，exit1）：唯一失败是tokens_command.test.ts，
  原因是`Cannot find module 'tiktoken'`，调用点tokenizer/index.ts:19；root只有js-tiktoken@1.0.21。
  这与本节所述一致：首次调用加载只把失败推迟到调用时，不是可用能力。F7不加估算降级，
  也不以私有NODE_PATH作签收；等待架构师把tiktoken@1.0.22接入root。

- 保留：tiktoken首次调用时加载（真实MODULE_NOT_FOUND，无fallback）。干净树（无私有包）
  作业20261104112647-595335显示suite导入失败已消失，剩20条测试因四包MODULE_NOT_FOUND失败，exit1。
- 已撤销：`NativePdfium.diagnostics?`可选（契约恢复为必需；只需子集的consumer自行用Pick类型）
  与缺包`it.skipIf`。此前113 passed/23 skipped（20261104113642-4bd207）不作为门禁证据。
- 因此本分支在root缺四包时门禁仍不通过：vitest 20条缺依赖失败，typecheck仍有L11/L12替身
  TS2741（归consumer修改）。四包裁定在架构师，不安装、不改root。
- 撤销后作业：typecheck 20261104120151-f753b1 exit2，仅3条consumer替身TS2741
  （vfs-index pdf-runtime/unit-source、vfs-repos attachment-processing），F7零错误；
  本工作树（lane私有包，仅分支验证）6个受影响文件 20261104120151-5dc5c1 34 passed，exit0。

## C2 08:17全文捕获增长闸门核查（当前新增任务）

- 仅处理本项，未重做crop/vector/依赖请求。已合并main，逐行读Rust466–594及F7
  `regex/api.ts`/`index.ts`、`wasm/src/regex_engine.rs`、WASI入口分派。
- 当前预编译JSON op面没有`captures_iter`、`captures_at`或`replace_all_projected`；
  只能获取首个完整captures，不能由findIter返回的整段text恢复后续可选/命名组。
  编译器产物记录是现有regex1.12.3的`f7-native-wasm.wasm`；没有重编或改写它。
- 最小绑定请求与协议shape已经列在migration/spec/F7-native.md对应小节；请求
  `replaceAllProjected(pattern,text,replacement,limit)`的**将来**返回形状为
  `{ok:true,value,bytes}` 或 `{ok:false,bytes}`。现在没有声明/注册该方法，不能按
  “api存在”报已交付，更不能让L24 fallback的最终bytes假冒Rust首超限bytes。
- limit由L24给出`max(1MiB,utf8Len(before))`；引擎应对完整原文captures_iter，依次检查
  每个gap与展开长度，再检查tail，每个累计严格`>limit`即返回。失败不得调用replace_all，
  成功才物化。保留Unicode字节、$引用、usize解析和饱和加法；组下标不能经过有损Number。
- 新op还须显式保持桌面64位计数：现产物是wasm32，不能把原`usize`直接搬入导致2^32-1
  提前饱和。投影/reference解析用u64，在实际组索引有效时才转本地usize；详见SPEC的
  2MiB×2048投影向量（应返回4294967296，未运行任何4GiB无界替换）。
- 需要获授权维护方在同regex1.12.3产物中暴露此单个op，随后F7才可发布真实公共实现。
  captures_iter完整组迭代也是能力来源，但跨JSON一次性返回全部groups不是优先方案，
  会额外物化所有捕获；推荐在原生请求内边迭代边检查，按首超限提前退出。
- 当前只追加两条现有公开API的完整原文边界/可选组/命名组/零宽/Unicode证据测试；
  不标有界替换ported，不执行大输出炸弹，不引入JavaScript正则或任何替换fallback。
  无Rust运行/编译、新包安装、生产API或产物变化。

## 本次交付检查与未签收项（2026-11-04）

- Node26.5与Electron45.2.1各26文件、125 passed / 3平台条件skipped，退出码均0，
  两份完整日志无Errors/Unhandled行；macOS Seatbelt、Windows files、Windows AppContainer
  的目标测试在Linux条件跳过，明确“未在目标平台验证”。
- `typecheck:host`退出0；native/vector入口`importable: ok`。
- strict退出1：全仓14项（empty-catch13/console-log1），均在sync/vfs；native/vector无违规行。
- F7不在ledger的F_LANES且没有生成IPC契约，A/B无法计算，不用全仓比例冒充本lane完成度。
- TESTMAP显式表格：ported41、merged0、obsolete0、partial0、消费方8、非本lane配置未移植1。
  表外另登记DOCX3项和PDF候选2项；图片6项按D5保持pending，Windows目标验证未签收。
  不把未注册的全格式nativeOffice或FSRS优化器计为ported。

交付检查ledger快照原文（exit0；全仓在其他lane集成后仍会变化）：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 77.3% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

两个wiring命令（native/vector各自exit0）原文均为：

```text
合计 ported 0，其中所测模块未从 index.ts 接入 0（0%）
```

该0不是F7服务全部覆盖证明：扫描器不读取手工migration/testmap/F7-native.md；
实际接线证据是createTestHost安装真实provider的测试，不虚报wiring已计算全部F7测试。

未签收项及证据：

1. **协调者依赖/集成门槛**：main尚缺pngjs7.0.0/jpeg-js0.4.4/argon2 2.2.2/tiktoken1.0.22；
   仅本工作树私有node_modules验证。新dstu.vector未入官方profile；各消费lane尚无新增API调用。
2. **FSRS原生依赖缺口**：beta.2的6.6.2数学绑定无cardIds入参，而
   fsrs_review_service.rs:4074必须传Some(card_ids)；beta.3/稳定版的Adam/L2已改变。
3. **Lance原生依赖缺口**：0.22.1 Node NativeTable.optimize仅有all，未暴露Rust独立
   Compact/Prune/Index；不能通过把compact映射all绕过。
4. **Office原生解析能力缺口**：全格式nativeOffice仍未提供，尤其docx-rs read_docx的
   结构/修订/样式默认值、pptx-to-md的markdown分派与RTF/ODS/XLSB/XLS解析没有等价引擎。
   已提供的xlsx结构codec不伪装成calamine所有格式；DOCX/PPTX替换依赖其read-as-spec引擎。
5. **PDFium原生导出/动态证据缺口**：npm wrapper缺完整form-fill生命周期；7350资源仅
   有dll/dylib/Android so，当前Linux无7350引擎。D5要求两版本代表PDF golden后才签收。
6. **D5明确暂缓**：libheif-js后端扩展已撤回；桌面HEIC继续原校验错误，不请求依赖。
7. **D5图片动态门槛**：无Rust image编码/缩放实产物用于PSNR，且本轮禁止运行Rust；
   六项图片等价测试保持pending，不自设容差冒充实测。RGBA16/浮点DynamicImage路径也未覆盖。
8. **跨lane接缝**：L05尚无公开sandbox policy/backend适配器；L24的同步spawn契约需
   接真实异步nativeSandbox；Windows ACL策略/保护子树/helper由L05拥有，原生调用桥不替代策略。
9. **其他原生平台能力**：系统OCR仍缺Vision/Windows.Media.Ocr绑定（L01 native-needs.md）；
   无Linux等价实现，不返回假文本。Windows/macOS目标测试须在对应runner运行。
10. **音频进度语义**：已消除同步WASI阻塞/中途取消缺口，但进度仍解码后按原序回放；
    需要引擎暴露实时progress/PCM宿主回调才能实现Rust逐包交付，当前WASI文件协议未暴露。

保留的Rust行为/歧义：JPEG源码h/v=1（实际4:4:4）而注释写4:2:2，以源码为准；
XLSX生成的行数off-by-one/首表名不校验/后续表名仅精确重复检查保持原样；
不修改Rust或前端。没有把修复TS语义偏差称为修复Rust缺陷。

## 2026-11-04 夜接管批次1

- （已取代）`nativeImage.encode` 曾按 D10 使用 pngjs/jpeg-js；2026-11-05 起按 D12 改为 F7 WASI 内的同 crate image 0.24 编码，
  接口不变，消费方无需改动；pngjs/jpeg-js 可从 root package.json 移除（需架构师操作，本 lane 无权限）。
- DOCX 讲义 `picture()`：base64/解码失败按 Rust `.ok()?` 静默退化为 `[alt]`/`[image]`；PNG 编码失败抛
  `DOCX 图片 PNG 编码失败: …`（不再把缺包等引擎故障静默成 `[image]`）。
- **L18：`ctx.nativeOffice` 已 provide**。`extractText(fileName, bytes)`，docx/rtf 可用；`formats` 给出可用格式，
  其余（pptx/xlsx/xls/xlsb/ods/html）抛 `OfficeEngineUnavailableError`。错误为 `OfficeParsingError`（`kind`/`detail`，
  `message` = Rust ParsingError Display）。`extractTables` 已从接口移除（无实现，不保留伪声明）。
- 批次2：pptx 已加入 `nativeOffice.formats`；另有 `extractPptxPages(bytes)` 对应 `extract_paged_text_from_bytes` 的 pptx 分支。
