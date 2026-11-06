# 最终审阅、真实模型与 Android 测试 APK — 2026-11-03

> 冻结历史基线。后续真机已运行同一 ARM64 APK，并观察到导入文件不支持预览；该缺陷尚未修复，见 [当前问题](../issues/android-import-preview.md)。本文“完成／通过”仅限当时的验收范围，不覆盖新反馈或待审批扩展。原始日志等过程材料已移入本地归档，文件名查询见 [治理说明](../governance.md)。

本轮授权：最终审阅、修复测试失败、本地提交、真实模型（当前视觉配置最多20实际请求）、先Android模拟器后官方配置ARM64测试APK。源分支feat/handwriting-annotation-chat，BASE6c73530d。已本地提交主源码 `7fef25ec81628ecae55fa6452ff27e54f5da9c72`（187文件）与追加修复 `bc48e6eb42caaeaee894346b155b5e52f0ad8d55`（4文件），未推送、合并或发布。ARM64最终测试签名包已构建并核验；本轮全部已授权软件收尾完成，真实设备体验与未覆盖范围明确保留。集中记录另作本地docs提交。

## 本轮已运行的门禁

| 门禁 | 本轮证据 | 结果 |
| --- | --- | --- |
| 最终冻结源码前端四片 | closure-background-vitest-shard-{1,2,3,4}.log | 追加bc48e6eb修复后四片全部exit0，3265+3086+3040+3279=12670通过；4skip/5todo；1605files通过/1skip；旧7fef25ec冻结轮保留 |
| Ink浏览器完整集 | closure-background-browser-full.log | 最终55/55通过、单worker；原52项及新增图片保存／无高亮PDF保存／背景导航3回归全绿；旧并行PDF超时记录保留 |
| 编辑器跨页回归 | closure-crosspage-undo-red-r1.log → closure-ink-editor-green-r1.log | remote离页更新后旧undo擦画面RED；清文档所有页历史后25/25CT绿 |
| 稳定Rust全库 | closure-stable-rust-r1.log | 4059pass/0fail/6ignored/1proxyfiltered；被过滤proxy独立1/1通过(closure-proxy-isolated-r1.log) |
| Agent完整库 | closure-agent-full-r1.log | 1965pass/0fail/6ignored |
| App完整库 | closure-app-full-r1.log | 1050/1050通过 |
| 原生命令ACL | closure-acl-r1.log | 4/4通过 |
| Phase5原生harness | closure-phase5-green-r3.log | 两个真实case均PASSED、exit0；来源ai→agent、GTK子进程隔离、补生产ChatV2State、异步通知started状态/最终run等待；业务断言保留 |
| 迁移static/immutable | closure-migration-final-r1.log | 135迁移pass，base-ref检查pass；锁仅追加3项 |
| 迁移脚本 | closure-migration-tests-r1.log | 14/14通过 |
| 开发验收代理/Android特性护栏 | closure-dev-guards-final-r1.log | 11/11通过（10proxy+1config）；只loopback夹具 |
| UI聚焦回归 | closure-final-ui-green-r1.log / closure-format-selector-final-green.log | menu12与format4通过；compact按钮不再w-full |
| typecheck | closure-background-typecheck.log | 追加bc48e6eb生命周期修复后exit0 |
| 分层/i18n/license | closure-frontend-layers-r1、crate-layers-r1、i18n-r1、licenses-r1.log | exit0，旧基线不改 |
| lint/ratchet | closure-background-{lint,ratchet}.log | 追加修复后4611旧warnings/0errors，无新增；基线未改 |
| fmt | closure-fmt-last.log | Rust最终源码exit0；bc48e6eb仅前端改动，未冒称再次跑Rust |
| Clippy | closure-clippy-after-ref.log | 最后Rust引用修复后workspace/all-targets -Dclippy::correctness exit0 |
| 生产build | closure-production-build-r1.log、closure-official-arm64-build-r2.log | 最终ARM64 beforeBuild完整前端生产build通过，原58.89s轮保留 |
| UI引用最终完整VFS | closure-vfs-after-ref-full.log | 681pass、exit0；稳定库内修前680不冒充已覆盖此追加测试 |

套件重叠，不将数字相加为互异测试数。最后提交前按新修复影响补门禁。

### Android 来源背景生命周期追加修复

恢复后主agent真实复现PDF和图片背景页保存后重绘DOMException；保存实际成功，重启可见，但编辑体验失败。根因是旧ImageBitmap在仍被子组件prop引用时提前close；改为published state持有lease，prop替换／解绑后的effect清理才dispose，迟到取消结果立即释放。保留revision／高亮重新取值和全部格式预算，不吞绘图异常。

