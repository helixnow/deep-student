# 需求覆盖与验收

日期：2026-11-03。分支：`feat/handwriting-annotation-chat`。最终验证由主 agent 运行；子 agent 负责探索和实现，个别擅自测试的过程偏差如实记录。已本地提交主实现 `7fef25ec` 与来源背景重绘修复 `bc48e6eb`，未 push / merge / publish。

> **下半部为历史验收基线，不是当前源码最终全绿声明。** 用户2026-11-04明确恢复实施，undo容量、跨失败block authority、双TS／ratchet／分层、真实Wry双尺寸渲染及草稿／概览恢复缺陷已闭环；创建由仓库同事务writer guard接管，命令23／工具33／菜单7主验通过。本轮代码和可运行的本地门禁已收尾，最终四库1079／361／562／752、schema覆盖11、production迁移52、Phase5、Clippy和fmt均通过；未变范围保留八片证据，不伪称最后全8片单次全绿。最新结果以 [唯一交接](HANDOFF-IMPLEMENTATION.md) 为准。旧手机预览问题尚未用新APK复验，见 [当前问题](issues/android-import-preview.md)。代码收尾后用户另行授权Android设备测试：两种ABI构建成功，新ARM64测试包已验签并保留数据安装；真机锁屏，业务功能和根因仍未确认，详见 [真机取证](issues/android-import-preview.md#7-2026-11-04新包与实机bug抓取)。没有Git提交／应用外部模型请求；旧11次模型、模拟器与APK均仅历史证据。

## 后续真机新增问题

| 项目 | 当前结果 |
| --- | --- |
| ARM64安装身份／应用启动 | 新ARM64测试包已验签／ABI／16KiB并保留数据安装；实际安装SHA256 `94c0c769d2eb44cc945590bacbb23d4fd1e5e397da4388d79cfb2fbe1da17174`相同，应用进程运行；锁屏下不算业务通过 |
| 实际文件预览 | **旧包缺陷尚未用新包复验**：观察到octet-stream／无扩展名条目显示不支持预览；个人原始字节／当次入口未读取，自动修复链已有回归，真机自建SAF复验待执行 |
| 新功能／修复 | A–E代码保留并补齐board自动保存／连续书写；108项Ink CT、真实Wry同crop 200/400两图像素/hash/source、双TS／lint ratchet／分层通过。完整Rust8片首轮8193pass/2同根因fail，immutable artifact分类修后schema覆盖11/11；创建命令23／工具33／菜单7通过。最后受影响四库app1079／storage361／sync562／VFS752、schema覆盖11、production迁移52、Phase5两case、Clippy及fmt全部通过；future-floor typed映射已验，不冒称provider／Windows／私有fixture或真机通过 |
| 真机手写体验 | 压感／手掌误触／性能仍未验证；不能由安装或启动推导通过 |
| 新包实机bug取证 | UID限定928行日志及180s实时捕获完成；设备全程锁屏，只有6次无栈资源ID异常，未与业务操作关联。release前端日志盲区已核，根因待解锁／应用默认诊断包；不是修复GREEN |

## 功能覆盖矩阵（此前冻结基线）

| 需求/风险 | 实际证据 | 结论 |
| --- | --- | --- |
| `.dsink` 契约、严格解析、有限数字与预算 | 格式、纯操作/对象撤销、公共错误码；稳定库含原VFS680，UI图片引用修复后完整VFS681追加通过 | 通过；manifest 是唯一内容事实源 |
| 独立空白笔记、CAS、原子保存重开、复制、清除 | 真实 migrated SQLite + blob，引用/失败回滚/两连接锁序测试 | 通过；通用 upload 兼容性回归已消除 |
| 同步、冲突双方依赖、GC、不可变 artifact | 完整 sync545，含缺 blob 隔离/补传、资源 hash 镜像、artifact pin | 通过 |
| 真实备份恢复与迁移 | 数据库和 blob 资产备份/恢复；storage334 完整库测试 | 通过；非 PartialOverlay 假恢复 |
| 共享 renderer、笔/高亮、压感降级、坐标/裁剪 | 真实 Canvas 像素与几何/输入单测 | 通过；不能代替真实硬件体验 |
| 编辑器、多页、橡皮、undo/redo、缩放/touch、改名 | 编辑器28 CT 纳入修复后完整浏览器55项，包含背景生命周期三项RED→GREEN | 通过 |
| 自动保存、草稿、IDB失败、隐藏/卸载、并发冲突 | pagehide、storage-error、own-save echo、active stroke、远端 epoch 清历史回归 | 通过；不静默覆盖草稿 |
| PDF/图片固定页与源高亮 | 真实 PDF CropBox/rotation/页序像素；图片完整页；固定PNG不再误当 rawPDF | 通过；shared PDF worker 唯一权威且资产匹配 |
| 源变化、源purge与发布版本闭包 | 真实 source drift、高亮版本 render ID、purge可读、writer-locked checked publication | 通过；来源改变明确失败，Ink自己持有背景 |
| Workbench、经典壳与直接DSTU入口 | path-only registry 测试、MIME/扩展优先级、菜单与 public entry；分层无新增 | 通过；复用同编辑器，不新建 DstuNodeType |
| 原始JSON不进入正文/OCR/RAG | extractor、OCR前置拒绝、清理旧index units、direct resolver真实DB测试 | 通过 |
| UI→Chat与导出 | host点击先flush→不可变PNG→图片ContextRef；产物稳定ID打开 | 通过；不自动发送消息或调用模型 |
| 六工具 schema / descriptor / roster | strict CSP-safe schema、生产注册与 access/timeout/无headless执行策略 | 通过 |
| create/get/apply真实执行 | 真VFS create/get/100 ordered ops、裁剪映射、过时图/版本、幂等/取消 | 通过；get不返回点数组 |
| 精确破坏性审批 | actual hook/manager，拒绝/取消、FullAccess/Plan/global/group不可绕过 | 通过；never-remember |
| PREPARED/COMMITTED回执与可信undo | 真实Chat+VFS、父会话/工具/call/input校验、terminal持久化失败真相、undo6 | 通过；保护后来人类对象，跨调用重试链接原authority |
| prepare/export应用任务 | 真实bus身份、临时引用清理、队列取消、timeout通知、samePNG跨doc索引、PDF预查retry | 通过；已纳入最终全app1050绿 |
| 真实图片compiler与共享预算 | 最大4图、4MiB/2048单图、总16MiB；整轮原子预算和已有user图扣除 | 通过 |
| live/history/multi-variant图片与失败闭包 | 实际两个caller、完整工具轮后插图、final anchor精确重放、失败工具文本历史、缺anchor/DB失败 | 完整 Agent1965 passed / 6原有ignored / 0 failed |
| 三Provider实际请求 | 真LLMManager→生产adapter→本地HTTP：Chat Completions / Responses / Anthropic | 3/3通过；真实typed image、轮尾位置及精确PNG字节；不是实际模型识别质量 |
| typed refs前端恢复、工具卡 | restore合并/unsaved refs、known Ink卡、伪MCP隔离、打开文档/产物、受信任undo | 通过；最后card+restore37/37 |
| DOCX/PPTX逐完整页本地固化 | 多页、表格、底部图、双图顺序、chart、外部关系拒绝、ZIP/实际解压预算 | 通过；不宣称原生Office高保真 |
| PNG/扁平PDF、页序比例/笔迹、原件不变 | 真实像素/取消/源不变；VFS导出 receipt与独立文件 | 通过；PDF是栅格扁平输出 |
| 类型 / lint / 分层 / 许可 / i18n | typecheck最终通过；lint/ratchet4611旧warnings/0errors/无新增；25crate分层；许可OK | 通过；i18n仍有180存量缺键默认告警，未借此掩盖新Ink键 |
| 格式 / Clippy / 构建 | fmt项目级最终检查；workspace all-targets -D clippy::correctness；生产build 8GiB命令级 | 通过；style/chunk旧告警保留 |
| Android真机压感/手掌误触/延迟/内存 | 需要真机 | 未验证：无设备 |
| 真实视觉模型识别手写标记 | 当前视觉配置、自建control／marked夹具；工具render和UI图片均真实传图，11/20次实际请求 | 通过所测场景；包含一次UI附件失败后修复成功，不承诺任意手写准确率，无个人资料外发 |
| Android API36 x86_64 WebView | 创建／多页／touch／undo-redo／强停重启／导出；PDF／图片prepare与背景保存重绘、橡皮及重启 | 所测场景通过；来源背景异常已复现修复再真机前模拟器复验，详见closure-android-final |
| Android ARM64与真机 | 官方配置测试包与签名／ABI／16KiB／权限／体积另列 | ARM64不在x86模拟器上运行；真实压感／手掌误触／性能、API24和Android模型未验证 |

## 最终命令与证据

不同套件有重叠，不能把下列数字相加成独立测试总数。

| 门禁 | 最新日志 | 实际结果 |
| --- | --- | --- |
| 完整前端四分片 | `closure-background-vitest-shard-{1,2,3,4}.log` | 追加修复冻结源码四片均exit0；12670 passed / 4 skipped / 5 todo；1605文件通过、1文件skip |
| 全Ink/既有PDF导出浏览器CT | `closure-background-browser-full.log` | 55/55 passed，exit0，workers1；含来源背景生命周期与跨页undo回归 |
| PDF共享worker静态及实际转换 | `pdf-worker-static-final-r2.log`、`pdf-worker-prepare-final-r5.log` | 静态8通过；PDF/image实际2通过 |
| 完整稳定Rust库（排除当时仍修改的Agent/app） | `workspace-libs-final-r1.log` | 23 suite，4059 passed / 0 failed / 6 ignored / 1已知proxy filtered，exit0；含VFS680/sync545/storage334 |
| 完整Agent库 | `agent-full-final-r5.log` | 1965 passed / 0 failed / 6既有ignored，exit0 |
| 完整应用库 | `app-full-final-r3.log` | 1050/1050 passed，exit0，179.41s；旧migration-version断言已精确更新20260912 |
| 打包共享fixture解析/操作 | `ink-packaged-fixture-final.log` | 24/24 passed，exit0；新fixture非忽略，旧文件不删除 |
| 原生命令ACL | `app-acl-final-r3.log` | 4/4 passed，exit0 |
| Phase-5原生集成 | `closure-phase5-green-r3.log` | 两case均PASSED、exit0；旧作者契约与其后暴露的GTK隔离／ChatV2State／异步状态问题均精确闭合，原失败日志保留 |
| LLM完整（proxy隔离） | `llm-full-final-without-proxy-r1.log`、`llm-final-proxy-isolated-r2.log` | 857+1分开通过；非一次完整858运行 |
| 三Provider真实HTTP图 | `ink-provider-http-r5.log` | 3/3 passed，exit0 |
| 严格schema/新增预算/PDF单authority | `schema-and-pdf-final-r2.log` | 21/21 passed，exit0 |
| card打开/typed恢复 | `ink-card-final-green-r1.log` | 37/37 passed，exit0 |
| Clippy correctness全target | `clippy-final-r2.log` | exit0，最终冻结代码全workspace/all-targets，存量style warnings保留 |
| 生产前端build | `frontend-build-final-r3.log` | exit0，1m7s，包含最终工具卡；命令级8GiB，未改构建配置 |
| 格式 | `fmt-final-r8.log` | exit0，所有Rust owner冻结后项目级检查通过 |

## 显式预算与兼容性裁决

新Ink六工具严格schema去重后估算2851 tokens。旧工具组上限51500保持不变，新Ink独立<=3000；schema+prompt独立<=3200。合并护栏分别54500/79800，实测54150/79688。该成本只属于激活的新技能组，不通过删工具、放宽严格解析或修改lint基线掩盖。

依赖锁文件未改，不新增运行时依赖，不安装Office/Docker或外传转换。Office固定本地预览、PDF扁平栅格、固定分页均为批准边界。旧失败与编译/夹具阻断原始日志保留于verification；已修的RED不会删记录，0 tests不当成功。

## 交付文件与恢复

- [使用说明](usage.md)
- [当前架构](design.md)
- [主agent基线审查](reviews/final-review.md)
- [当前问题与新计划](roadmap.md)
- [文档治理与历史查询](governance.md)

当前入口为 [README](README.md)。旧HANDOFF、implementation-plan、progress和closure-progress已退出活动目录；原文在本地归档及 `d48bec38` 可查，不得从其中恢复已经结束的任务。主实现 `7fef25ec`、修复 `bc48e6eb`、基线文档 `d48bec38` 均已创建；本轮文档治理不包含新的提交。
