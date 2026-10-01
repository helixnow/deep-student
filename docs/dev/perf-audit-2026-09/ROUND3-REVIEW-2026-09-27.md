# 第三轮性能与边界复核

日期：2026-09-27（Asia/Shanghai）

代码基线：`main @ 3de1a6cda`

持久化证据：[ROUND3-EVIDENCE-2026-09-27.json](./ROUND3-EVIDENCE-2026-09-27.json)

后续实施：R3-04～R3-09 六项 P2 已于同日提交修复，定向验证及边界见 [P2 修复与验收](./P2-IMPLEMENTATION-2026-09-27.md)。以下保留检查时的历史结果；R3-01～R3-03 三项 P1 仍开放。

## 结论

本轮新增确认 **3 项 P1、6 项 P2**。其中三条问题链有真实 macOS 应用证据：混合上传锁竞争及预览缺页、取消任务重启后恢复、禁用系统 OCR 后仍执行兜底。其余分别由生产算法/Hook、生产规划器、文件操作实验或静态调用链支持，不能混称三平台实测。

优先级最高的是混合上传：两份附件 PDF 与一份普通 PDF 并行时，一份附件失败，普通 PDF 虽上传成功但缺少前两页预览。此前六份 `vfs_upload_file` 同时上传通过的结论仍成立，其覆盖范围不包含这条附件事务路径。

本轮只做检查、隔离实验和报告落盘，**未修改生产源码**。最小修复方案与验收要求见各项及末尾实施顺序；没有依据宣称三平台已经“最优”或不存在其他性能问题。

| 编号 | 优先级 | 问题 | 本轮证据 |
|---|---|---|---|
| R3-01 | P1 | 附件长写事务与 Blob 锁交错，造成上传失败及预览缺页 | 真实 native IPC、日志、只读数据库、页图接口 |
| R3-02 | P1 | 已取消任务缺少持久取消状态，重启重新执行 OCR | 真实重启及 4 个意外 loopback 请求 |
| R3-03 | P1 | 无 Lance 的 mobile-slim 查询仍规划无收益向量请求 | 生产规划器运行、备份恢复与运行时静态链路 |
| R3-04 | P2 | PDF 远程失败后的系统 OCR 兜底忽略禁用配置 | 真实 macOS Vision 结果、日志、持久配置 |
| R3-05 | P2 | 长单块流式搜索缺少背压，Worker 积压过期任务 | 生产算法独立 Worker，500k/50k 对照 |
| R3-06 | P2 | suspended 会话仍持续生成搜索 Worker 请求 | 生产 Hook + Provider，捕获 Worker 传输 |
| R3-07 | P2 | 同一 SAF URI 的并发生产者争用固定临时文件 | macOS 文件操作确定性交错，未跑 Android UI |
| R3-08 | P2 | 上传同步解析/I/O/数据库等待仍占用 async 工作线程 | 静态可达性；本轮未观察到轻 IPC 变慢 |
| R3-09 | P2 | 预渲染等待期间保留闲置数据库连接，索引再嵌套借用 | 静态租约链路；未复现连接池耗尽 |

## 环境、方法与边界

- macOS 26.5.2 / M5 Pro / 48 GiB；`npm run tauri dev` 启动真实 WKWebView，版本 `0.9.68 (Build 15149, 3de1a6cd)`。没有使用 demo、hero 或 tauri-lab。
- 独立 identifier：`com.deepstudent.perfaudit20260927`；所有新增文件只进入隔离 `slotA`。数据库检查均为 `mode=ro`，写操作仅经真实上传/设置接口进入隔离数据。
- OCR 唯一启用的远程配置指向 `127.0.0.1:17424`；没有调用外部/付费模型，没有部署、推送或修改个人资料库。
- 测量期间宿主存在其他项目的 Rust 构建。开发构建的单次延迟用于说明复现行为，不作为 release 吞吐量、设备排名或跨平台跑分。
- 前端对照使用 Node v26.5.0；隐藏搜索使用 jsdom/React。Android 规划器及 SAF 实验不等于 Android 设备运行；Windows、Android 真机仍未验证。
- 沿用前轮已建立状态，未重新全量扫描、重跑旧构建或旧测试集。针对未覆盖的调用入口、停止条件和平台能力边界验证。
- 原始临时目录：`/tmp/deep-student-perf-round3-20260927/`。关键数值、输入特征、错误、日志摘录和限制已写入仓库 JSON，不依赖 `/tmp` 长期存在。

