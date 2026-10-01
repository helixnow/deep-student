# 性能优化落地与验证

日期：2026-09-27（Asia/Shanghai）。本轮基线为 `main @ 0a12cff12` 及开工时已有的版本回退工作区，应用版本为 0.9.68。此前已存在的本目录 README 使用的是另一份旧基线，不作为本轮测量依据。

当前状态：17 个优化/修复/验收工具切片已提交。恢复真实 OCR 验收后补齐两处缺陷：排队取消后的空结果写回（`f09d2edeb`），以及并行上传的事务读写升级冲突（`95a009417`）。最新 macOS 真实应用已按原输入与断言通过完整 A/B/C/D：关闭时 0 请求，共享峰值 4，排队取消无 OCR 写回，最终 28/28 请求完成且活动数归零。Windows/Android 真机性能仍未验证。

> 后续第三轮复核补出了混合附件/普通文件上传锁竞争及预览缺页、取消任务重启复活等边界。上述 A/B/C/D 仍是已通过的特定输入验收，不代表这些新路径已修复。详见 [第三轮复核](./ROUND3-REVIEW-2026-09-27.md)。

## 范围与环境

本轮落实二轮复核确认的优化，覆盖 Windows/macOS/Android 共用前后端，以及 Android 专用 SAF、无 Lance 能力分流和日志路径。没有调整缺少真机证据的 GPU、材质、SQLite 缓存/连接池、编译优化档位，也没有更改模型调用协议、搜索 Unicode 规则或同步加密格式。

- macOS 26.5.2 / M5 Pro / 48 GiB，真实 Tauri WKWebView。
- 真实桌面验证通过 `npm run tauri dev` 启动，使用独立 identifier `com.deepstudent.perfaudit20260927`；没有打开 demo/hero。
- 合成会话、独立 SQLite 数据库、本地 OCR mock 与临时文件均为本轮测试数据。没有修改个人资料库，没有使用付费模型，没有部署或推送远端。
- 保留开工前已有的 release manifest、版本、Cargo、CHANGELOG、第三方 notices 改动。package/lock 只提交本轮依赖补丁部分，原版本回退未混入提交。
- 前一阶段原始证据曾位于 `/tmp/deep-student-perf-audit-20260927/`，恢复工作时该临时目录已不存在。下文历史数值保留自已提交报告；其文件名是历史记录，不能当作现存可复查文件。`ROUND2.md` 为实施方案及此前方案对比，不应把原型结果误认成实施后实测。
- 本次恢复的 OCR 验收使用 `/tmp/deep-student-perf-verify-20260927/` 下重新构建的脚本、全新扫描 PDF 及新日志；这些不是前一阶段原始证据的恢复副本。
- 本次成功与两次失败的精简实测结果已持久化在本目录 `OCR-VERIFICATION-2026-09-27.json`，不依赖临时目录长期存活。完整请求日志、生成 PDF 及脚本仍保留于上述新临时目录。

## 已提交的实现

