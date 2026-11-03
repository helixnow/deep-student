# 收尾交接 — 最终审阅、本地提交、真实模型与 Android 测试 APK

> **2026-11-03 最终收尾更新：软件实现、授权的真实模型验收、模拟器smoke和最终ARM64测试签名APK已完成。** 下方旧交接原文保留历史，不把其“仍运行／待修复／未提交”重新当作当前任务。

## 最终恢复摘要（优先于下方历史快照）

- 分支 `feat/handwriting-annotation-chat`；主实现本地提交 `7fef25ec81628ecae55fa6452ff27e54f5da9c72`，追加修复 **`bc48e6eb42caaeaee894346b155b5e52f0ad8d55`**。后续集中文档以单独docs commit记录，`git log`可查；不amend已有提交、不push／merge／publish。
- 真实模型最终仍 **11/20** 实际请求，输入97,449／输出3,191tokens。当前视觉配置／供应商未变，只自建资料，代理已停；没有新增Android模型请求，不再重开一轮20次。详见 [真实模型报告](verification/closure-real-model.md)。
- 新发现的PDF／图片背景保存后DOMException已闭合：旧ImageBitmap提前close，改为published state lease清理；主agent3项真实RED→GREEN，完整浏览器 **55/55**、追加修复后前端四片 **12670pass／4skip／5todo**、type／lint棘轮／分层通过。Rust／Agent／app／Phase5等既有本轮门禁不因这次纯前端修复重编写结论，具体日志见 [结果矩阵](verification/closure-results.md)。
- Android修复包实际完成PDF新增蓝线3objects／undo2／redo3／翻页；图片新增红线2objects／橡皮1／Undo2，HOME＋强停重启后两份canonical及真实UI均保留，限定日志无此前DOMException。空白多页、触摸／缩放、PNG／PDF导出、AskAI真实PNG附件均已验，未自动发送模型。详见 [Android最终报告](verification/closure-android-final.md)。
- 最终ARM64构建task `exec_4b1950f2-6336-4c99-828e-119537682b0a` **已exit0**；日志 `verification/closure-official-arm64-build-r2.log`，不要再启动。首轮候选不交付。
- **最终APK**：`build-android/DeepStudent-0.11.0-arm64-mobile-slim-ink-test.apk`，135,634,180bytes；SHA256 **`6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf`**。相邻 `.apk.sha256` 和 `.build-info.json`已写，详见 [APK核验报告](verification/closure-apk.md)。
- 包内source hash已核对bc48e6eb，build15983、version0.11.0／code214586；仅arm64-v8a。独立测试证书SHA256 `edf4c9868fbc1eb197aceaeb98fcad74d074d3a3cbb2af1ea16ecba1b58e3397`，v2/v3签名通过；版本／权限／ZIP与ELF16KiB／主库127790456≤262144000护栏均通过。
- **测试证书不是生产签名**，不承诺覆盖正式安装；不要卸载生产版绕过冲突。APK／keystore／rawlogs／临时profile路径不入Git，没有把用户密钥嵌入APK。本地JDK21与CI17差异已披露。
- 真机压感／手掌误触／实际性能、API24实际运行、Android内模型调用、最终ARM64包真机运行仍未验证。x86模拟器运行单独诊断包，不混称ARM64运行验收。
- 所有编译／回归已结束，无需重跑模型或全量测试。模拟器／Vite／UIbridge只属本轮测试进程，可在不影响其他任务时停止；保留测试AVD／笔记／正常profile，不删数据。
- 集中文档98文件已显式审阅，最后以独立本地docs提交记录；不stage目录全量、不force-add日志，验收身份不随docs-only HEAD变化而重建。运行`git log -3`即可核对最终文档提交，不需要因旧历史快照再重跑或重建。

---

## 原始交接快照（历史保留，不是待执行清单）

以下为用户第一次要求压缩上下文时的交接原文及当时的中间状态。其任务ID、仍编译、缺口、源码SHA和下一步都属于历史时点；以本节前的最终摘要和独立最终报告为准。

## 1. 真实用户要求与批准边界

本轮用户原话：

> 最终审阅，本地git提交，进行真实模型验收，解决测试失败，同时先用安卓虚拟机进行测试，随后依照官方构建方式构建测试apk

随后用户选择：
- 真实模型：**应用当前视觉模型**。
- 调用上限：**最多20次实际模型请求，包括工具续轮、失败和重试**。

