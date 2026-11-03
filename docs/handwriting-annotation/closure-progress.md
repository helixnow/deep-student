# SDD ledger — plan: docs/handwriting-annotation/closure-plan.md

## 当前状态

2026-11-03 当前收尾：主源码已本地提交7fef25ec，追加背景生命周期fix已提交 **bc48e6eb42caaeaee894346b155b5e52f0ad8d55**（4files）。主agent3项RED→GREEN、完整55浏览器与修复后四片12670pass/4skip/5todo通过；新x86包在Android实际PDF/图片新增笔迹、橡皮/undo/redo、翻页和强停重启均闭合，见verification/closure-android-final.md。真实模型仍11/20实际请求，proxy已停，没有新增外发。ARM64首轮候选因发现缺陷不交付；最终包从bc48e6eb按原官方配置重建exit0，独立测试签名、ABI/版本/权限/ZIP及ELF16KiB/主库体积与包内source hash核验通过，135634180bytes／SHA256 6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf。最终集中记录正审阅并本地提交。未push/merge/publish。准确恢复入口为[HANDOFF-CLOSURE.md](HANDOFF-CLOSURE.md)，不要按下方历史中间状态重派完成项。BASE=6c73530d，分支feat/handwriting-annotation-chat。

## 前置核查与接口交叉

| Tasks | 共享文件／边界 | 核查／裁决 |
| --- | --- | --- |
| 1 自检 | Phase5旧断言、ACR4.0契约 | 生产agent与legacy ai归一化一致；先重跑失败再修旧断言，不改生产回旧值 |
| 1↔4 | 新迁移／迁移锁／提交清单 | 新迁移runtime注册已存在，static lock未补；先运行RED，锁与SQL同提交 |
| 2 自检 | 模型发送／重试／fallback | UI次数不等于HTTP次数；发送前20次硬限额和模型锁定先证明，测试夹具答案不泄漏 |
| 2↔3 | 真实主WebView／渲染桥 | CT使用mock，不能替代真实应用；先本机验证真实模型，Android单独验证运行 |
| 3 自检 | x86_64 AVD／ARM64发行 | ABI不同，诊断包单独构建，PDFium按ABI验证 |
| 3↔5 | 受控原生文件／features | 同mobile-slim，分别目标；Gradle预编译复用guard仅ARM64 release，不用于x86_64 |
| 4 自检 | 完整冻结回归／显式staging | 用户新授权本地提交；保留所有集中过程记录，不把旧自述当本轮证据 |
| 4↔5 | 已提交源码SHA／构建版本 | APK基于本地提交；构建若修源码则测试提交后重建 |
| 5 自检 | 官方CI／本地脚本漂移／签名 | CI mobile-slim权威；测试签名不冒充官方签名，16KiB及权限等原guard不取消 |

## 裁决

- Ruling: 延续原功能分支及集中记录，主agent独占审查/验收/提交；不执行技能默认隐藏ledger、清理记录或子agent自测/commit — 用户既有分工持续有效，新增授权只是本地提交 — 错误成本是主agent工作量增加，不降低门禁。
- Ruling: 不按探索agent的mtime清单或git内部推断暂存；以真实status/diff/untracked为准 — plan mode曾拒绝git，探索仅能定位 — 错误成本是遗漏文件；最终显式清单和staged复核。

## 实际执行