## R3-01：混合上传发生实际锁冲突，并保存不完整预览

### 真实输入与结果

2026-09-27 19:27:48–19:28:03，在 OCR/自动索引均关闭、启动恢复任务已结束的隔离实例，通过同一次 WebView 调度并行提交三份**内容不同、每份四页**的扫描 PDF：

| 输入 | 命令 | 大小 | 命令返回耗时 | 结果 |
|---|---|---:|---:|---|
| attachment-A | `vfs_upload_attachment` | 215,991 B | 12,246 ms | 新附件 `att_dsZApVX4Vn`，预览页 0–3 完整 |
| attachment-B | `vfs_upload_attachment` | 220,834 B | 652 ms | `Database error: database is locked`，未产生文件行 |
| file-C | `vfs_upload_file` | 221,138 B | 12,892 ms | 新文件 `file_g7483IeSMj`，仅保存预览页 2、3 |

日志记录两个预览页分别因 `database is locked` 失败，随后普通文件打印 `Rendered 2 pages successfully (truncated: false)`，上传接口仍成功。

独立只读检查确认 file-C：

- `page_count=4`、预览 `totalPages=4`、`isTruncated=false`，但 `pages` 只有 `pageIndex=2,3`。
- 后续压缩只处理这两页；`readyModes=["image"]`。
- 最终 `completed_with_issues` 中的唯一失败阶段是“关闭自动 OCR 导致扫描件不可检索”，**没有记录预览缺页**。
- 再调用真实 `vfs_get_pdf_page_image`：页 0、1 返回 `页码越界: page_index=0/1, total_pages=4`；页 2、3 返回 JPEG，大小分别 52,254/52,144 B。

缺失的是预览页；本实验没有证明原始 PDF 字节丢失，也没有操作真实页面来声称所有阅读器入口都损坏。

同期 `get_app_version`：上传前 10 次中位数约 1 ms、最大约 1 ms；上传中 76 次中位数 1 ms、P95/最大约 2 ms。因此，本轮应报告**实际写锁竞争与预览不完整**，而不能报告“所有 IPC 都被阻塞”。

### 根因与范围

- `src-tauri/src/vfs/handlers.rs:1722` 直接调用附件仓储。
- `repos/attachment_repo.rs:1390` 的外层 SAVEPOINT 包住完整上传；`:873` 先写主资源/Blob，`:898` 在同一事务中渲染 PDF。
- `repos/pdf_preview.rs:331` 每页再进入 `store_blob_with_conn` 获取共享 Blob mutex。
- 可达交错：附件 A 已持 DB 写锁，等待下一页的 Blob mutex；普通文件 B 已持 Blob mutex，等待 DB 写锁。SQLite busy timeout 打断等待环后，预览循环在 `pdf_preview.rs:233–236` 跳过失败页继续，部分成功仍返回 `Ok`。
- 附件外层事务还可能在首写前建立读快照。真实日志没有 SQLite 扩展码或 mutex 所有权轨迹，不能把每个 busy 错误都归到同一个具体 SQL 或声称已经直接观测全部锁拥有者。
- `95a009417` 修复了此前普通文件上传的事务升级问题，但附件外层事务路径仍未覆盖。不能把这个原有附件设计问题全部归因于该提交。
- `blob_repo.rs:96` 预留的 DB 写锁还覆盖 `:171` 主文件 `write_all`，大文件首次导入可能延长写锁持有时间；本次约 216–221 KB 输入没有测量大文件增量影响。

