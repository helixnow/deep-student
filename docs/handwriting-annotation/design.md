# 当前实现架构与维护约束

更新：2026-11-04。历史实现基线为`7fef25ec`＋`bc48e6eb`，当前HEAD为`d48bec38`，本轮扩展尚未提交。第1–7节保留固定分页v1契约，第8节描述新增schema2自由画布；用户明确恢复后的最新主验结果与权限见 [唯一交接](HANDOFF-IMPLEMENTATION.md)。旧136文件冻结不是当前实时源码身份；当前真机问题见 [issue](issues/android-import-preview.md)，手机仍运行旧包。本轮不新增运行时依赖，不引入第二套文件系统。

## 1. 模块与入口

```text
资源库／Workbench／经典壳／Android
              │
              ▼
      同一 LazyInkEditor → InkEditor → InkPageView
              │                        │
              │                  renderInkPage
              │                 页面／选区／PNG／PDF
              ▼                        │
      useInkDocument → Ink API          ▼
              │                immutable render artifact
              ▼                        │
    现有 VFS／DSTU／blob                ▼
    canonical .dsink manifest      Chat 图片上下文／工具历史
```

- `src/features/ink/`：编辑、输入、几何、统一 renderer、固定页准备、导出、草稿。
- `src-tauri/crates/dstu-vfs/src/vfs/ink/` 及 `repos/ink_*`：严格格式、CAS、对象操作、不可变产物。
- `src-tauri/src/ink_{bridge,jobs,undo}.rs`：WebView 渲染／应用任务／可信撤销。
- `src-tauri/src/chat_v2/tools/ink_executor.rs`：六工具生产执行；Agent compiler／live／history 路径把可信图片真正送入模型。

复用现有文件系统与运行时依赖；`.dsink` 是 `file` 子格式，不是新顶层资源类型或第二套存储。

## 2. Canonical 数据与写入

- `INK_MIME = application/vnd.deepstudent.ink+json`、扩展名`dsink`。固定分页为schema1，自由画布为独立schema2；原v1文档不自动迁移。
- manifest 的身份、revision、source、pages 是唯一内容事实源。页面正文独立 JSON blob，背景为 Ink 自持有的固定 PNG。
- `files.blob_hash/sha256` 指向当前 manifest；`resources.hash` 与 `preview_json.ink` 是派生镜像，不可独立编辑成第二权威。
- `document_id` 参与 manifest 内容 hash；复制产生新文档／页面身份，内容去重不能合并两本空白笔记。
- 版本是服务端 opaque revision，CAS 比较旧 manifest blob 指针，不使用时间戳模拟版本。
- operation ID 相邻精确 retry 可复用回执；同 ID 不同输入拒绝，无法证明旧操作时返回 unknown，不能重做后假称幂等。
- 锁序固定为 `BlobMutationGuard → SQLite writer`，嵌套 helper 复用 guard，不跨 await。不向通用 blob/upload API 扩散 Ink 专用限制。
- 不放开通用 `dstu_update(file/image)`；原文件不覆盖。

## 3. 格式与预算

| 项目 | 当前边界 |
| --- | --- |
| manifest／page JSON | 1 MiB／8 MiB |
| 页数／页边 | 1–500／1–16384 logical units |
| 单页对象／samples | 10000／100000 |
| 颜色／线宽 | hex 白名单／`0 < width <= 256` |
| 坐标／pressure | 有限、固定页边界内／0..1；时间非递减 |
| 编辑器 Canvas | 16M 像素预算 |
| Chat 图片 | 最多4图、单4 MiB／长边2048、总16 MiB |

Rust 与 TS 格式一致；严格 unknown fields、重复键、非有限数字及伪 Number marker 均拒绝。页面文字是普通 Canvas 字符串，不执行 HTML。原始笔迹 JSON 不进入通用正文／OCR／RAG。

## 4. 编辑与渲染生命周期

- raw samples 持久化，不在重开时重新平滑。压感宽度为 `baseWidth * (0.25 + 0.75 * pressure)`，荧光笔独立 multiply 层。
- 编辑器、离屏图、PNG、PDF 共用 `renderInkPage`。活动笔迹透明 overlay，不每个点全页重绘。
- 背景以 React 已发布的 `InkBackgroundLease` 持有；prop 替换／解绑后清理，取消的迟到结果立即 dispose，不能提前 close 仍被子组件绘制的 ImageBitmap。
- 收笔先 IndexedDB journal 再 CAS。存储错误不等于“草稿已保存”；外部变更必须重读 canonical。
- own-save echo 按 operation ID 过滤；remote epoch 改变清整本文档 undo，普通翻页不清正常历史。
- 扩展工具提供12色＋自定义hex、笔／荧光笔独立宽度与透明度偏好、直径4/8/16/32/64整笔擦。连续扫掠删除整个可编辑对象，一手势一undo；来源背景只读。不提供像素擦除／笔画切段。
- 矩形／套索whole-object选择复用真实pressure/taper/形状几何；选择不写canonical。严格矢量clipboard按新用户身份粘贴，容量与目标身份写前校验，不复制AI回执。

## 5. 来源与文件预览