| 提交 | 改动 | 保留的行为与边界 |
|---|---|---|
| `05bae311c` | 搜索专用 Worker、变化块缓存；隐藏会话 suspended 透传 | 搜索关闭释放 Worker，查询代次隔离旧结果；后台 store 继续接收流式内容 |
| `63998e811` | Todo/Pomodoro 57 个同步数据库命令改为 async 外层及完整 blocking 工作单元 | 连接和事务不拆散，保留错误封装与事件顺序 |
| `728c209ac` | 词法检索范围先于 LIMIT，批量必要元数据；无 Lance 时在外部向量请求前分流 | 保留类型别名、未知类型回退、最新文件夹挂载语义和 SQLite 非向量路径；disabled 索引不再高频空转 |
| `fb23000d0` | 去掉备份成功步骤固定等待；ZIP 恢复检查点改为标量；手工 JSON 同步使用缓冲读写 | 保留 Busy/Locked 退避、维护屏障、非 ZIP 任务检查点和原 JSON 格式 |
| `7e32e6bed` | 详细工具诊断跟随已有显式开关 | 关闭时不启动收集器/定时器、不构造大 detail；保留必要产品日志 |
| `b026808aa` | note driver 从已挂载编辑器 API 读取状态；generative schema 与 UI 注册分离 | 复用现有模块和 schema 定义，不新增另一套注册协议 |
| `1dbd8fbcc` | OCR 请求前归还数据库连接；跨文件共享 4 个 OCR permit；有界图片 CPU blocking 路径 | bytes→bytes 保留压缩策略；permit 随实际任务存活；PDF 聚合写回遗漏的取消检查由下述 `f09d2edeb` 补齐 |
| `a49e19ce3` | 历史先做轻量 ID/压缩边界/尾窗，再批量物化 blocks/replay；中间保存只写 dirty payload | 同 ID 替换、replay、finalizer、外部 Anki 块均覆盖；COMMIT 成功后才清 dirty；最终完整 flush 保留；失败 COMMIT 主动 ROLLBACK |
| `fd87fed3f` | FlowToken 固定 2.0.6，使用可重放 patch 延迟 DefaultCode 依赖 | 保留行内 code、真正语言代码节点、复制与原动画；安装时自动应用补丁 |
| `30a41b38a` | Markdown renderer 身份稳定；AgentTaskPanel 缩窄订阅 | 新内容仍可读取当前回调/能力；纯正文 chunk 不驱动任务面板提交 |
| `72e62ee64` | 只对命中且可见的消息生成高亮；折叠图片先读前 8 个 | 导航目标可提前生成 mark；展开/全屏读取剩余图片；前 8 张全部缺失时仍保留展开入口 |
| `cca2e6e30` | 文件同步加密、解密、KDF 与哈希移出 async worker | 复用原 cipher cache，格式、KDF 强度和串行性不变；最终 rename 仍由持有同步许可的调用者执行 |
| `6975f3c91` | Android SAF 改为持久队列落地后原生唤醒，后台串行扫描 | 移除 400ms 主线程轮询；保留 onResume 补扫、权限拒绝和目录授权回退 |
| `6a010db7d` | 修复既有包体检查器对实际 `main-*.js` 入口的漏识别，支持 `--dist-dir` | 保留原预算和 CI warn-only；入口文件大小不冒充首屏闭包大小 |
| `8c8714ab7` | 真实验收补出的索引 OCR 兜底复用同一 4 槽；等待前释放连接；自动索引遵守开关 | `LLMManager` 仅拥有共享许可，LLM 方法不嵌套获取；保留现有索引提交/取消状态语义 |
| `f09d2edeb` | 主 PDF OCR 在页任务结束及事务写入前检查取消和 generation；取消后不保存空聚合结果 | 覆盖数据库连接/写锁等待及 busy 重试后的检查；跳过写入时不标记 OCR ready；不改变索引中途取消语义 |
| `95a009417` | 上传事务首读前预留 SQLite 写锁，避免 deferred 事务读写升级冲突 | 保持 Blob mutex → SQLite 锁顺序、原 SAVEPOINT 与补偿流程；零行操作不改数据，不增加重试或串行化上传输入 |

## 实际观察

### 搜索和渲染

真实 WKWebView，50 条消息、初始 250,000 字符，应用保持前台，生产搜索 hook 与真实 store。以下是单次受控验证的观测，不是 release FPS 或跨平台跑分。

| 阶段 | Worker 传输与耗时 | 观测最大 rAF 间隔 |
|---|---|---:|
| 冷首次无命中搜索 | 50 块 / 250,000 字符，235ms | 18ms |
| 仅修改查询 | 0 块 / 0 字符，低于计时分辨率 | 18ms |
| 末块追加 | 1 块 / 5,032 字符，12ms | 22ms |
| 全部消息命中 | 0 块，返回 10,531 处命中，5ms | 91ms |
| 下一处命中 | 使用已有索引 | 29ms |

