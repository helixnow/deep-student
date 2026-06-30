# 代理 3 状态文档 —— 文档解析与阅读

## 任务目标

全面深入审阅"文档 → 图像 → OCR → 结构化"整条处理链及 PDF/DOCX 阅读器界面,识别 bug/性能/安全/体验问题;在职责域内实施低风险优化(每改必验证),高风险方案登记待用户确认。

职责域(摘自 agent-3.md):
- 后端:`document_parser.rs`、`pdf_ocr_service.rs`、`pdfium_utils.rs`、`pdf_protocol.rs`、`ocr_adapters/`(6 引擎)、`deepseek_ocr_parser.rs`、`ocr_circuit_breaker.rs`、`page_rasterizer.rs`、`figure_extractor.rs`、`cross_page_merger.rs`、`vlm_grounding_service.rs`、`llm_structurer.rs`、`multimodal/`
- 前端:`features/pdf/`、`components/ImageViewer.tsx`、`ImageCropDialog.tsx`、`ExamPageImage.tsx`、`CroppedExamCardImage.tsx`、`DocumentViewer.tsx`、`hooks/usePdfLoader.ts`、`usePdfProcessingProgress.ts`
- 不归属:向量化入库/检索(代理 2)、试卷切题业务(代理 4)、阅读器聊天面板(代理 1)

## 当前状态

**Unit A~I 全部审完**,三批修复全部落盘:第一批(A1/A2/B2/B3/C1/C3)、第二批(E1/F1/F2/F3)、第三批(G2/G4 后端 + H1/H2/H3/I2/I3/I4 前端)。前端验证已过:`npm run typecheck` 本组文件 0 错误(现存 4 个错误全在 anki/cardforge,域外,见 X7);改动文件 ESLint 0 错误。后端 `cargo check` 与 `npm test` 后台运行中(其他代理并发编译,曾两次因 LNK1104/会话回收中断)。剩余工作:等验证结果 → 写总结汇报。最后更新:2026-06-13 00:05

**验证注意**:23:05 起多次 `cargo check` 报 LNK1104(`zerofrom_derive/time_macros/serde_derive` 等 proc-macro DLL 无法打开)——疑似磁盘满事件损坏构建产物 + 其他代理并发编译锁文件;若最终仍 LNK1104,需删除 `target/debug/deps` 中对应 dll 重建(已删 incremental 缓存)。

**重要环境事件**:E 盘曾满(0 字节),导致一次写文件把 `ocr_adapters/deepseek.rs` 截断为空;已用 `git checkout` 恢复(该文件当时无未提交改动,无损失),并删除 `src-tauri/target/debug/incremental`(33.7GB 增量编译缓存,可自动重建)释放空间,现 E 盘约 55GB 可用。其他文件经 diff 核对完好。

## TODO 计划

按风险优先级分审阅单元(每单元:通读 → 记录发现 → 域内低风险修复 → 验证):