完整收尾方案已通过 ExitPlanMode 批准，集中版为 [closure-plan.md](closure-plan.md)。持续适用：
- 子 agent 探索／修改／编写测试；**主 agent 审查并亲自运行最终验收**。子 agent 不再派生，不自行 commit／push。
- 沿用现有功能分支，不另建分支或 worktree，不清缓存、不 reset／clean／restore 未提交现场。
- 只授权**本地 Git 提交**；不 push、PR、merge、publish。
- 只外发自建夹具，不发送用户资料；不打印密钥、完整模型配置、base64、原始 HTTP 请求体。
- 不擅自切模型／供应商，不安装 Office／Docker／系统软件，不改 `.gitignore`，不 force-add 忽略文件。
- 所有方案、过程、失败和验收记录继续集中在 `docs/handwriting-annotation/`；保留历史，不删除旧 ledger。
- Android 模拟器不能代替真机压感、手掌误触、实际延迟／内存体验。

## 2. Git 与目录的精确现状

- Git 根／当前工作目录：`/home/xutao/deepstudent/deep-student`。
- 外层 `/home/xutao/deepstudent` 不是 Git 根。
- 分支：`feat/handwriting-annotation-chat`。
- 原 BASE：`6c73530d87f3180c2ff555dd5729943a77086dc3`。
- **当前 HEAD／已创建本地源码提交：`7fef25ec81628ecae55fa6452ff27e54f5da9c72`**。
- 提交标题：`feat(ink): add handwriting annotation and visual chat workflows`。
- 该提交包含 **187文件，37939 insertions／290 deletions**，含上一轮全部 Ink 新增源码、fixture、测试及本轮修复；不是只提交 tracked diff 漏掉新文件。
- 未推送、未合并、未发布。
- 交接核查：`git diff --quiet HEAD -- src src-tauri scripts tests package.json playwright-ct.config.ts` **exit0**；tracked 工作区与 index 无差异，**没有未提交业务源码**。
- `package-lock.json`、`src-tauri/Cargo.lock`、`.gitignore` 保持不变，没有新增运行时依赖。
- **整个集中记录目录仍是未跟踪文档／证据**，尚未做文档提交。本次交接前 `git status` 161行（分支行+约160文档／证据），之后新增本交接与文档更新仍未提交。
- 旧 `README`／`acceptance` 顶部已开始更新；其他历史段落仍会写“未提交／模型未授权／Phase5失败”。这些仅为旧快照，不据此重做已经完成的任务。
- 待最终文档提交：审阅并显式暂存方案、使用说明、审查、最终结果和交接等可交付文档。**不要 `git add -A`**；不要把临时路径文件、模型凭据、keystore、APK、生成目录和原始日志混入提交。
- 原始 `.log` 受既有 ignore 隐藏，最终数字和命令必须留在可提交 Markdown；不 force-add 日志。

### 已交付诊断 APK（非最终 ARM64）

`build-android/DeepStudent-0.11.0-x86_64-ink-diagnostic.apk`
- 590,794,788 bytes（debug 无优化，所以大，不能用于正式发行体积结论）。
- SHA-256：`d0d8363b863d2a939eb5d43c3c594eba564b0ea8cd57029ad69471f3346fe545`。
- `build-android/x86_64-diagnostic.sha256` 已记录。
- 包名 `com.deepstudent.app`，versionName `0.11.0`，**versionCode `214586`**，ABI 仅 `x86_64`。
- v2 测试签名验证通过，已安装到新 AVD。
- 来自 `closure-android-build-x64-r4.log`：exit0；该轮构建发生在本地 commit 前，源码树等价于7fef25ec，但生成版本的 git hash 可能仍是6c73530d，**不要把诊断包版本身份说成 ARM64 最终交付身份**。

## 3. 现在仍在运行什么（恢复后先核实，不重复启动）

下表区分仍运行任务与交接期间收到的最新完成通知，**本次用户没有要求停止它们**。ARM64构建及AVD/bridge/Vite继续保留；冻结四片与隔离原生app已自然结束：

| 任务 | Task ID | 日志／当前已知状态 |
| --- | --- | --- |
| 官方配置 ARM64 release APK | `exec_d3f32b39-9143-4189-aa01-a42d4f8d699b` | `verification/closure-official-arm64-build-r1.log`；交接时正在 Rust release 编译，尚未产物／退出码，PID cargo538634／tauri536508（PID只作线索，恢复需核实） |
| 最终冻结源码前端四片串行 | `exec_b686d919-73e3-423f-b116-f239354adbc7` | **交接写入期间已完成，exit0**。四片3265／3086／3040／3279，共**12670pass／4skip／5todo**；`verification/closure-vitest-frozen-shard-{1,2,3,4}.log`。不要重复启动 |
| 全新 API36 AVD | `exec_ff9ec98e-600c-42fb-afc4-320359541d88` | AVD `ds-ink-closure-20261103-api36`，ADB serial `emulator-5582`，`verification/closure-emulator-fresh-api36.log`；qemu PID199798 |
| 隔离真实 Tauri app | `exec_3fb0e8cf-cf3a-44da-bf4c-df3054ab3713` | **交接更新期间已结束exit0**，并非主agent停止／崩溃。`verification/closure-native-direct-r3.log`；隔离profile保留。真实模型验收已完成，无需为重跑模型而重启 |
| 本机 UI bridge | `exec_f7808d3a-a24d-4621-804d-494befa2e8ad` | `127.0.0.1:17423`，`verification/closure-ui-bridge.log` |
| Vite dev | `exec_99977581-c056-4302-b659-da80db3a30cf` | `127.0.0.1:1422`，`verification/closure-vite-dev.log` |