实施中曾观察到 Worker 已接入但界面仍出现 356ms 间隔。定位后发现所有已挂载消息仍在同步生成高亮，随后补齐可见区域约束。最终 50 条消息仍挂载时，全匹配仅对 2 条消息生成 436 个 mark，并非对 10,531 处命中全部建 DOM。独立前台复核确认：直接定位第 50 条、全匹配回到首条、Shift+Enter 跨屏回绕到第 50 条，活动 mark 均在滚动视口内。

全匹配 91ms、关闭搜索 93ms 的局部 DOM/渲染成本仍存在；长单块、大量可见命中不应被描述为“已保证 60fps”。冷 Worker 完成时间也没有消失，改进的是主线程响应性及重复计算量。

隐藏会话真实路径：最小化后连续 10 次生产 store 追加，正文 DOM 变更为 **0**，store 保留最后一次追加，恢复后显示完整内容。二轮同路径此前为 10 次 DOM 变更。

额外实际组件验证：追加文本后，已有流式 Markdown 表格保持同一 DOM 节点；TypeScript 代码块和新追加正文正常出现。该正确性检查运行时 document 为 hidden，不用于时延比较。

证据：

- `implementation-search-visible-wkwebview.json`
- `implementation-search-navigation-visible.json`
- `implementation-hidden-wkwebview.json`
- `implementation-render-navigation-wkwebview.json`

### 生产依赖闭包

对本轮旧、新生产包使用同一静态依赖闭包算法，旧 raw 及聚合 gzip 数值逐字节复现。聚合 gzip 统一使用 level 6；早期 HTML 单项的 level 9 不混入比较。

| 依赖闭包 | 改前 raw | 改后 raw | 降幅 |
|---|---:|---:|---:|
| 初始 JS | 6,705,081 B | 5,063,115 B | 24.49% |
| 初始 + Chat | 9,368,590 B | 8,330,944 B | 11.08% |
| 初始 + 首段普通流式正文 | 14,739,296 B | 8,345,604 B | 43.38% |
| FlowToken 普通正文额外加载 | 5,370,706 B | 14,660 B | 99.73% |

初始 JS 数量从 36 降至 29 个；gzip 从 2,012,801 B 降至 1,496,710 B（25.64%）。初始闭包中不再包含 Milkdown、Recharts、D3，KaTeX 仍在。约 5.355MB 的代码高亮实现仍以独立动态 DefaultCode chunk 保留，实际代码节点需要时才加载。

这是特定入口的代码依赖量，不是安装包总大小或冷启动秒数。证据：`build-closure-comparison.json`、`compare-build-closures.mjs`、`vite-build-optimized.log`。

已有包体检查器也使用旧、新真实产物验证。全部 JS gzip9 为 10,255.7→10,249.7 KiB，仍超过原上限 8,560.6 KiB，原告警保留。总包体没有大幅下降，本轮主要减少首屏和普通流式路径必须加载的代码。证据：`bundle-check-original.log`、`bundle-check-optimized.log`。

### 数据库等待与持久化

独立 VFS SQLite 持有 `BEGIN IMMEDIATE` 写锁 3 秒，同时通过真实桌面 IPC 调用创建 Todo 列表及 `get_app_version`。列表写入耗时 **3,016ms**，100ms 后发出的轻量 IPC 在 **2ms** 返回；写请求没有把轻量命令一起拖入秒级等待。证据：`implementation-native-ipc-lock-async.json`。

首次旧验证脚本因 Vite 页面重载失去待返回结果，不作为失败或性能证据。重测使用独立标题及分开记录的 promise，确认实际写入完成；没有把超时当成未写入而盲重试。

生产迁移后的 SQLite 持久化回归通过：连续添加 50 个块并中间保存 50 次，触发器观察到 **50 次 payload 写入**。旧的“每轮写全部块”算法对此输入累计为 1,275 次，这是算法计数对照，并非整个 pipeline 的耗时倍数。还验证了同 ID 替换、外部 Anki 保留、语句失败回滚、延迟外键导致 COMMIT 失败，以及后续成功重试。

历史读取仍扫描轻量 ID，但不再先物化所有历史大 JSON；中间保存仍更新消息元数据，最后仍完整 flush。因此不宣称整个管线已严格线性或完全无重复 I/O。