- PDF、图片、DOCX／PPTX 通过本地固定页准备，保持可编辑批注与原文件分离；Office 不承诺原生高保真。
- 固定 PDF 页的 `pdf_page.blob_hash` 是 PNG，不是原 PDF。源文字高亮按冻结版本合成；来源改变明确失败。来源删除不会移除 Ink 自持有背景。
- 文档“导入成功”与“能够预览／能够转换批注”是不同契约。Android SAF 可能不给有扩展名的路径；不可只凭 URI 最后一段决定真实格式。
- 当前已确认的真机失败属于类型信息不足后的 unsupported 分派；尚未验证 PDF 字节和实际导入入口，不能归因为 PDFium 或已经修复的 ImageBitmap 问题。

## 6. Chat 与授权

六工具保持：`ink_prepare/create/get/render/apply_ops/export`。

- `get` 返回有限摘要，不返回笔迹数组；`render` 产生真实可信图，不以工具文字冒充模型看图。
- immutable artifact 固定 document／page／revision／crop／hash 与生产调用来源；live/history/variant 共享严格 provenance。历史使用已持久化图片，不悄悄按当前内容重绘。
- 完整并行工具轮结束后才插入真实 image part；预算整轮验证成功才消费，失败明确返回视觉能力／图片送达错误。
- 更新／删除对象必须精确一次性审批、never-remember，不能被 FullAccess／Plan／global／group 绕过。
- Chat 与 VFS 是两库；PREPARED→VFS commit→COMMITTED 不假称单事务。可信 undo 只接受 opaque message／block 等 ID，加载 backend-only receipt，对象级校验并保留后来无关人类内容。
- “问AI”先 flush，再生成固定版本 PNG 并加至对话附件；不会自动发送，不自动调用模型。

## 7. 新阶段不能破坏的边界

1. 固定分页 PDF／图片批注保持独立；无限画布是新空白模式，不自动迁移原文档。
2. 扩色／宽度可沿用当前格式；圈选状态不是 canonical 内容。
3. 剪贴板是不可信输入；复制不继承 AI 回执或撤销权，粘贴需新身份并按当前用户操作保存。
4. 不能只放宽 renderer 的负坐标而遗漏 Rust、artifact、sync 和工具几何校验。
5. “无限画布”指无预设页面边缘，不承诺无限存储；既要有有限资源预算，也要避免把单页8MiB上限包装成长期可扩展画布。
6. 用户已批准总体计划实施；当前源码变更和验证以roadmap阶段状态为准。没有新增模型费用、手机数据清理、APK安装或 Git 提交授权。

## 8. schema2自由画布实现

- 独立blank source、`pages:[]`、稳定surface/page_id。世界坐标±10000000；完整对象批次chunk，不按空间tile切断笔画；全板对象ID与z唯一。
- 单chunk8MiB／10000对象／100000 samples；整板64MiB／256块／100000对象／2000000 samples，单次JSON读取16MiB。视口Canvas16M像素、DPR最多2；缓存按编码内容32MiB预算，不宣称JS堆硬上限。
- `DstuFileViewer`按canonical manifest模式选择轻量lazy entry；分页和画布使用独立宿主，共用几何／对象绘制。相机world↔screen统一，查看状态仅本机持久化，不改文档revision。
- 每文档独立session、IDB原子owner claim／sequence／tombstone、先journal再CAS；CAS按document串行，await前快照chunk版本。新编辑保dirty，不因own echo盲删草稿。宿主完成手势后1000ms合并自动CAS；显式flush取消timer，错误不无限重放。
- overview逐块verified扫描返回精确decimal max z；JS unsafe整数明确拒绝。已验证的z授权绑定document／surface／remote epoch，本地保存更新revision不阻断连续书写；远端epoch变化必须重新取得授权。
- chunk依赖纳入引用／GC／复制／冲突双方／同步／备份恢复。sync format仍4，board能力`ink_board_v2`要求min reader5；旧v1／无Ink备份保兼容，board新备份要求schema20261104及实际guard。
- 连接capability UDF5＋9个files/blobs/artifact DML触发器是旧writer兼容围栏，不是恶意DDL权限沙箱。统一创建facade委托repo，在发布首个board的同一savepoint内核capability／future floor并原子安装guard；不靠环境变量或外置预装绕保护。
- board render使用明确有限world crop，render_id包含有效long_edge、renderer profile、document／revision／crop与有序chunk tuple。200／400输出互不覆盖；None与默认2048归一。真实WebView和browser共享同一renderer；checked publish在writer内复核冻结输入。
- PNG是明确有限单框；PDF是显式region／logical tile尺寸、row-major裁边≤500页。失败／取消清理stage，不暗用整个surface.bounds，不覆盖源文档。
- board AI apply直接规划whole chunks，不伪装成分页InkPage；可信只读preview先写PREPARED，再VFS commit，再COMMITTED。失败block重试按同一Chat事务迁移唯一authority，旧终态不改；fresh同op竞争、stale迁移和目标写入失败均fail-closed。undo重插复用chunk余量、保receipt z及后来人类对象。

以上是当前代码契约，不代替真机体验、最大规模内存和最终全量测试；实际证据范围只在交接和验收文档维护。