生产并发是可达的：已检查的资源库附件批量入口限流为 3、旧附件组件串行，但当前 `InputBarUI.tsx:473/481/609` 通过 `forEach → FileReader.onload` 并行调用附件接口，附件上限 20。这次只使用 2 个附件 + 1 个普通文件，不以 16 个普通上传请求冒充常规 UI 行为。

### 最小修复与验收

复用现有 `UploadSaga`，把 PDF 解析/渲染以及独立 Blob 落盘移出外层数据库写事务；为已独立提交的引用登记既有补偿，短事务只落资源/文件/文件夹元数据。保持统一锁序和去重语义，收窄主文件写盘占用 DB 写锁的区间；不要用更大的连接池、全局上传串行锁或增加重试次数掩盖冲突。

部分预览失败必须明确传到现有处理状态，不能以“至少有一页成功”认定完整可用；继续用真实 `pageIndex` 寻页，不能用数组下标补齐或错配页面。

验收保留本次三份四页的混合输入和并发方式：全部上传成功，所有目标页 0–3 落库且页图接口可读，预览失败有可见状态，Blob 补偿/去重仍正确。另以注入单页失败验证错误语义，避免仅修锁竞争后保留静默缺页路径。

证据：JSON `mixedUpload`。

## R3-02：取消只停内存任务，重启会恢复已经取消的工作

前轮已实际取消的文件 `file_x5-XkXkCt0`，在 A/B/C/D 完成后一直没有 OCR payload；但持久 `processing_status` 留在 `ocr_processing`。

本轮重启前该文件是唯一中间态任务。开启隔离 OCR、关闭自动索引后，仅重启自有 Tauri 应用，没有再次调用其启动命令：

1. 19:18:48，启动日志查到 1 个 stuck task，重置为 pending 并自动续跑。
2. 本机模拟服务收到 **4 个新的 OCR 请求**。
3. 这说明取消意图未跨重启保留，会再次占用模型请求、处理时间和共享许可。

`pdf_processing_service.rs:2580–2594` 的 `cancel` 只移除 `running_tasks` 并取消 token；`:2673–2677` 的恢复查询把 `ocr_processing` 视为可恢复中间态；`lib.rs:3267–3277` 启动恢复链路。`retry` 也不接受留下的 `ocr_processing` 状态，但本轮未操作重试 UI，不报告未经验证的按钮表现。

**最小修复：**在现有持久处理状态中表达用户主动取消，并让启动恢复排除该状态；保留真正崩溃中断任务的恢复，以及用户明确重试的入口。写回沿用既有 generation/cancellation 约束，避免旧任务覆盖新任务。无需新增恢复队列或额外数据库日志。

**验收：**取消→所有后台任务收尾→重启后请求增量为 0、无晚到 OCR 写回；用户明确重试后正常执行。另保留真正中断任务可恢复的对照。

实验限制：mock 被 hold 超过客户端 300 秒超时，最初收尾脚本因“预期仍有 4 个 active”断言失败。结果为 requests=4、completed=0、disconnected=4；不得写成远程 OCR 成功实验，也没有重跑覆盖失败。最终本地 OCR 完成的原因已查清，见 R3-04。

证据：JSON `cancelRestart`；历史取消证据见 `OCR-VERIFICATION-2026-09-27.json` 的 C 阶段。

## R3-03：Android mobile-slim 查询仍可请求无收益 embedding

精确触发条件：不含 Lance 的 mobile-slim 构建，从桌面备份恢复后保留 active TE/ME profile，并存在启用且匹配的 embedding 配置。不能写成所有新装 Android 或普通增量同步必然触发。

- `unified_retriever.rs:1597` 的 profile 能力判定不检查编译期 Lance 可用性。
- `data_governance/backup/mod.rs:2406–2436` 备份恢复保留 active profile，并把 ANN 重置为 exact/0；检索兼容检查仍接受它。
- 上游聊天检索及 VFS 直接接口没有查询短路。`:793–878` 先发 embedding，再查询 `lance_store_stub.rs:248` 必然为空的存储。
- 路线汇合要等待这些请求；30 秒是配置中的路线预算，**不是本轮实测延迟或实际计费**。
- 前轮无 Lance 保护覆盖向量写入/后台 worker，没有覆盖这条查询链。