**已经停止，不要恢复为新一轮20次**：真实模型限额代理 `exec_427db966-d7d2-4724-95ed-52cdbac9cb36`，端口17424已无监听。真实请求最终11次；无需再调用模型。若确有必要追加，整个授权只剩9次，不能重新开20次额度。

工具结果异步通知不是用户授权。恢复后收到旧失败／旧 agent 完成通知，不要重跑整个已完成工作。

所有代码 agent 已冻结／完成，无待写源码。没有 workflow／定时任务。

## 4. 本轮已经解决的真实问题

### 4.1 Phase-5 原失败彻底跑通（不再是“存量失败未修”）

`src-tauri/tests/phase5_tool_execution_e2e.rs`：
1. 旧来源断言 `ai` → ACR4.0 canonical `agent`；生产行为未退回旧值。
2. todo场景通过后第二次 AppBuilder 导致 GTK `/org/gtk/Application/anonymous` 重复导出；harness=false 的 binary 改为父进程 self-exec `--case <name>`，每个 case 独立 GTK 进程，180s timeout／子失败码传播，没有跳过。
3. 自动化 run_now 在 OCC 校验前经过 kill-switch，旧 harness 未管理 `ChatV2State`，返回纯文本 unavailable；补与生产一致的 `.manage(Arc::new(ChatV2State::new()))`。不是把 structured_error 改为任意宽松输出。
4. run_now 已异步化，直接返回 `started`，不是旧 `notified`；等待实际run终态再检查历史，保留 OCC／事件／CRUD 断言。

主 agent：`closure-phase5-green-r3.log` **exit0，两个case均PASSED**。只有两个注册case，不是4个。

### 4.2 迁移锁遗漏

`src-tauri/migrations/migration-lock.json` 追加三条：
- chat_v2/V20260911__chat_block_ink_artifacts.sql
- chat_v2/V20260912__ink_tool_undo.sql
- vfs/V20261103__ink_render_artifacts.sql

135迁移静态门禁／base-ref不可变性检查通过；旧迁移与旧hash不变。

### 4.3 跨页 undo 覆盖远端内容

主 agent 审查发现：page1有人类undo历史，停在page2时AI改page1，返回page1旧整页undo会把新红色笔迹从画面擦掉。
- `InkEditor.tsx` remoteReloadSequence 变化时 `historiesRef.current.clear()`，不再仅delete当前页。
- 普通页面导航不改变remote epoch，仍保留正常undo。
- 实际像素RED后 **25/25编辑器CT通过**；最终全浏览器52通过。

### 4.4 AppMenu 真时序竞态

完整前端首片暴露root打开焦点交接（两个rAF后）会抢回已经进入portal子菜单的焦点。
- `AppMenu.tsx` 交接前如焦点已在同menuId内部就return；补ctx.menuId依赖，告警不增加。
- 新fakeTimer测试第一版不红，不算证据；修正await act／rAF分步后主agent见真实RED，再GREEN。
- keyboard12、完整首片3265通过。没有删／弱化原重渲染Beta焦点断言。

### 4.5 Android 默认特性泄漏

官方 CLI 指定mobile-slim仍因 `tauri.conf.json build.features=[sqlite,lance,mcp]` 合并桌面特性，Gradle第二次cargo编译出现lance/mcp。
- `tauri.android.conf.json` 增 `build.features=[]`；不改桌面配置、不改CI CLI。
- Node merge契约测试RED→GREEN；真实Gradle cargo命令仅mobile-slim／tauri-custom-protocol，验证无lance/mcp。
- 所有Android构建仍 `--locked --no-default-features`。

### 4.6 PNG/PDF选择按钮溢出

选中variant=nav带w-full，PNG占满整行把PDF推出屏幕。
- `LazyInkEditor.tsx` 用紧凑 `outline`／`ghost`，中英文／原handler保留。
- 行为测试检查两种选中状态都无w-full；真实Android截图PNG/PDF均可见。
- 项目按钮contract把outline与ghost映射到相同GHOST_TONE，所以选中视觉区别较弱，aria-pressed正确；未为此改全局主题。