### OCR 真实验收发现的额外入口

真实隔离实例上传 6 份各 4 页扫描 PDF，即使 `ocr.enabled=false` 且 `indexing.enabled=false`，本地延迟 OCR 服务仍观察到 **峰值 18 个在飞请求，最终 24 次完成**。准确调用链为：上传启动 PDF 处理 → 主 OCR 正确跳过 → Stage 4 自动索引忽略关闭设置 → 索引发现缺少文本 → 每文件 3 并发 OCR 兜底。它绕过了第一批仅在 PDF 处理服务中的 4 槽限制，不是上传预解析直接发出的请求。

`8c8714ab7` 已针对这一真实缺口追加修复：共享许可由应用复用的 `LLMManager` 持有，PDF/图片服务及索引兜底三个调用点获取同一组许可；LLM 请求方法内部不重复获取，避免嵌套死锁。索引主连接和页/图片分支连接在等待许可与网络前释放，自动索引入口遵守 `indexing.enabled`。

此前 `0.9.68 (Build 15145, 8c8714ab)` 的复测因 Mac 锁屏停止在上传前预检。恢复后实际启动 `0.9.68 (Build 15146, acc1e4b6)`，原生 IPC 与隔离资料库正常。预检还发现 macOS 会自动附加系统 OCR 候选；在隔离配置中显式禁用它后，读回确认唯一启用的 OCR 模型指向 `http://127.0.0.1:17424/v1`，没有放宽本地唯一模型断言。

恢复后的第一次真实实验（2026-09-27 15:22:58–15:23:15，Asia/Shanghai）发现并保留了新的失败：

- A：OCR 与索引均关闭，新四页扫描 PDF 进入终态，**0 OCR 请求、无 OCR payload**。
- B：六份四页扫描 PDF 全部进入索引兜底，持有 **4 个请求**；失败收尾释放 mock 后，精确完成 **24 次请求，峰值 4、活动数 0、断连 0**，六文件各存四页 OCR。
- C：另一个主 PDF 在这四个槽位后排队，取消返回 `true`，**没有新增请求**；但随后写入了 `pages: []` 的空 `ocr_pages_json`。日志显示取消的是该文件唯一一次启动的 generation，不是新旧任务替换。
- D：本次因 C 失败未执行，不计为通过。

根因是页任务按取消标记退出后，主 PDF 汇总逻辑仍序列化并保存空列表。`f09d2edeb` 在入口、页任务结束、数据库重试前及成功获取写锁后检查取消和 generation，跳过时不落库、不增加 OCR ready。独立只读代码复核通过。

当前失败原始证据：`/tmp/deep-student-perf-verify-20260927/ocr/run-2026-09-27T07-22-57-856Z/verification.json` 与同目录 `post-failure-drain.json`。预检配置记录为上级 `configuration-preparation.json`；复测入口为上级 `mock.mjs`、`drive.mjs`、`fixtures.py`。

### 并行上传暴露的写锁问题

第二次真实复测版本为 `0.9.68 (Build 15147, f09d2ede)`。A 再次通过，但 B 的第 4 份并行上传在 PDF 预渲染完成后的上传事务返回 `Database error: database is locked`，未生成文件记录。旧任务恢复在 15:35:26 前结束，B 于 15:36:01 开始，错误发生于 15:36:03；不是未完成的启动恢复所致。实验停止并保留失败，其余五份收尾取消，mock 请求数、峰值和活动数均为 0；C/D 未执行。原始证据位于 `/tmp/deep-student-perf-verify-20260927/ocr/run-2026-09-27T07-35-55-268Z/`。

代码检查发现上传外层 SAVEPOINT 属于 deferred 事务，两条分支都会先读取文件夹/去重或 Blob 元数据，再写入数据库。独立 WAL 实验以相同的读后写顺序和另一连接提交复现 `SQLITE_BUSY_SNAPSHOT`（517），设有 5,000ms busy timeout 仍在 0.009ms 返回错误。真实应用日志没有记录扩展码或具体失败 SQL，不能把该实验的 517 冒充原生错误码。