离线编译运行生产 `retrieval_planner.rs`，注入两个满足上述条件的 TE/ME 能力：无 Lance 时文本请求仍产生 **2 条**向量路线，混合输入产生 **3 条**。能力生成与备份可达性由静态链路支持；没有发送网络请求或运行 Android App。

**最小修复：**把 `cfg!(feature = "lance")` 纳入现有 capability/profile 判定，在请求 embedding 前排除无存储收益的路线。保留 SQLite FullText 和有用途的 OCR/图转文字能力，不关闭整条检索，也不新增第二套规划器。

**验收：**无 Lance + 恢复 active profile 时，capability 与最终规划均不含向量路线，实际请求计数为 0，SQLite 结果仍返回；有 Lance 构建的向量检索保持原行为。Android 设备延迟、耗电与后台行为仍需真机验证。

证据：JSON `platform.slimPlanner`。

## R3-04：禁用系统 OCR 后，PDF 失败兜底仍执行它

R3-02 中四个 HTTP 请求 19:23:48 超时后，原生日志明确记录“所有远程引擎失败，尝试本地系统 OCR 兜底”，随后四页成功。只读数据库确认四页非空文本，UTF-8 字节数分别 **1331、1318、1328、1334**；19:23:49 状态变为 completed。这是 macOS Vision 真正识别所得，排除了“HTTP 错误被错误计为成功”。日志 `chars` 使用 Rust 字符串字节数，不等于 Unicode 字符数。

但同一隔离数据库中的 `ocr.available_models` 已将 `__system_ocr__` 设为 `enabled=false`，其更新时间是 15:22:57，北京时间，早于本轮重启。正常模型候选构建会过滤禁用模型；`llm_manager/exam_engine.rs:865` 的 PDF 回退仅判断平台支持，直接执行系统 OCR，因此绕过配置。

**最小修复：**复用现有已启用 OCR 候选判断是否允许系统兜底。禁用时保留远程失败，启用时保持非空文本成功语义与共享许可。无需更改成功聚合器。

**验收：**分别禁用/启用系统 OCR，让本地模拟远程服务快速失败，确认前者无本地识别、后者完成回退。无需再次等待 300 秒来验证相同分支。

证据：JSON `systemOcrFallback`。未评估系统 OCR 的识别准确率。

## R3-05：长单块搜索缺少背压，过期任务仍完整计算

`useMessageSearch.ts:121` 每次变化立即生成 delta 并发送 Worker；`:146` 仅在结果完成后丢弃旧代次。`messageSearch.ts:184` 对变化块重新生成完整 grapheme/NFKC 索引，Worker FIFO 逐个处理。

运行生产索引算法的独立 Node Worker，每 32 ms 追加，共 20 次追加：

| 初始单块长度 | 最后发送 | 最后完成 | 停流后等待 | 过期结果 |
|---:|---:|---:|---:|---:|
| 500,000 字符 | 663.9 ms | 1,654.7 ms | 990.8 ms | 前 20 个全部过期，最后一个有效 |
| 50,000 字符 | 663.9 ms | 675.5 ms | 11.6 ms | 0，流式阶段 20 个结果有效 |

500k 是极长单块边界，不是默认回答规模。生产正文追加没有前端单块截断，但后端默认 max_tokens=32768，不能用这个极端输入证明普通回答普遍卡顿。实验仅返回匹配数量，没有覆盖完整结果数组复制成本，也不是 WKWebView 测量。

**最小修复：**现有 Hook 保留一个在飞请求与最新待处理状态；收到回复后从当前 store 重新收集 delta，避免提前构建并排队过期快照。查询切换、store 切换及关闭仍使用现有代次和清理逻辑；不要为增量追加改变 Unicode 归一化语义。