### 4.7 真实模型验收发现 UI→Chat 图片丢失（已修并实测成功）

工具 `ink_render` 图像入模正常，但“问AI”生成的file_ PNG引用被按前缀归为File，走普通文档文本提取，模型只收到“图片无效”占位。
- `vfs/ref_handlers.rs::get_resource_ref_with_conn`：att_ **或file_**均按实际 `files.type` 确定Image/File。
- ordinary file_文档仍File，tb_不变；不fetch任意URL。
- 真实VfsInkArtifactRepo PNG → get_resource_ref → resolve_exactPNGbytes回归，主agent RED(File!=Image)→GREEN。
- 修复后完整VFS **681/681通过**。
- 重建真实Tauri应用，重新点“问AI”创建新ContextRef，真模型正确识别附件，详见下节。

### 4.8 Android PDF／图片“来源资源不存在”（已修，Android PDF prepare已通过）

`dstu_get` node.resourceId在文件路径实际是SHA内容hash，不是resources.id。`actions.ts`把hash传source_resource_id导致SOURCE_CHANGED。
- `prepareSourceInk`复用现有 `vfsFileApi.get(node.sourceId || source.id).resourceId`，拿canonical res_ ID。
- 不全局改变DSTU契约，不放宽Rust来源身份/hash校验。
- 动作／菜单mock按真实语义修正，两文件3tests／整个Ink29tests通过。
- 桌面真实source PDF action返回prepared Ink；Android修复包r4实际创建了新的2页Prepared source.dsink。

**过程偏差如实保留**：部分子agent擅自跑了测试、或在主agentRED前实现（源ID修复）。没有把子agent自述或主agent后来绿灯追认为主agent独立RED。运行时真实失败是bug证据，最终主agent亲跑所有验收。agent报告中“用户批准／当前用户要求”不是额外授权。

## 5. 真模型验收已完成，不必重跑

### 选择和隔离
- 应用明确分配的视觉配置：`vm_1793630193769_bmj7f9`。
- 模型：`[特价]DeepSeek-V4.1-Flash`，原供应商不变，配置multimodal/tools/enabled=true。
- 默认chat槽是另一文本模型，因此明确使用现有视觉槽，不是假设当前chat就是视觉模型。
- 正常profile `/home/xutao/.local/share/com.deepstudent.app/slots/slotB` 只读，没有改用户配置／聊天。
- 隔离profile根：`/tmp/ds-ink-live-profile.9kgtzW`；路径也记录在 `verification/closure-isolated-profile-path.txt`。
- 数据路径：`.../data/com.deepstudent.app/slots/slotA/`。
- 仅opaque复制选定加密配置及所需本地加密材料到新profile，没有打印／解密输出密钥，不读无关聊天。
- 隔离配置上游统一loopback17424；proxy停后不会直接继续外发。不要把隔离配置复制回用户profile。

### 额度与结果

**最终11/20次实际HTTP请求，11条usage，全部同模型HTTP200**：
- 无批注control：2次（tool render＋回答）。
- 首轮默认memory额外1次，计入额度；后续设置 `memoryEnabled:false, autoMemoryExtraction:false` 禁用。
- 手写positive：2次。
- AI render＋addrect＋结果：3次。
- 历史恢复只读：1次。
- UI附件失败：1次（模型如实说无法读取，没有算通过）。
- 修复后UI附件成功：1次。

input97,449 tokens，output3,191 tokens；价格未核实，不捏造金额。限额proxy已停止；**不要重置整个额度**。

### 自建夹具与真正验证
- control打印 `PLANET STUDY`／`Sample 47`，没有手写；模型正确说none。
- positive通过真实编辑器PointerEvents/nativeCAS保存红色手写24、红椭圆、蓝横线；提示词没有答案，tool get也没有笔迹点数组答案。
- 模型准确识别24、红圈、蓝线。
- 模型真实add绿色矩形author=ai、committed、可信undo_available=true。
- 人类后加蓝色短线，opaqueChatIDs undo移除AI矩形而6个人类strokes保留。
- 重载UI后只用persisted旧不可变图历史回答，正确区别control和positive；没有重新render冒充历史。
- PNG／PDF真实VFS导出成功。
- UI“问AI”实际生成image ContextRef且不自动发送。修复后generic context compiler真image块＋native staging，模型从附件正确读24/红圈/两条蓝线并指出无绿色矩形，不靠工具fallback。

### 证据／固定ID