`95a009417` 在事务首读前用零行 UPDATE 预留写锁：Blob 路径先取得既有文件 mutex，文件路径在现有 result 闭包内执行，失败仍走原回滚/释放逻辑。独立 SQL 实验观察到修改行数、total_changes 增量、行级触发器新增记录均为 0，竞争写者等待至释放后可以提交。没有把外层改为会反转 Blob 锁顺序的 BEGIN IMMEDIATE，也没有新增重试机制。两条生产仓储回归覆盖有/无 Blob 上传遇到另一连接持有写事务时的等待与提交；原回滚、去重及补偿回归保持通过。

该修复覆盖本次上传的事务内首读位置；如果其他调用者在进入仓储函数前已经建立旧读快照，不应据此宣称任意嵌套读事务都已解决。最终验收保持六份文件 `Promise.all` 并行输入及原断言，没有通过串行上传或重试绕过失败。

### 最终真实 OCR 验收

2026-09-27 **15:50:24–15:50:47**（Asia/Shanghai），通过 `npm run tauri dev` 启动的真实 WKWebView / Tauri IPC，原生版本 **`0.9.68 (Build 15148, 95a00941)`**。确认隔离 `slotA`、唯一 loopback OCR 及旧失败任务恢复结束后，使用全新像素内容的九份四页扫描 PDF 运行原 A/B/C/D。没有调用外部或付费模型。

| 阶段 | 输入与操作 | 实际观察 |
|---|---|---|
| A | OCR 与自动索引均关闭，上传一份四页扫描 PDF | **0 请求**，无 OCR payload，文件进入终态 |
| B | 主 OCR 关闭、索引开启；六份四页 PDF 同时上传 | 六份上传成功且均进入索引兜底；持有 **4 个请求，峰值 4**；释放后六文件各存四页，页索引均为 0–3 |
| C | B 占满四个许可时，主 OCR 开启，另一个 PDF 排队后取消 | 取消返回 `true`；请求数保持 4；释放前、释放后、D 完成后均无 OCR payload |
| D | 释放 B，再上传一份新四页主 OCR PDF | 新四页完整持久化，文件终态为 completed；总计 **28 请求 / 28 完成 / 活动 0 / 峰值 4 / 断连 0** |

此实验同时覆盖共享许可、排队取消后的结果落库检查、许可归还及六文件并行上传路径。没有配置 embedding 模型，B 的 OCR 页完整不等于外部向量化成功；取消文件的既有 processing_status 字段仍为 ocr_processing，本次没有调整或验收取消后的所有 UI/状态展示语义。

成功原始证据：`/tmp/deep-student-perf-verify-20260927/ocr/run-2026-09-27T07-50-23-456Z/verification.json`。精简结果及两次失败、SQL 实验结果见本目录 `OCR-VERIFICATION-2026-09-27.json`。实验结束后关闭隔离实例的 OCR/自动索引设置，停止自有 mock；Tauri dev 与测试 bridge 保留。

## 编译与回归