**验收：**长块持续追加后最终结果正确，Worker 待处理请求不随追加次数增长；覆盖查询切换/消息删除/切换会话/无 Worker 回退，50k 对照无退化，并在真实可见 WKWebView 测量搜索导航响应。

证据：JSON `frontend.searchQueueExtreme` / `searchQueueControl`。

## R3-06：已有 suspended 状态没有停止搜索工作

`MessageList.tsx:262` 的搜索启用仅依赖 `isSearchOpen`；Hook 订阅只依赖 store/isOpen。`StreamPreferencesContext.tsx:51` 的 suspended 冻结渲染器输入，但未传入搜索执行条件。

生产 Hook + 生产 Provider 的 jsdom/renderHook 验证：保持搜索开启且 suspended=true，10 次 store 追加产生 **10 个 Worker 请求**，挂起时 terminate=0；关闭搜索后 terminate=1。

前轮“隐藏正文 DOM 变更为 0”的真实结果依然有效，但不能外推为后台会话没有搜索 CPU 工作。本项证明的是已有 suspended=true 时的遗漏，不等于所有平台 document.hidden/minimize 生命周期已验证。

**最小修复：**把已有 suspended 纳入搜索执行开关，保留 UI query；恢复时从当前 store 重建，复用现有 Worker 终止/创建生命周期。

**验收：**打开搜索→挂起→持续追加时请求增量为 0；恢复后结果与当前正文一致；前台查询、关闭和切换 store 正常。

证据：JSON `frontend.suspendedSearch`。

## R3-07：同一 SAF URI 并发入队竞争固定临时文件

`unified_file_manager.rs:507–523` 的最终 URI 文件名确定，临时名也固定为 `*.uri.tmp`。两个生产者都写完后，第一个 rename 消耗临时文件，第二个 rename 收到 ENOENT。ZIP 导出 `commands_zip.rs:238` 的入队早于后台治理锁；Android 串行消费不能保护 Rust 生产者。

在 macOS 临时目录确定性调度同样的文件操作：首次 rename 成功，第二次 errno=2，最终队列条目内容完整。这是错误的任务启动失败风险，不是文件内容丢失或 Android 授权损坏；未复现 Android UI 交互。

**最小修复：**保留确定性的最终文件名，每次写使用独立的同目录临时文件，再原子 rename；复用已有 UUID/tempfile，无需新增队列、轮询或锁服务。

**验收：**同 URI 并发与不同 URI 并发均可完成入队，最终内容完整、消费者可读；再以 Android 真机验证唤醒和 onResume 补扫。

证据：JSON `platform.safSameUri`。

## R3-08：同步上传工作仍直接占用 async 工作线程

附件入口 `handlers.rs:1722` 直接执行仓储中的 base64/哈希/PDFium/JPEG/文件写入/SQLite 等待；普通上传仅把 PDF 预览 offload，`:2408` 解码与哈希、`:2629` Office 解析、`:2694` Blob/事务写入仍同步。该路径由输入区、DSTU 工具和论文保存重试实际调用，文档上限 200 MiB。

本轮混合上传中轻 IPC 最大约 2 ms，**没有复现整个运行时饥饿或 UI 卡死**。因此列为 P2 的确定代码开销边界，保留大文件/更多工作线程占用时的实测需求，不将静态缺口升级为已测出的普遍性能故障。

**最小修复：**结合 R3-01 切分，把完整同步阶段放入 `spawn_blocking`，连接在闭包内借还，网络继续 async。不要只 offload 一条 SQL，也不要把闲置连接跨 await 搬运。

**验收：**使用实际大 PDF/Office 文件测量轻量业务 IPC 和取消响应，核对内容/事务补偿；避免仅用 trivial `get_app_version` 的通过来保证所有业务命令响应。

## R3-09：预渲染期间闲置连接与嵌套借用浪费池容量