自建测试会话：`sess_a0ffd1c2-525c-4e60-8354-498a477ab550`。
- control文档：`file_ink_667d500cb54ea6a55bce1e748d5aa2cd20e510e8b7e72e94ba5ee456508e03d8`
- positive文档：`file_ink_copy_61fcf27b48ee1b0aa3d1dabf6c888e76f30c7a75cf7417aecfcc4e689f5378d4`
- positive页：`p_ktn5YmKnRYUr`
- AI apply消息：`msg_99302e94-180b-44a4-8278-b96cce21fc10`
- AI apply块：`blk_a6a583d8-d219-4f88-a642-40e6f4497336`
- 修复后UI附件成功最终消息：`msg_ef597c00-6a42-496a-9883-920ece4b44e9`

证据文件：
- `verification/closure-live-provider-events.log`（metadata only，计数为准，忽略日志不强加）。
- `verification/closure-live-usage.json`（白名单usage字段，无密钥）。
- `verification/closure-real-model-evidence.json`（**仅此自建会话**的提示词／回答／工具／typed refs）。
- `scripts/dev/ink-acceptance-proxy.mjs`＋`scripts/__tests__/ink-acceptance-proxy.test.mjs` 已入源码commit。

真实app自动化：Linux的 `ds-test status` 调用了Swift不可用；直接复用现有loopback `/eval`，不必修一整套新自动化。
```js
// 用Bash的Node或curl调用现有本机服务，不是外部BrowserControl。
const response = await fetch('http://127.0.0.1:17423/eval', {
  method:'POST', headers:{'content-type':'application/json'},
  body:JSON.stringify({code:'return window.__DS_BRIDGE__.snapshot();'})
});
console.log(await response.text());
```
`/eval`15s超时，长任务先启动promise再另调观察；代码在真实主WebView执行。不要输出完整 `get_api_configurations`（它可返回解密后的密钥）。只投影id/name/model/capabilities。
页面HMR会丢window临时handles，依据固定测试ID重新取；不能把HMR断桥当产品数据丢失。

## 6. Android环境与验收停点

### 工具链／旧AVD陷阱
- SDK `/home/xutao/Android/Sdk`，platform/build-tools36，NDK29.0.13846066。
- Java `/usr/lib/jvm/zulu21`，实际JDK21.0.13；CI JDK17，允许本机满足17+但要披露差别。
- Rust1.98.1已安装（官方CI），stable另存在。
- KVM accel-check实际可用。
- 三个旧AVD都是x86_64，没有ARM native bridge；ARM64 APK不能安装这些AVD。
- 初始 `ds-ink-p0-api36` 用read-only启动5580，pm看不到app却留Oct30空`.master_key`；正确failclosed启动崩溃。
- 没有自动删旧密钥／重生／清数据。改用**全新**`ds-ink-closure-20261103-api36`，5582；key正常44bytes、应用正常启动。旧read-onlyAVD已停止，原数据不变。
- 不因旧空文件擅改crypto策略；任何自动重生可能丢凭据。

### PDFium
x86_64从官方chromium/7350资产取：
- Archive SHA256 `156d86099d2704badd2c79f2f39a40be979bb804a99ea130a45098e8d5de297b`。
- ELF SHA256 `14e3bdd53b68840c24ed6ef25e1e9441c9a02aa713b3f80ca710e4903443b55f`。
- 5,142,432 bytes，ELF64 x86_64 Android，独立空tmp下载、Python-I仅提取指定regular ELF，验证ABI。
- 没有把新二进制force-add；只放generated JNI。
- 现在为了ARM64包干净，x86 JNI整个目录已**移到** `build-android/x86_64-jni-preserved/`（含so及symlink）。这是本轮生成目录，不是删用户数据。
- 当前gen JNI仅arm64-v8a，已有受控ARM64 pdfium，ELF LOAD对齐0x4000已检查。

### 已通过的Android真实操作（ADB/UI/nativeDB）
- 新AVD安装、启动、升级，不卸载或清测试笔记。
- 实际资源库New→Handwritten note，开启touch后两笔swipe。
- native VFS读回2stroke对象；undo1、redo2。
- append2pages。
- HOME＋force-stop＋启动后canonical2pages/firstpage2objects保留，真实UI重开可见。
- PNG当前页导出20731bytes，PDF两页导出10266bytes，均真实VFS文件且应用打开。
- 修复包r4 PNG/PDF格式按钮都可见，不再溢出。
- 修复后Android PDF菜单Handwrite Annotations **实际prepare成功**，source=resource，2pages，background.kind=pdf_page，新Prepared source.dsink正常打开背景。

### 最后停点／尚未闭合（不要冒称通过）

