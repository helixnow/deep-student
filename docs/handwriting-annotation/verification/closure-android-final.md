# Android API36 模拟器最终验收

日期：2026-11-03。执行／审阅：主 agent。AVD：`ds-ink-closure-20261103-api36`，serial `emulator-5582`，x86_64／Android WebView。使用本轮自建资料，无个人文件、无模型外发。

## 包与环境

- 源码主提交 `7fef25ec81628ecae55fa6452ff27e54f5da9c72`。
- 追加修复 `bc48e6eb42caaeaee894346b155b5e52f0ad8d55`：背景ImageBitmap与已提交React state绑定，避免保存／导航仍绘图时提前close。
- 验收诊断包在提交前冻结等价源码构建，生成版本hash仍为7fef25ec；最终ARM64交付包必须从bc48e6eb重建，不能混用身份。
- 诊断包：`build-android/DeepStudent-0.11.0-x86_64-ink-background-fixed.apk`，SHA256 `39c809da294ee4c7f39b0dac652930841aec955b6dd7905b3d2acdd5484444f5`，同目录 `x86_64-background-fixed.sha256`。
- x86诊断包为Android Debug证书，SHA256 `0180040010aee59d86c47c107a343f52570420f90f2ca3e831c67d57e9c8bb42`；不同于最终ARM64独立测试证书和正式生产证书。
- `tauri android build --target x86_64 --debug --apk --ci --features mobile-slim -- --locked --no-default-features`，`DS_ANDROID_PREBUILT_NATIVE`未设置；实际cargo无lance/mcp。
- SDK/build-tools36，NDK29.0.13846066，Rust1.98.1，JDK21.0.13（官方CI为JDK17）。
- apksigner verify通过、仅x86_64、version0.11.0/code214586；`adb install -r`成功，没有卸载、清数据或重生密钥。

## 主 agent 实际操作与结果

| 场景 | 结果／实际证据 |
| --- | --- |
| 空白笔记创建、多页、书写、undo/redo | 实际资源菜单创建；两笔保存，undo1／redo2，append到2页；本轮先前完成 |
| 空白笔记后台／强停重启 | canonical2页、第一页2个对象保留，真实UI可重开 |
| PNG／PDF导出 | 真实VFS文件20731／10266bytes并打开，不是仅生成JS Blob |
| PDF来源prepare | 从自建导出PDF菜单创建2页，source=resource／背景pdf_page固定PNG，canonical资源ID修复已验证 |
| 图片来源prepare | 从自建导出PNG菜单创建1页，source=resource／背景image，显示完整原背景 |
| PDF新增笔迹保存与重绘 | 修复前真实保存成功后DOMException；修复包新增蓝线后3objects，UI显示Saved并保持背景与黑／红／蓝笔迹，无错误页 |
| PDF撤销／重做 | 3→2→3objects，颜色与revision实际读回；未覆盖原背景 |
| PDF翻页 | Next page→Previous page回第一页，背景与笔迹仍可绘制，没有closed-bitmap异常 |
| 图片新增笔迹 | 旧蓝线基础上新增红线，1→2objects，UI继续Saved；背景及蓝红线可见 |
| 图片橡皮／撤销 | 点击红线橡皮后2→1object，再Undo恢复2；底图不擦除 |
| 进程强停后的两份来源笔记 | HOME→force-stop→启动；canonical PDF3objects、图片2objects及revision/hash不变，两文档真实UI重开并截图确认背景和笔迹 |
| 缩放／touch | 实际开启touch，ADB swipe进共享renderer；Zoom in/out回100%，没有触摸/笔语义豁免 |
| 问AI附件 | 空白及修复后图片来源页实际点Ask AI，生成真实PNG／不可变artifact；Chat输入框附件标Image，不自动发送；本轮Android未调用模型 |
| 崩溃／ANR | 修复后本轮操作范围内app存活；限定pid日志未见此前DOMException／ErrorBoundary、FATAL EXCEPTION或ANR；不是长时稳定性保证 |

## 稳定数据与恢复

PDF文档：`file_ink_7a24bd250667e2233465d95416cad057669e568807c28595c3d7f34ad3536d4f`。
- 最终revision `r_kexWdndN8jZ04-ov`。
- manifest SHA `8f3f8602a757e2bbafbb039ec68501b9482b33e08082baae046cbd5bb80b5e22`。
- 页1三个对象：black／red／blue；页2零对象。

图片文档：`file_ink_99d0f78e80fcd289b3ba9991f6b30c5940b695ca4695d6e57d4be7c516c600f0`。
- 最终revision `r_rdWD2MzpU-JD9FMP`。
- manifest SHA `d5fe7e031263f37199af5f7219a7afa3ec7f8c906962f2d2bf5453e7ca77129c`。
- 一页两个对象：blue／red。
- 修复后Ask AI的artifact/render `e8d68895549522a32ad869ca9689b9eba88e3431c5c6297bad12a4dc84e6d00f`，file `file_qgRwtLKJoW`，resource `res_2s5NbGXiJs`，PNG hash `90befac7281a1e374f733f91e29fff227a6171486353131e4537abbb019b8ae5`。

读回仅限本轮app测试数据，未读取／打印.master_key或个人ChatDB。读回摘要`closure-fixed-{pdf,image}-after-restart.json`和最终截图保留。

## 发现与闭环的边界

- 旧AVD残留空masterkey造成的fail-closed启动失败未通过删数据或改加密策略“修复”；采用全新独立AVD后正常。旧AVD数据保留。
- 来源ID问题与ImageBitmap生命周期问题均是真实运行缺陷，保留原失败证据；后者3项真实浏览器RED→GREEN及完整55项通过、完整前端12670通过、Android真实复测后才本地提交。
- uiautomator偶尔null root、0bounds或过渡树；以fresh截图、稳定树及nativeDB交叉核验，不将一次自动化失败算产品失败或通过。
- **未验证**：真实手写笔压感／手掌误触／真机延迟内存、API24实际运行、Android内真实模型调用、ARM64包在真实设备运行。模拟器为x86_64，不能安装ARM64包冒充运行验收。