- 主agent三项真实CT：RED-r2 exit1（image保存／无高亮PDF保存／导航全部失败）；GREEN-r1 3/3通过。
- 完整浏览器追加回归 `closure-background-browser-full.log`：**55/55通过**，workers1、exit0，含全部原52项；不是以定向成功替代完整回归。
- `closure-background-unit.log`：Ink单测28/28、7文件通过；`closure-background-typecheck.log` exit0。
- lint 4611存量warnings／0errors，ratchet无新增，layers565基线无新增；对应`closure-background-{lint,ratchet,layers}.log`全部exit0。
- RED-r1仅4GiB Vite heap OOM exit134，没有运行测试，不算业务RED；命令级8GiB后正常执行。
- 修复后冻结完整四片 `closure-background-vitest-shard-{1,2,3,4}.log` 全部exit0，3265+3086+3040+3279=**12670pass／4skip／5todo**，1605files通过／1skip。旧冻结日志保留但不冒称覆盖此追加修复。
- 新x86模拟器包 `closure-background-android-x64-r1.log` exit0并升级安装；PDF新增笔迹3objects、undo2／redo3、翻页，图片新增红线2objects、橡皮1／Undo2，强停重启后两份canonical与真实UI均保留，无此前DOMException。详见 [Android最终报告](closure-android-final.md)。
- 主agent显式暂存4文件并本地提交 **bc48e6eb42caaeaee894346b155b5e52f0ad8d55**；业务源码clean，未推送。最终ARM64从此提交以原官方配置重建exit0，独立测试签名与最终guards通过；详见 [APK报告](closure-apk.md)。
- i18n／license／10proxy+1Androidfeature护栏全部exit0；依赖锁与ignore未改。

## 真模型当前状态

- 使用应用明确分配的视觉配置vm_1793630193769_bmj7f9；模型[特价]DeepSeek-V4.1-Flash，原供应商不变。仅本地隔离profile和自建资料。
- 开发专用proxy在实际HTTP发送前计数，最大20次，锁model/上游，拒绝重定向和任意URL；headers/body不落日志。正常用户profile只读，没有修改。
- 最终11/20次实际请求：control2、首轮默认memory1（后续明确禁用）、marked2、render+apply3、history1、UI图片附件失败1、修复后UI图片成功1。11次均原模型/供应商、HTTP200；一次图片失败是内容未送达，不计成功验收。proxy已停止，无后续请求。
- control负对照正确读PLANET STUDY/Sample47，明确无手写；正例正确识别24/红色椭圆/蓝色横线，提示词未给答案。
- 真实模型addrect成功、author=ai/committed/可信receipt；随后人类再加一笔，opaqueIDs undo保留6个人类strokes、AI对象0。
- history仅用已持久化不可变图片恢复后正确比较新旧图，无重新render。
- 原生PNG和PDF导出真实VFS产物成功。
- UI问AI真实失败已修复：file_图片按files.type分类而不是前缀当普通文档，主agent真实DB回归RED→GREEN，完整VFS681通过。重建原生app并新建ContextRef后，真实模型从附件识别24/红圈/两条蓝线，并正确指出绿色矩形已撤销（不靠工具fallback）。旧失败保留，最终消息msg_ef597c00-6a42-496a-9883-920ece4b44e9。
- 全部外发为自建夹具；没有个人笔记、聊天或凭据外发。最终11条usage合计输入97449tokens、输出3191tokens，价格未核实不捏造金额。

## Android当前状态

- SDK36/NDK29.0.13846066/Rust1.98.1/JDK21；与官方CI JDK17差异明确记录。
- 官方CI CLI原生重编译发现继承desktop build.features(lance/mcp)；Android override build.features=[]后真实cargo命令不再包含lance/mcp，CLI仍mobile-slim --no-default-features。
- x86PDFium官方SHA归档156d8609…，ELF14e3bdd5…，只提取验证单个Android ELF；日志closure-pdfium-x64.json。
- 首个旧read-onlyAVD留Oct30空masterkey，正确failclosed崩溃；未删除/重建旧密钥或清数据，改全新独立AVD复测，key44bytes/进程存活。此为旧环境坏数据，不当作新产品crypto修复。
- 新AVD ds-ink-closure-20261103-api36；x86包签名/ABI/versionCode214586检查通过，真实安装/启动通过。
- 实际菜单新建dsink→显式touch开启→两笔swipe保存；undo后1object、redo后2object；append到2pages；HOME+force-stop+重启后canonical2pages/firstpage2objects不丢。
- 最新前端修复的x86诊断包r3构建exit0并已升级安装，无清除测试笔记。
- 升级后实际可视重开通过，PNG/PDF均真实VFS文件（20731/10266bytes）并打开。实际PDF批注最初发现DSTU resourceId是content hash，修复使用既有vfsFileApi.get取canonicalres_后，Android修复包r4实际prepare成功新增file_ink_7a24bd…的Prepared source.dsink。随后背景生命周期修复包完成图片来源prepare／新增笔迹／橡皮／Undo／重启恢复；PDF同样完成新增笔迹及undo-redo／翻页，详见closure-android-final.md。
- ARM64首轮未签名候选135551353bytes因发现来源背景缺陷不交付。最终从bc48e6eb以相同官方profile重建exit0并测试签名，**135634180bytes**；SHA256 **6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf**。v2/v3签名、仅arm64、version0.11.0/code214586、权限、ZIP/ELF16KiB、主库127790456≤262144000与包内源码hash均核验通过。独立测试证书edf4c986…不同于生产证书，不宣称可升级正式版；详见 [APK报告](closure-apk.md)。
- Android实际问AI生成61753bytes真实PNG `file_mqXSabT9jP`，immutable artifact/render ID `c8f259b0cf8582003ab7fc0c0961346a5735cf5739ac241b62dbe4f749d78b5b`；Chat输入框真实附件标Image，未发送／无新增模型请求。实际zoom in/out返回100%。来源背景修复包已完成真实Android复测；修复后图片AskAI也生成e8d68895…不可变PNG，未发送模型。
- 模拟器不是压感/手掌误触/真机延迟内存验收。真机仍需后续设备验证。