1. **PDF准备后新增一笔的验证尚未成功完成**：
   - 上一次尝试第一次读到page.objects=0；第二次基于uiautomator点touch后20s没观察到Touch drawing on，脚本返回 `RuntimeError: touch mode not enabled`。
   - 这可能是切页／层级刷新或坐标观察问题；不能当已确认产品缺陷，也不能当通过。
   - `verification/closure-android-pdf-drawing.json` **不存在**，因为没有验证成功。
   - 最后截图 `verification/closure-pdf-current-ui.png`；最后树 `verification/closure-pdf-current-ui.xml`，仅看到Prepared source标题，需重新观察真实截图／层级，不反复用旧坐标。
2. **图片来源prepare／批注尚未实际闭合**。已有生成的`ink-export.png`可用于验证，无需个人图片。
3. 尚未实测真机pressure/palm／性能；API24兼容smoke没有执行。不可用API36代替这些结论。
4. Android内真实模型未调用，真实视觉识别是在桌面真实Tauri完成；不要写成Android模型验收。

### Android测试数据稳定ID与查验

- 空白两页note：`file_ink_d106ce669c1dadaa530d9456a45078ba8d06090fcdbe274a3d83bf6500696e66`。
- PDF来源：`file_5RbR-TvwaI`／`res_xQWmQJAp_Y`。
- PNG来源：`file_IYdVdqclPF`／`res_FaaAB1kyWx`。
- PDF准备结果：`file_ink_7a24bd250667e2233465d95416cad057669e568807c28595c3d7f34ad3536d4f`。
- 证据 `verification/closure-android-pdf-prepare-success.txt`。
- ADB全路径：`/home/xutao/Android/Sdk/platform-tools/adb -s emulator-5582 ...`。
- 新模拟器可用`/system/bin/sqlite3`，用run-as只读本轮app数据；不要输出`.master_key`内容。
```bash
adb -s emulator-5582 shell run-as com.deepstudent.app /system/bin/sqlite3 \
  slots/slotA/databases/vfs.db \
  '"SELECT id,file_name,mime_type FROM files;"'
```
- 实际手机viewport720x1280、density240（physical1080x2400）。**ADB screenshot的实际PNG尺寸为坐标准，不要依据旧图缩放推坐标**。
- `uiautomator dump`偶尔null root或0,0 bounds；单次失败后重新观察／有界等稳定，不用staleXML。
- 触控原始点确实进入共享renderer/nativeCAS；不以jsdom替代。
- 已有自建PNG/PDF在`/sdcard/Download/marked-source.{png,pdf}`，无需重新下载资料。

## 7. 官方ARM64构建：正在进行，等待结果后签名核验

### 权威与已做准备
- 权威 `.github/workflows/reusable-build-android.yml`；不是默认本地build_android.sh（该脚本默认features与CI不同）。
- `docs/handwriting-annotation/tasks/closure-android-prepare.py`：读取workflow**实际命名shell块**，同步Manifest／Kotlin／FileProvider／权限／图标／Bilibili／pdfium；ARM模式调用现有 `scripts/ci/prepare-android-gradle.mjs`。
- helper为本轮可复现工具，不是新构建系统；PyYAML已存在。
- `closure-arm64-prepare-final.log` exit0。
- Gradleprebuilt guard只允许aarch64 release；x86构建禁止DS_ANDROID_PREBUILT_NATIVE=1。
- ARM64 JNI干净，只含arm64-v8a，不打进x86诊断so。
- 生成版本预期versionCode由 `node scripts/generate-version.mjs --print-android-version-code` 得**214586**，不要用tauri.conf里的旧静态14641验包。

### 已启动的完整构建命令（不要重复运行）

```bash
ANDROID_HOME=/home/xutao/Android/Sdk \
NDK_HOME=/home/xutao/Android/Sdk/ndk/29.0.13846066 \
JAVA_HOME=/usr/lib/jvm/zulu21 \
RUSTUP_TOOLCHAIN=1.98.1 \
NODE_OPTIONS=--max-old-space-size=6144 \
CARGO_BUILD_JOBS=2 \
CARGO_TARGET_DIR=/home/xutao/deepstudent/deep-student/src-tauri/target-android-test \
CARGO_PROFILE_RELEASE_LTO=false \
CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
CARGO_PROFILE_RELEASE_DEBUG=0 \
GRADLE_OPTS='-Dorg.gradle.daemon=false -Dorg.gradle.workers.max=2 -Dorg.gradle.jvmargs=-Xmx2048m' \
DS_ANDROID_PREBUILT_NATIVE=1 \
CC_aarch64_linux_android=/home/xutao/Android/Sdk/ndk/29.0.13846066/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang \
CXX_aarch64_linux_android=/home/xutao/Android/Sdk/ndk/29.0.13846066/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++ \
AR_aarch64_linux_android=/home/xutao/Android/Sdk/ndk/29.0.13846066/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=/home/xutao/Android/Sdk/ndk/29.0.13846066/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang \
npx --no-install tauri android build --target aarch64 --apk --ci --features mobile-slim -- --locked --no-default-features \
  > docs/handwriting-annotation/verification/closure-official-arm64-build-r1.log 2>&1
```