- [x] **Unit A — pdf_protocol.rs**(14KB):自定义协议安全(路径校验、越权读取)
- [x] **Unit B — pdfium_utils.rs + page_rasterizer.rs**(27KB):pdfium 内存管理、大 PDF 句柄释放、光栅化
- [x] **Unit C — ocr_adapters/ 6 引擎 + ocr_circuit_breaker.rs + deepseek_ocr_parser.rs**(~100KB):错误分类/超时/重试/熔断阈值一致性
- [x] **Unit D — pdf_ocr_service.rs**(58KB):OCR 调度、失败降级链路(引擎切换与用户感知)
- [x] **Unit E — document_parser.rs**(151KB):按格式(PDF/DOCX/PPTX/XLSX/EPUB/...)分段审阅,畸形文件 panic/OOM 风险
- [x] **Unit F — figure_extractor.rs + cross_page_merger.rs + llm_structurer.rs + vlm_grounding_service.rs**(65KB):图表提取/跨页合并正确性(截断、重复、错位)、VLM 定位
- [x] **Unit G — multimodal/**(~230KB):图片/混合输入处理(注意 vector_store/retriever 与代理 2 的边界,只审不轻改)
- [x] **Unit H — 前端阅读器 features/pdf/**(~120KB):大文档翻页性能、页面缓存、内存;选区→聊天注入完整性;页码引用跳转准确性(OCR 页码 vs 渲染页码)
- [x] **Unit I — 前端图像组件 + DocumentViewer + hooks**(~85KB):DOCX/PPTX 预览 XSS 防护(DOMPurify 覆盖)、图像查看/裁剪
- [ ] 汇总:发现统计、已修复清单、待用户决策项,最终汇报(等 cargo check / npm test 结果)

## 审阅发现

| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|-----------|------|--------|------|------|
| A1 | pdf_protocol.rs:207-232 | 性能/安全 | 中 | Range 路径无响应大小上限:`bytes=0-` 会把整个 PDF(可达数百 MB)一次 `vec![0u8; len]` 读入内存,OOM 风险;无 Range 路径反而有 4MB cap | 已修复(Range 单次响应 cap 8MB,返回实际 Content-Range,HTTP 合规) |
| A2 | pdf_protocol.rs:29-30 | 安全 | 低 | CORS origin 校验 `starts_with("http://localhost")` 会放过 `http://localhost.evil.com` 这类域名 | 已修复(精确匹配 host 或带端口前缀) |
| A3 | pdf_protocol.rs | 体验 | 低 | HEAD 请求按 GET 处理,仍读取并返回完整 body(浪费 IO) | 建议(不改:pdf.js 不发 HEAD,改动收益小) |
| B1 | page_rasterizer.rs:render_pdf_pages | 性能 | 中 | 全部页面 JPEG 先驻留内存再入库:300DPI 下每页 1~3MB,500 页 PDF 峰值可达 0.5~1.5GB(与注释"渲染后立即释放"不符) | 待用户决策(改为边渲染边入库需调整两阶段结构,属中风险重构;调用方 question_import_service 在 spawn_blocking 中整体调用,直接改安全) |
| B2 | page_rasterizer.rs:convert_docx_to_pdf_windows | bug/体验 | 中 | Word COM 转换未设 `DisplayAlerts=0`、`Documents.Open` 未禁用对话框,损坏 DOCX 可能弹出隐藏对话框导致 `output()` 永久阻塞(无超时) | 已修复(加 DisplayAlerts=0 + Open 参数加固) |
| B3 | page_rasterizer.rs:rasterize_images:236 | 性能 | 低 | 仅为取尺寸就 `image::load_from_memory` 全量解码大图 | 已修复(改用 `into_dimensions()` 只读头部) |
| C1 | ocr_adapters/deepseek.rs + deepseek_ocr_parser.rs:parse_deepseek_grounding | 性能 | 中 | 扫描循环最坏 O(n²):响应不含 `<|ref|>` 或标记残缺时 `pos += 1` 逐字节重扫剩余全文;8K token 响应可烧数秒 CPU,批量页面放大 | 已修复(无标记→break,残缺标记→跳过该标记继续,O(n)) |
| C2 | ocr_adapters/system_ocr/windows.rs:77 | bug | 中 | `OcrResult.Text()` 把所有行拼成单行(行间空格连接,待实测确认),丢失换行结构,注释却称"已由换行符分隔";影响下游分块/索引质量 | **待用户决策**:正确修法是遍历 `OcrResult.Lines()` 以 `\n` 连接,但 windows crate 0.58 的 `Lines()` 方法被 `Foundation_Collections` feature 门控,需在 Cargo.toml 的 windows 依赖 features 中加一项(不引入新 crate,仅加 feature)。属构建配置改动,等用户同意后实施 |
| C3 | ocr_circuit_breaker.rs:HalfOpen | bug | 中 | HalfOpen 的 `probe_in_flight=true` 后若调用方在 allow_request 与 record_* 之间提前返回/被取消,探针永久泄漏 → 该引擎所有请求被永久拒绝(无探针超时) | 已修复(probe 增加 30s 超时,超时后允许新探针) |
| C4 | ocr_adapters/paddle.rs + types.rs | 坏味道 | 低 | `supports_grounding()` 对 Paddle 返回 true,但 build_prompt 注释明确"不原生支持 grounding",实际靠 JSON/DeepSeek 风格输出碰运气,Structured 任务降级到 Paddle 时拿不到坐标 | 待观察(看 pdf_ocr_service 引擎排序逻辑后定) |
| C5 | ocr_adapters/deepseek.rs:parse_bbox_array | 坏味道 | 低 | `[[box1],[box2]]` 多框只取第一个,多区域 ref 丢框(与旧 parser 行为一致,有注释说明) | 建议(保持现状,登记备查) |
| E1 | document_parser.rs:check_zip_bomb_recursive | 性能 | 中 | 嵌套 ZIP 检测对每个非空条目完整 read_to_end(等于为做检查把整个 DOCX/XLSX/PPTX/EPUB 全量解压一遍),且每个条目重新打开归档、重新解析中央目录 | 已修复(复用归档 + 先读 4 字节魔数预筛,命中才完整解压) |
| E2 | document_parser.rs 整体 | - | - | 其余通过:加密检测(PDF /Encrypt 取最后出现位置+EOF 启发式、Office EncryptedPackage)、ZIP bomb 阈值(压缩比 100:1/单条目 500MB/总量 2GB/条目数 1 万/深度 3)设计合理;TXT/CSV 已有 GB18030/Big5/SJIS 编码探测;表格切片有 5 字节守卫防越界;unwrap 几乎全在测试代码 | 通过 |
| F1 | figure_extractor.rs:extract_figures | 性能 | 低 | 每张配图都 clone 整页 PNG(数 MB);尺寸校验完整解码裁切结果 | 已修复(HashMap entry API 借用缓存 + into_dimensions 只读头部) |
| F2 | cross_page_merger.rs:merge_pages | bug | 中 | 续接合并只要 result 非空就并入最后一题:中间页 VLM 分析失败(None)或上一页无题目时,续接文本会错误拼接到隔页的无关题目上;同页多续接块还会重复 push page_idx | 已修复(限制续接落在相邻页或同页 + 页索引去重,孤儿续接降级为独立题目并记日志) |
| F3 | vlm_grounding_service.rs 7 处 | bug | 中 | `&body[..body.len().min(N)]` 按字节切片截断错误消息/VLM 响应,中文内容(智谱 API 错误信息、题目文本)在非 UTF-8 字符边界会 panic,且全在错误处理路径上(雪上加霜) | 已修复(新增 truncate_utf8 边界安全截断,7 处全部替换,补单元测试) |
| F4 | llm_structurer.rs:align_by_label | 坏味道 | 低 | label 匹配失败后的位置回退可能把已按 label 匹配走的 parsed 项重复分配给另一题(label 拼写错位场景);概率低、影响为单题内容重复 | 建议(保持现状,登记备查) |
| F5 | vlm_grounding_service.rs:crop_figure_from_page | - | - | bbox 裁切已正确处理颠倒坐标/越界/默认零 bbox(1x1 最小裁切,下游 MIN_FIGURE_SIZE=30 过滤),补 2 个回归测试 | 通过 |
| D2 | pdf_ocr_service.rs:run_backend_worker + enforce_cache_budget | bug/泄漏 | 中 | `pdf_ocr_images/{session_id}` 渲染产物(每页一张 JPEG)创建后**永不清理**:enforce_cache_budget 只管 `pdf_ocr_cache`(OCR 结果 JSON),全仓无其他引用;每次 PDF OCR 把整套页面图永久留盘,150DPI 500 页 ≈ 数百 MB/次,无限累积 | 已修复(预算机制泛化为 enforce_dir_budget,images 根目录纳入 LRU 清理:2GiB 上限/1GiB 目标,新会话启动时触发,活跃会话目录保留) |
| G1 | multimodal/retriever.rs + page_indexer.rs + vector_store.rs + reranker_service.rs | 死代码 | 中 | `retriever.rs` 未在 mod.rs 声明、全仓无引用;`PageIndexer::new` 全仓无调用方(实际索引逻辑在 vfs/multimodal_service.rs),连带 vector_store/reranker_service 的 PageIndexer 专用路径 ~130KB 疑似死代码 | **待用户决策**(删除属中风险,需与代理 2 确认 vector_store 边界) |
| G2 | multimodal/embedding_service.rs:embed_texts(_with_progress) | bug | 中 | embedding API 返回数量未与请求 chunk 数核验即按索引取值,服务端少返回时 panic(越界) | 已修复(长度校验,不匹配报错) |
| G3 | multimodal/page_indexer.rs:index_pages | bug | 低 | 全部页 unchanged 跳过时提前 return,mm_index_state 卡在 indexing——但该模块为死代码(见 G1),实际无影响 | 登记备查(随 G1 一并处理) |
| G4 | multimodal/embedding_chunker.rs:hard_chunk | bug | 低 | CJK 区间判断用严格不等(`> U+4E00 / < U+9FFF`),边界字符"一"(U+4E00)/"鿿"(U+9FFF)被误判为非 CJK,与同文件 estimate_tokens 的闭区间不一致 | 已修复(改 >=/<=) |
| G5 | multimodal/embedding_service.rs + vlm_grounding_service.rs | bug | 中 | `VLSummaryThenTextEmbed` 已在 is_mode_available 弃用(恒 false),但 embed_pages 降级链仍指向它:VL-Embedding 不可用时降级必然失败,报"配置错误"而非真实原因 | 跨组(X5,主逻辑在代理 1 的 llm_manager 配置层) |
| H1 | features/pdf/components/EnhancedPdfViewer.tsx | bug | 中 | 文本选区 mouseup 监听按原始 prop `enableTextSelection` 挂载,未用合并设置默认值后的 `resolvedEnableTextSelection`:通过设置开启选区时划词高亮菜单不出现 | 已修复 |
| H2 | features/pdf/components/PdfReader.tsx:OPEN_PDF_FILE | bug | 中 | `new Blob([data.buffer])` 对带 byteOffset 的 Uint8Array 视图会把整个底层 ArrayBuffer 打包进 Blob,PDF 数据污染/膨胀 | 已修复(按 byteOffset/byteLength 切片) |
| H3 | features/pdf/components/EnhancedPdfViewer.tsx:initialPage | 体验 | 中 | initialPage(阅读进度恢复)只设状态不滚动,虚拟列表始终停在第 1 页,进度恢复形同虚设 | 已修复(文档就绪后 scrollToIndex 到目标页) |
| H4 | features/pdf/stores/pdfProcessingStore.ts + pdfSettingsStore.ts | - | - | 进度单调性/终态保护/持久化校验设计良好;乱序更新仅引起少量多余渲染,不值得改 | 通过 |
| I1 | learning-hub/apps/views/sanitizeRenderedDom.ts + DocxPreview + PptxPreview + XlsxPreview | 安全 | - | DOCX/PPTX 渲染后均调 sanitizeRenderedDom(DOMPurify 白名单标签/属性 + href 协议白名单);XLSX 双层防护(escapeHtml + DOMPurify)。XSS 覆盖确认到位。两个残余观察:① `ADD_URI_SAFE_ATTR:['src']` 会跳过 src 的协议校验(DOMPurify 内置已允许 img 的 data: src,此配置疑似多余但删除可能影响 blob: 图片,不动);② 渲染→消毒之间存在极窄的未消毒窗口,docx-preview 自身不从文档内容造 script 标签,风险可接受 | 通过(2 条观察登记) |
| I2 | components/CroppedExamCardImage.tsx | 性能/bug | 低 | ① 裁剪 effect 依赖 bbox/回调的对象身份,父组件每次渲染传内联字面量/箭头函数会反复重拉 blob+重裁剪(闪烁);② useCroppedImage 缺退化 bbox 守卫,负尺寸赋给 canvas 抛异常;③ hook 版 resolvedBbox 判定缺 height 检查(与组件版不一致) | 已修复(回调 ref 化 + 依赖标量化 + 守卫 + 对齐判定) |
| I3 | components/ImageViewer.tsx | bug | 低 | ① executeCrop 选区完全落在 letterbox 区时 natW/natH 为负 → canvas 抛 IndexSizeError;② 缩略图高亮/底部页码读 currentIndex 而主图读 internalIndex,父组件未接 onNext/onPrev 时显示与内容脱节,缩略图点击完全失效 | 已修复(裁剪守卫 + 统一走 internalIndex/goTo) |
| I4 | learning-hub/apps/views/XlsxPreview.tsx:escapeHtml | 安全 | 低 | escapeHtml 不转义引号,sheet 名含 `"` 可逃出 id 属性注入受白名单约束的属性(残余面:style CSS 注入) | 已修复(补 `&quot;`) |
| I5 | components/ImageCropDialog.tsx + ExamPageImage.tsx + DocumentViewer.tsx + usePdfLoader.ts + usePdfProcessingProgress.ts | - | - | 通过:裁剪坐标归一化/触摸支持/取消竞态(renderToken/mounted)处理正确;usePdfLoader LRU+字节双限缓存、大文件熔断设计好;DocumentViewer 文本走 React 转义无 XSS | 通过 |

## 已实施的优化

| # | 改动文件 | 改动说明 | 验证结果 |
|---|----------|----------|----------|
| F1 | pdf_protocol.rs | A1:Range 响应限幅 8MB(64KB 整数倍,兼容 PDF.js 块边界),返回实际 Content-Range;A2:CORS origin 精确匹配 localhost(防前缀域名);抽出 `is_allowed_origin` 并新增 2 个测试 | cargo check 验证中 |
| F2 | page_rasterizer.rs | B2:Word COM 加 DisplayAlerts=0 + ReadOnly 打开 + Close(false),防隐藏对话框永久阻塞;B3:取图片尺寸改用 into_dimensions(只读头部) | cargo check 验证中 |
| F3 | ocr_adapters/deepseek.rs + deepseek_ocr_parser.rs | C1:grounding 扫描循环 O(n²)→O(n)(无标记 break、残缺标记跳过),新增畸形标记回归测试(锁定与旧实现一致的贪婪配对语义) | cargo check 验证中 |
| F4 | ocr_circuit_breaker.rs | C3:HalfOpen 探针加 120s 超时回收(probe_started_at),防探针泄漏导致引擎永久拒绝;新增回归测试 | cargo check 验证中 |
| F5 | document_parser.rs | E1:嵌套 ZIP 检测复用归档 + 4 字节魔数预筛,不再为检查全量解压所有条目 | 待验证 |
| F6 | figure_extractor.rs | F1:页面缓存 entry API 免 clone + 配图尺寸只读头部;移除 GenericImageView 导入 | 待验证 |
| F7 | cross_page_merger.rs | F2:跨页续接限相邻页(防隔页错拼)+ 同页续接页索引去重 + 孤儿续接日志 | 待验证 |
| F8 | vlm_grounding_service.rs | F3:新增 truncate_utf8,替换 7 处字节切片截断(防中文 panic);补 truncate_utf8 与 crop_figure bbox 边界共 4 个测试 | 待验证 |
| F9 | multimodal/embedding_service.rs | G2:embed_texts / embed_texts_with_progress 增加 API 返回数量与 chunk 数核验,防越界 panic | cargo check 验证中 |
| F10 | multimodal/embedding_chunker.rs | G4:hard_chunk CJK 区间改闭区间比较,与 estimate_tokens 一致 | cargo check 验证中 |
| F11 | features/pdf/components/EnhancedPdfViewer.tsx | H1:选区监听改用 resolvedEnableTextSelection;H3:文档就绪后滚动到 initialPage 恢复阅读进度 | typecheck ✅ lint ✅ |
| F12 | features/pdf/components/PdfReader.tsx | H2:Uint8Array→Blob 按 byteOffset/byteLength 切片,防底层 buffer 整体打包 | typecheck ✅ lint ✅ |
| F13 | components/CroppedExamCardImage.tsx | I2:onLoad/onError 回调 ref 化 + effect 依赖标量化(防对象身份抖动反复重裁剪);useCroppedImage 补退化 bbox 守卫与 resolvedBbox height 判定 | typecheck ✅ lint ✅ |
| F14 | components/ImageViewer.tsx | I3:executeCrop 负尺寸守卫;缩略图高亮/点击与底部页码统一走 internalIndex/goTo(未接回调时也可用);顺带清掉 no-empty lint 错误 | typecheck ✅ lint ✅ |
| F15 | learning-hub/apps/views/XlsxPreview.tsx | I4:escapeHtml 补引号转义(sheet 名进入属性值上下文) | typecheck ✅ lint ✅ |
| F16 | pdf_ocr_service.rs | D2(X3 落地):enforce_cache_budget 泛化为 enforce_dir_budget(根目录/上限/目标参数化),`pdf_ocr_images` 纳入 LRU 预算清理(2GiB/1GiB,保留活跃会话),根治渲染图片永久泄漏 | cargo check 待跑(改动晚于当前后台 check) |

## 跨组问题(发现但不属于本组职责域)

| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|----------|----------|--------------|
| X1 | llm_manager/exam_engine.rs:call_ocr_free_text_with_fallback | 熔断器 allow_request() 之后存在多条提前返回路径(无引擎配置/图片准备失败/请求构建全失败)不调用 record_*,在 HalfOpen 时泄漏探针。本组已在 ocr_circuit_breaker.rs 加探针超时兜底(C3),根治需在该函数提前返回路径上补 record;另注意配置类错误不应计为引擎失败 | 代理 1 |
| X2 | llm_manager/exam_engine.rs:call_ocr_page_with_fallback | 该路径(PDF OCR/VFS 索引用)完全未接入熔断器,所有引擎宕机时每页都全链路超时重试,500 页批量会长时间空转;建议接入 per-engine 熔断(ocr_circuit_breaker 已支持 registry) | 代理 1 |
| X3 | ~~pdf_ocr_service.rs:images_dir~~ | **已核实并收回本组修复**:全仓只有 pdf_ocr_service.rs 引用 `pdf_ocr_images`,无任何清理逻辑(enforce_cache_budget 只管 `pdf_ocr_cache`)——确认为本组域内泄漏,已修复(见 D2/F16),不再跨组 | ~~代理 2~~ 本组已处理 |
| X4 | chat_v2/tools/paper_save_executor.rs:209,244,346 | 与 F3 同型 bug:`&raw[..raw.len().min(300/200/500)]` 字节切片截断,中文内容非字符边界 panic;本组已在 vlm_grounding_service.rs 修复同类问题并提供 truncate_utf8 参考实现 | 代理 1 |
| X5 | llm_manager 配置层(VLSummaryThenTextEmbed 降级链) | `VLSummaryThenTextEmbed` 模式已弃用(is_mode_available 恒 false),但 embed_pages_with_mode_and_progress 的降级链仍把它作为 VL-Embedding 的 fallback:VL 不可用时降级注定失败,用户只看到"配置错误"。建议降级链直接跳到 TextOnly 或给出明确提示 | 代理 1 |
| X6 | commands.rs:qbank_get_source_images(5728) | 一次性把题目集全部源图片读盘 + base64 编码返回(50 页扫描卷可达上百 MB IPC payload + 前端常驻内存),ImageCropDialog 打开即触发。建议改分页/按需加载(前端 ImageCropDialog 在本组域内,愿配合改造) | 代理 4(题目集) |
| X7 | components/anki/cardforge/engines/index.ts + index.ts | `npm run typecheck` 现有 4 个错误:`./CardEngine`、`./hooks` 模块不存在(TS2307)——疑似某代理重构进行中;本组前端改动验证时已确认与本组文件无关 | 代理 5(anki)或当事代理 |

## 共享文件改动登记

| # | 文件 | 改动段落/函数 | 原因 |
|---|------|---------------|------|

## 接力须知

- 本会话通过 mcp-feedback-enhanced 与用户交互,feed_id = **F-BY6DS**(接力会话请勿重新注册,直接 feed-poll/interactive_feedback)。
- 工作流程:按 TODO 单元顺序审阅;每个发现立即记入「审阅发现」表;低风险修复直接做并跑验证(`cargo check` / `cargo clippy -- -D warnings` / `npm run typecheck` / `npm run lint`,详见 README 3.4);高风险只登记。
- 仓库可能有其他 7 个代理并行改动,cargo/npm 验证失败时先确认是否本组文件引起。
- 未经用户明确要求不得 git commit / push。
- OCR 6 引擎 = DeepSeekOcr / PaddleOcrVl(1.5, 默认) / PaddleOcrVlV1 / Glm4vOcr / GenericVlm / SystemOcr(macOS Vision + Windows.Media.Ocr),见 `ocr_adapters/types.rs`、`factory.rs`。
- multimodal/ 含 vector_store.rs / retriever.rs 等与代理 2(向量层)邻接的文件:本组按 agent-3.md 拥有该目录,但涉及入库/检索行为的改动需在「跨组问题」与代理 2 同步。