- macOS `cargo check --lib` 通过；真实 Tauri dev 原生二进制构建并运行成功。
- 两批相关 Rust 测试分别 **18/18**、**58/58** 通过，共 **76 项**。包含检索范围/别名、Todo blocking 线程与错误、OCR permit/取消、图片策略、真实数据库备份还原、ZIP 检查点、JSON 往返、历史压缩/replay、增量持久化、文件加密同步和 SAF 队列。
- 前端定向 TypeScript 检查通过；去除重复统计后，22 个相关文件共 **257 项**通过：搜索 Worker/隐藏会话 25、schema/启动 143、FlowToken/动画 25、任务面板 28、Markdown 身份相关 22、图片 6、搜索可见性相关 8。最终生产 Vite 构建成功（41.04s）。构建仍报告大 chunk 警告，不将“构建成功”解读为所有包体均已足够小。
- Android 原生生成工程在 JDK 17 / SDK 36 下 `:app:compileUniversalDebugKotlin` 通过。检查的是当前 SAF 实现，不使用旧 APK 代替当前版本验证。
- Android Rust `cargo check --lib --target aarch64-linux-android --no-default-features --features mobile-slim --locked -j 2` 通过（5m10s，NDK 27 clang / API 24，`CARGO_INCREMENTAL=0`），包含 SAF Android 条件编译分支。未构建完整 APK、链接或安装真机。
- 索引 OCR 补充修复后，macOS `cargo check --lib` 再次通过，两个相关 shared/cancel 回归再次通过，Android 同一 `mobile-slim` 检查再次通过（1m24s）；没有重复运行不相关测试。
- 取消写回修复 `f09d2edeb`：macOS `cargo check --lib --locked -j 2` 通过（1m26s）；`cargo test --lib vfs::pdf_processing_service::tests --locked -j 2` **11/11** 通过（编译 3m16s），与上述总数有重叠，不相加冒充新增覆盖。此后两项补充修复尚未重新执行 Android 交叉编译。
- 上传写锁修复 `95a009417`：macOS 同一 `cargo check --lib` 通过（1m33s）；`cargo test --lib vfs::upload_saga::tests --locked -j 2` **9/9** 通过（编译 3m27s，执行 8.03s），含两个新增并发写锁用例。没有重新运行不相关前端测试、包体测量或 Android 交叉编译。

主要日志：`implementation-cargo-check.log`、`implementation-cargo-check-2.log`、`implementation-rust-tests.log`、`implementation-rust-tests-2-retry.log`、`frontend-final-typecheck.log`、`vite-build-optimized.log`、`implementation-android-saf-kotlin.log`、`implementation-android-rust-check.log`。

补充 OCR 修复日志：`implementation-ocr-shared-check.log`、`implementation-ocr-shared-tests.log`、`implementation-ocr-shared-android-check.log`、`implementation-tauri-ocr-final.log`。

本次恢复后的现存日志位于 `/tmp/deep-student-perf-verify-20260927/`：`ocr-cancel-cargo-check.log`、`ocr-cancel-rust-tests.log`、`tauri-cancel-fixed.log`、`upload-lock-cargo-check.log`、`upload-lock-rust-tests.log`、`tauri-upload-fixed.log`；SQL 复现位于其 `upload-lock-repro/`。上面两组旧日志属于已不存在的旧临时证据目录。

构建期间磁盘曾耗尽，已停止自有竞争构建，只清理可重生的本仓库 Rust incremental 缓存，之后使用 `CARGO_INCREMENTAL=0`。补充 OCR 修复再次编译前，还清理了本仓库旧代码生成 `.rcgu.o` 与静态归档缓存以腾出空间。没有删除源码、用户数据或他人的构建目录。

## 尚不能据此得出的结论

1. 没有 Windows 运行环境，也没有当前版本 Android 真机连接。WebView2/Android Worker 生命周期、SAF 授权生命周期、低内存、耗电及 release p50/p95 仍需设备实测。
2. 本轮 JS 包体、开发版帧间隔、SQLite 回归分别证明不同机制，不等价于最终安装包体积、release 启动耗时或整机内存收益。
3. 手工 JSON 同步仍持有完整变更对象图，只去掉额外 clone/string 副本；文件同步已 offload，但同步记录 payload/tombstone codec 不在本轮文件 offload 范围。
4. 搜索继续保留既有 grapheme/NFKC/lowercase 规则，包括二轮记录的希腊词尾 sigma 行为；性能改动没有暗中修订 Unicode 匹配语义。
5. 缓存、材质、连接池、启动维护调度等后续调参应由真机 trace 决定。本轮实现是当前证据下的简洁方案，不作“所有平台绝对最优”承诺。
6. 索引阶段已经进入 `index_resource` 后仍保留原有中途取消语义，没有强制丢弃整个 future 或新增 Lance/Units 状态恢复机制。排队取消验证针对主 PDF 的 OCR 请求和结果持久化，不能外推为完整索引过程任意时刻都可立即取消；也未独立验证新旧 generation 竞争，或把取消和已进入同步 SQL 临界段的提交严格串行化。