- source commit7fef25ec；工作区源码核查clean。
- 交接时release还在编译，未签名APK尚未确认生成。不要读取旧debug APK当新ARM64。
- Cargo多feature组合／profile会反复重编译，不能因此清缓存或改依赖／盲改profile。保持资源限制，不开重复ARMbuild。

### 测试签名已准备
- `build-android/ink-acceptance-test.keystore`已生成，chmod600，仅本轮测试证书，不是生产密钥。
- alias `ink-test`；标准本地debug口令（可在本轮keytool命令／verification/closure-test-keystore.log核对），不需要用户正式签名凭据。
- keystore **绝不入Git**，不要输出私钥。
- 构建成功后，在新的产物路径下：
  1. 选择**本次ARM64 release unsigned APK**，核对mtime／nativeABI，不能用`find|head`误选旧x86。
  2. build-tools36 `zipalign -P 16 -v 4`，再apksigner测试签名。
  3. `apksigner verify --verbose --print-certs`，记录测试证书SHA256；不要冒充官方release fingerprint。
  4. `aapt dump badging`：version0.11.0、versionCode214586、ABI仅arm64-v8a。
  5. packagedmanifest检查RECORD_AUDIO／MODIFY_AUDIO_SETTINGS／POST_NOTIFICATIONS／REQUEST_INSTALL_PACKAGES等官方必需权限。
  6. 检查libdeep_student_lib.so+pdfium均在arm64路径；ELF ABI/LOAD16KiB，zipalign `-c -P 16`；native主库≤262144000bytes，不能忽略CI体积guard。
  7. 保存清晰测试名，例如`build-android/DeepStudent-0.11.0-arm64-mobile-slim-ink-test.apk`，SHA256、build-info（sourceSHA、生成versionhash、toolchain、features/profile、测试签名与CI差异）。
- 真实ARM64设备不在环境，不能把x86模拟器安装当此ARM64产物运行通过。
- 测试签名不同，不能覆盖生产签名安装；不要建议卸载来绕过冲突。

## 8. 本轮测试准确结果与仍在运行的冻结四片

不要叠加重叠套件。最终数字以日志真实退出码为准。

### 已完成

| 门禁 | 日志（verification/） | 真实结果 |
| --- | --- | --- |
| 前端完整四片的上一完整轮 | closure-vitest-shard-1-r3、2/3/4-r1.log | 3265+3085+3040+3279=12669pass，4skip／5todo，各exit0；1片在最后source-ID修复后又整片跑过 |
| **当前冻结四片复跑** | closure-vitest-frozen-shard-{1..4}.log | **已全部完成exit0：3265＋3086＋3040＋3279＝12670pass，4skip／5todo**；1605filespass／1fileskip。第2片多出的1项是最终格式按钮回归，不能再沿用旧12669 |
| 完整Ink浏览器 | closure-browser-full-r2.log | 52/52pass，exit0，workers1；首轮workers2时51pass1PDF5s超时，isolated2pass后完整串行全绿 |
| 编辑器跨页RED/GREEN | closure-crosspage-undo-red-r1→closure-ink-editor-green-r1 | 25/25真实CanvasCTpass |
| 稳定Rust workspace libs | closure-stable-rust-r1.log | 4059pass／0fail／6ignored／1proxyfiltered，exit0，23suite |
| proxy隔离 | closure-proxy-isolated-r1.log | 1/1pass，exit0；不是同次fullLLM858 |
| 完整Agent | closure-agent-full-r1.log | 1965pass／0fail／6ignored，exit0 |
| 完整app | closure-app-full-r1.log | 1050/1050pass，exit0 |
| 最后共享引用修复完整VFS | closure-vfs-after-ref-full.log | **681pass**，exit0（稳定workspace里的VFS是修前680，此附加回归覆盖新增修复） |
| Phase5 | closure-phase5-green-r3.log | todo＋automation两个case均PASSED，exit0 |
| app command ACL | closure-acl-r1.log | 4/4pass，exit0 |
| 迁移static/base-ref | closure-migration-final-r1.log | 135项门禁pass |
| migration scripts | closure-migration-script-final.log | 14/14pass |
| proxy+Androidfeatures | closure-dev-guards-final-r1／closure-final-tool-guards.log | 11/11pass |
| 全Ink+相关source菜单 | closure-ink-source-all-final.log | 29pass／8files，exit0 |
| 全Ink+AppMenu局部 | closure-focused-final-r1.log | 58pass／13files，exit0 |
| 最后source-ID类型 | closure-typecheck-source-final.log | typecheckexit0 |
| 分层 | closure-layers-source-final.log | 无新增，旧565基线不改 |
| lint | closure-lint-r2.log | exit0，4611旧warnings/0errors |
| ratchet | closure-ratchet-source-final.log | exit0，无新增warnings |
| crate层/i18n/license | closure-crate-layers-r1、closure-i18n-r1、closure-licenses-final.log | exit0；旧缺键告警保留 |
| Rust格式 | closure-fmt-last.log | exit0 |
| 最后Clippy | closure-clippy-after-ref.log | 全workspace/alltargets -Dcorrectness exit0 |
| 生产frontend | closure-production-build-r1.log＋x86r4 beforeBuild | finalr4含sourceID修复npm build已成功，官方ARM64也执行完整beforeBuild |