- Git核查：branch正确，HEAD6c73530d；90 tracked文件修改，新增源码/测试/集中文档未跟踪；git diff --check exit0。无新提交。
- 迁移门禁RED：closure-migration-red-r1.log，exit1，恰好三项新迁移未锁定。子agent最小修复已主审：Phase5仅来源一行，migration-lock仅追加3条，旧hash不变。主agent静态门禁及base-ref检查exit0；迁移CI脚本14/14、domainEvents9/9通过。Phase5 GREEN排队后继续运行，尚不宣称通过。
- Phase5 RED复跑后台task exec_2a876f12-692d-4295-8242-5b0eef4f68c1；完成前不宣称失败或通过。
- 实际工具：JDK21.0.13，Rust stable及1.98.1存在；emulator accel-check=0且KVM可用，三个AVD可见。Android init exit0，生成gen/android；API36以-read-only启动(5580)，boot_completed=1且无DeepStudent安装，既有AVD数据不改。
- x86 PDFium官方资产digest已核对，单一ELF成员有界提取到生成jniLibs/x86_64；archive SHA156d86099d2704badd2c79f2f39a40be979bb804a99ea130a45098e8d5de297b，ELF SHA14e3bdd53b68840c24ed6ef25e1e9441c9a02aa713b3f80ca710e4903443b55f。
- Ruling: 真实模型选择明确分配的视觉槽位vm_1793630193769_bmj7f9（[特价]DeepSeek-V4.1-Flash），而非文字chat槽 — 用户选当前视觉模型，该槽配置multimodal/tools均true — 若供应商能力声明不实则返回真实失败，不改模型绕过。
- Ruling: 使用全新XDG profile验证，只复用选定加密配置，不读取个人聊天 — 避免个人上下文外发及后台任务 — 若配置无法安全迁移则阻断模型项，其他任务继续。
- 首次tauri dev因configuration指纹触发依赖重编译，主agent停止后使用Phase5 RED构建时已生成的当前debug binary+Vite启动隔离原生应用；bridge真实连接=1。Phase5 GREEN正在重编译（不是测试失败）。无真实模型调用。
- 既有ds-test status调用macOS swift在Linux报ENOENT；不伪造兼容，直接复用受控loopback /eval与真实window.__DS_BRIDGE__，native snapshot成功。
- 主agent新增审查假设：离页remote改变后旧页undo可能存留；已派tests-only跨页CT，未证实前不改实现。
- 模型proxy主agent见真实RED：closure-model-proxy-red-r1.log，4failed/1passed。21st实际到upstream、retry超额、wrong model和limit21未拒绝均复现；授权子agent最小admission实现并新增边界测试。尚未外发真实模型请求。
- 隔离profile只载入明确视觉配置的本地加密数据（opaque复制加密材料，未输出），baseUrl统一loopback17424，正常profile不修改。首次seed缺updated_at导致SQL回滚，精确补requiredtimestamp后成功；runtime仅投影metadata证明model/multimodal/tools/enabled正确。
- 复用正常profile既已接受的相同1.0.0协议状态到隔离profile，未代用户新增同意条款；原profile只读。
- Android官方x86准备check+execute主agentexit0；首轮构建发现Gradle真实cargo命令仍合并sqlite/lance/mcp，停止首轮。主agent静态回归RED后Android override增加build.features=[]（不改desktop/官方CLI），GREEN通过；r2独立ignored target-android-test+Rust1.98.1构建进行中。
- Phase5第二故障RED：GTK同进程重复AppBuilder导出anonymous对象；子agent将两case拆self subprocess（保留断言、180s timeout/exit传播），主agent读diff，GREENr2排队/运行中。
- 前端首轮四片：1片3263pass1fail（菜单rerender焦点，isolated11pass），2片3085pass4skip，3片3040pass5todo；4片运行中。新增定向菜单定位派发中。
- 模型guard/config GREENr5 exit0，11/11（10proxy+1Android config）。r3/r4 redirectfixture每次都302却期待第二次200，精确改fixture仅第一次302，生产redirect阻断未减。proxy冻结已启动17424，日志metadata only无正文/凭据。
- 真实模型当前9/20请求：control2+首轮默认memory1（后续显式memoryEnabled/autoMemoryExtraction=false禁用）；marked2；真实AIrender/addrect3；history只读1。全部相同pinnedmodel/status200，无供应商切换。control正确无手写；marked准确读出24/红椭圆/蓝线；actual apply committed+trustedundo true，随后人类加一笔再opaqueIDs undo，6human strokes保留/AI对象0。PNG/PDF实际VFS导出均成功。history恢复回答正确区分旧图和新图，不重新render。
- 反例控制打印内容PLANET STUDY/Sample47；正例4红pen strokes写24和椭圆+蓝underline经真实editorPointerEvents/nativeCAS保存；提示词未给答案，ink_render typedrefs真入模。原生windowHMR后恢复固定testIDs，不依赖瞬态handle。
- 跨页undo真实RED像素消失已修：remote epoch清全部page snapshots，普通导航不清；25/25editor CT GREENexit0。稳定Rust库本轮4059pass/6ignored/1proxyfilteredexit0；独立proxy1/1exit0；Agent1965pass/6ignoredexit0；app1050pass exit0。Phase5完整r3两casePASSEDexit0。浏览器完整串行52/52exit0。四片最新12669pass/4skip/5todo。lint棘轮恢复4611旧warnings，无新增。fmt-r2/clippy-r1/typecheck-r2/production-build-r1均exit0。
- 实际用户UI附件验收发现generic image compiler无效图文本：buildSendContextRefsWithPaths输出invalid image text，materialization后真实模型仍看不到，当前10/20requests；未算通过。主agent真实artifact→refs回归RED：File!=Image；最小修复按file_实际files.type分类，ordinary文件保持File，GREEN1/1/完整VFS681通过；重建原生应用后freshAskAI编译已为image块，待真模型复测。
- AndroidPDF批注又真实暴露来源ID错误：DSTU node.resourceId是SHA内容hash，不是resources.id。子agent使用既有vfsFileApi.get(node.sourceId).resourceId修复，主agent两文件3tests通过。过程偏差：该agent未经许可自行RED/GREEN并提前实现；主agent标red的运行实际已绿，不追认主agent独立RED。实际SOURCE_CHANGED/runtime与数据库链接是bug证据，最终所有验收主agent亲跑。
- 所有执行agent已冻结；源改动主agent显式187文件暂存，新增源码完整。gitdiffcached --check发现此前untracked3个EOFblank已机械trim并重暂存，未修改ignore/lockfiles。本地源码提交已创建7fef25ec81628ecae55fa6452ff27e54f5da9c72（187files），未push/merge/publish。引用修复后新AskAI实际image块+真模型复测成功，最终请求11/20/全部同模型HTTP200；proxy已停止。最终source入口原生PDF prepare成功，Android修复包r4构建exit0，正在安装复测。
- Android新AVD实际新建笔记并touch两笔保存、undo1/redo2、append2pages、HOME+force-stop后canonical2pages/2strokes保留。最新x86r3构建exit0已升级安装，继续UI导出/来源批注验收。
- Androidx86r2构建exit0，实际Gradlecargo命令仅mobile-slim/tauri custom，无lance/mcp；APKx86_64/version214586，v2signature校验/安装成功。旧只读AVD却有Oct30残留size0.master_key，引发failclosedcrash。没有改加密逻辑/删数据；新建独立ds-ink-closure-20261103-api36，首启key44bytes/进程2400存活，继续UI验收。旧read-onlyAVD已正常停止。
- 菜单新增fakeTimer第一版没真实RED，精确改善rAF/effect调度后new-red-r2真实Beta焦点被root抢，启用既有menu归属保护后green-r2 12/12。fullshard1-r2重跑中。
- 恢复后核实ARM64首轮release exit0，未签名135551353bytes；ABI仅arm64、version0.11.0/code214586、权限齐全、两ELF LOAD16KiB、主库127790456<262144000预检通过。首轮证据见verification/closure-arm64-first-build.md。
- 主agent重新观察PDF编辑器实际已进入ErrorBoundary，不是单纯touch自动化问题。读取canonical发现上一轮stroke已保存，重启能显示；再次新增红stroke提交成功后DOMException复现。图片来源实际prepare成功，蓝stroke保存后同样失败。派窄范围根因调查，确认背景effect提前close仍被子组件使用的ImageBitmap。
- tests-only新增3真实浏览器回归。主agent首轮RED-r1因4GiB Vite heap OOM exit134，未运行测试，不算业务RED；命令级8GiB后RED-r2 exit1，image/PDF保存后alert1、navigation移除canvas，3项全部按预期失败。授权最小state-owned lease修复，禁止去掉revision高亮刷新／吞异常／定时器绕过。
- Android额外smoke：实际zoom in/out及问AI按钮，生成61753bytes真实PNG file_mqXSabT9jP，artifact/render c8f259b0cf8582003ab7fc0c0961346a5735cf5739ac241b62dbe4f749d78b5b；Chat输入框附件标Image且未发送。没有新增模型请求，仍11/20。
- Ruling: 不签名交付有已知来源背景重绘缺陷的首轮ARM64包，保留首轮证据，回归修复与新提交后按原官方配置重建 — 用户要求完整收尾而非仅构建成功 — 成本为额外构建时间，不绕过任何产物护栏。
- 追加修复主agent审阅：published InkBackgroundLease跟state值清理，latecancel立即dispose，revision/highlight刷新不减；无timer/cache/manager。3CT GREEN后完整55/55、Ink28/28、四片3265/3086/3040/3279共12670pass/4skip/5todo全部exit0；type/lint4611/ratchet/layers565/i18n/license/devguards11均exit0。
- 新x86背景修复包exit0、apksigner/ABI/code核对后adb install-r成功。主agentPDF加蓝线3objects、undo2/redo3、next/prev；图片加红线2objects、eraser1/undo2；HOME+force-stop重启后二份canonical revision/hash/对象未变，真实UI重开可见，限定日志无DOMException。最终Android报告verification/closure-android-final.md。
- 主agent4文件显式暂存/cached diff审阅并本地commit **bc48e6eb42caaeaee894346b155b5e52f0ad8d55**。ARM64 JNI已恢复且仅arm64；官方准备exit0，再从该新提交运行相同mobile-slim/locked/no-default release构建r2。生成version.ts正确bc48e6eb/build15983/code214586，尚未用旧首轮包签名。
- 最终ARM64r2 exit0，主agentzipalign-P16→独立测试签名→apksigner verify v2/v3→zipalign-c-P16→aapt/version/权限→两ELF LOAD16KiB/主库体积全部核验通过；包内完整sourceSHA和short hash均实际找到。最终135634180bytes，SHA256 **6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf**，测试证书edf4c986…不匹配production属于明确测试边界，不改生产guard。APK与build-info留build-android，不入Git。
- Ruling: 按已批准本地提交／不推送合并的选择保留功能分支，不再次弹出整合菜单或修改main — 用户已作明确决定 — 成本为后续整合由用户另行安排，不擅自扩权。
- 集中文档98文件显式列清单，主agent审阅当前报告／历史banner、相对链接、JSON实际内容、敏感模式和cached diff；rawlogs／PNG/XML／临时路径清单／APK／keystore保留本地不提交，不改ignore不force-add。发现一份旧report尾部空行，纯格式trim后再check；所有过程记录仍保留。最后创建独立本地docs提交，不amend源码身份。