- `handlers.rs:2450` 获取上传父连接，跨 `:2552` 的预渲染 await 保留；blocking 子任务在 `:2543` 又借连接。
- 论文下载 `:7608–7645` 同型；最多 50 页预览期间父连接持续占位。
- `index_service.rs:128` 自己借连接后，状态标记又能嵌套获取连接。
- VFS 池容量 15，备份维护屏障会等待租约归还；这些是代码配置与风险条件，不是已观测到池耗尽或屏障超时。

已检查的资源库附件批量入口限制为 3，DSTU 上传工具为 Serial；这不是所有 `vfs_upload_file` 或论文下载的全局并发上限。尚未复现生产可达负载下的连接池耗尽，不能宣称常规单批必然耗尽池。与下载、附件和后台索引叠加时会浪费容量，修复应减少闲置占用而非扩池。

**最小修复：**去重查询使用局部连接作用域；预渲染 await 前归还，短落库事务再获取；提交后释放再进入索引。复用已有 `_with_conn` 方法，避免状态标记再次借连接。

**验收：**在生产可达的并发入口叠加上传/下载与备份时观察租约释放及维护屏障；不以远高于 UI 限制的人造并发证明常规故障。

## 本轮排除或不扩大解释的事项

- 四个远程 OCR 超时没有被错误算作成功，本地识别结果真实存在；需要修复的是取消持久化和禁用配置约束。
- Worker 在关闭搜索、store 切换、卸载时已有终止与退订；可见高亮 observer 有清理，未报告新的普遍泄漏。
- SessionManager 销毁/淘汰会清理 timers、chunkBuffer、autoSave、事件上下文和订阅，并校验 generation。未找到本轮可证实的新生产泄漏。
- `useTauriAdapter.reinitialize` 的 lease 静态缺口没有生产调用者，不列为当前性能故障。
- 前轮已披露的密集可见高亮 DOM 成本没有包装成新发现。
- 无 Lance 的部分 OCR/Units 仍服务 SQLite，不把全部非向量预处理都判为无收益。
- 普通增量同步将 profiles 归为 DerivedRebuild，不把它冒充 R3-03 的备份恢复触发条件。
- SAF 消费者已有串行扫描、提交后唤醒和 onResume 补扫，本轮没有证明普遍丢唤醒。
- Windows/Android 真机的启动、长会话、输入响应、内存、耗电与系统后台调度仍缺测；不能根据 macOS、Node 或编译通过外推。

## 建议实施顺序与最小设计取舍

1. **先修混合上传及部分预览错误传播（R3-01），同一切片整理同步阶段和连接作用域（R3-08/09）。** 这是实际导入失败和预览不可读；复用 Saga/短事务/blocking pool，减少锁持有与闲置租约，比加池/加重试更直接。保留旧普通上传并发验收，并新增本轮混合入口，防止只修一条分支。
2. **修取消持久化（R3-02），并补系统 OCR 启用约束（R3-04）。** 分别验收重启不复活、显式重试可恢复、禁用不兜底；保留共享四槽和旧晚到写回检查。
3. **补无 Lance 查询能力判定（R3-03）。** 修改范围小，可以和前两项并行，但必须检查 capability 到真正外部请求的整条链，而不只验证规划器。
4. **收敛搜索在飞任务及挂起执行（R3-05/06）。** 保留 Unicode/导航结果，用真实 WKWebView 检查可见/挂起/恢复行为；不新增通用调度框架。
5. **修 SAF 生产者临时文件（R3-07），补 Android 实机验收。** 独立小改动，最终验证要包含真正文件授权与唤醒路径。

以上方案是针对已证明问题、优先复用现有结构的最小路线，目前尚无实施后的 A/B 数据支持“最优性能”表述。下一轮不需要再无目标全景扫描，应以这些确定输入验证修复，再补 Windows/Android 真机矩阵。

## 收尾状态

OCR 与自动索引恢复为关闭；本轮自有 loopback mock 已停止；真实 `tauri dev` 与 bridge 保持运行，隔离测试数据保留。没有直接删除用户数据或使用 stash/reset/clean。开工前的版本、锁文件、CHANGELOG、notices 和旧未跟踪 README 改动未纳入报告提交。