上述本轮门禁大部分在最终commit前源码冻结时完成；新增尾部修复按影响重测完整VFS／type/layers/ratchet／source相关tests，不重做无关设计。

## 9. 恢复后的最短下一步（按顺序，不重做完成项）

1. **先查看现有ARM64后台任务结果**，不要重新启动。冻结源码前端四片已经全部完成exit0（12670pass），不要重跑。若ARM64继续编译，做文档整理／剩余模拟器观察，不busy poll。
2. **补齐Android smoke真缺口**：在已有Prepared source PDF页用实际观察控制开启touch，新增stroke并nativeDB确认；验证image来源prepare／图上批注；若真实bug则测试→子agent最小修复→主agent测试，源码如改需新localcommit并重建ARM64（不能交付与sourceSHA不符的包）。如果只是automation观察错误，纠正观察，不乱改产品代码。
3. 当前源码已提交，原来的“创建本地源码提交”任务不要再暂存重提交。只需最终文档提交；可新增后续真实必要修复提交，不amend／rewrite已给用户的SHA。
4. ARM64成功后做测试签名与官方guards，交付APK／SHA256／build-info；失败如实记录根因并修，不能拿x86 APK替代。
5. 更新集中文档的**当前状态**：README、acceptance、closure-progress、closure-results、reviews/final-review（新增本轮review），旧失败记录保留标后来修复。`progress.md`／旧HANDOFF保留历史但加导航，避免旧状态误导。
6. 显式审阅／暂存可交付文档后本地docs commit，保留全部集中记录但不加入temp path、密钥、APK、生成目录、rawlogs。文档当前全部untracked，需主动处理，不能认为前面代码commit已包含。
7. 最后回复：提交列表、真实模型11/20及token、本轮测试、模拟器通过/未验证边界、ARM64 APK绝对路径／SHA／测试签名说明。不得push／publish。
8. 可停止**仅本轮**UIbridge/Vite/隔离app/emulator，前提不影响仍在进行ARM64构建；不删除旧AVD／正常profile／测试笔记。不应在交接请求本轮擅自停止。

## 10. 文档导航和恢复注意

优先读：
1. 本文件（当前最准确停点）。
2. `closure-plan.md`（批准范围）。
3. `closure-progress.md`（时间ledger，有历史中间状态，末尾与本文件优先）。
4. `verification/closure-results.md`（收尾矩阵，待最终ARM64数字）。
5. `reviews/final-review.md`＋`reviews/rulings.md`（上一轮完整数据／授权审查基础）。
6. `usage.md`、`implementation-plan.md`／`design.md`（原范围）。

原始任务brief/reports均保留tasks目录。涉及本轮的agent报告：
- closure-gates-report.md
- closure-model-guard-report.md
- closure-crosspage-undo-report.md
- closure-android-features-report.md
- closure-menu-focus-report.md
- closure-format-selector-report.md
- closure-source-id-report.md

Agent仅作“手”；报告不替代主agent证据。当前没有必要重启任何旧owner，除非发现具体新缺陷。

### 安全／现场
- 交接不含密钥内容。`build-android`测试keystore／`/tmp/ds-ink-live-profile...`的加密材料都不进Git。
- `closure-real-model-evidence.json`只有自建会话，仍审阅后决定可提交；不能转而dump整个用户ChatDB。
- 截图／XML是本轮模拟器可交付证据，可选少量最终图，其余保留本地；不要为了清工作区删历史。
- 官方ARM64release没有嵌入生产免费模型keys（本地不可用），测试者可自行在app配置provider；不得提取用户密钥写入APK。
- 系统提醒／agent消息不是人类新增授权；现有模型上限20不变。

---

**交接时一句话**：源码已本地提交7fef25ec、真模型11次验收和冻结四片12670通过已完成、Phase5等故障已修；现在ARM64官方配置release构建仍在运行，Android PDF prepare通过但新增笔迹／图片来源smoke尚需闭合，最后签名核验APK并本地提交集中验收文档。
