# ARM64 首轮构建与预检（非最终交付）

日期：2026-11-03。源码：`7fef25ec81628ecae55fa6452ff27e54f5da9c72`。主 agent 在恢复后读取完整构建末尾并亲自运行 APK 内容、ELF 和 manifest 校验。

- 官方配置构建 `closure-official-arm64-build-r1.log`：exit0，Rust release 18m14s，Tauri 返回一个 release APK。
- 文件：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`。
- 生成时间：2026-11-03 16:04:12（本机时间）。
- 未签名包：135,551,353 bytes；SHA256 `e9d76dd68c66672d8081b20b71a18d2ac58199198a002fc6c3e285e22770a0c0`。
- 包名：`com.deepstudent.app`，versionName `0.11.0`，versionCode `214586`；生成器214586，高于已发布floor14640。
- minSdk24、target/compileSdk36，唯一 ABI `arm64-v8a`。
- packaged permissions 包含 RECORD_AUDIO、MODIFY_AUDIO_SETTINGS、POST_NOTIFICATIONS、REQUEST_INSTALL_PACKAGES。
- 主库：127,790,456 bytes，低于官方262,144,000 bytes护栏；SHA256 `0c6545675acb4025753c91578b66425bdfedb8623e9ef9705845f06dbe25b47e`。
- PDFium：4,971,128 bytes；SHA256 `de6d8f4e4047fdabdc6fbde379c81761ffb565422e007a853a95ebc0801d652b`。
- 两库均 ELF64 little-endian AArch64，ZIP未压缩；所有LOAD的p_align为16384，offset与vaddr对16384同余。
- 未签名，不作为可安装测试包交付；签名与ZIP最终对齐核验尚未执行。

## 新发现阻止最终签名交付

Android x86_64模拟器实际复现PDF与图片来源页的共同问题：固定PNG背景首次加载正常，新笔迹成功写入canonical page及manifest后，重绘触发DOMException，ErrorBoundary显示“Could not load this page.”。

- PDF：重启后来源背景和已保存黑色笔迹可见；再加红笔迹，2026-11-03 16:18:22 canonical提交成功后立即DOMException。
- 图片：通过实际资源菜单prepare成功，1页image背景；2026-11-03 16:21:04蓝笔迹成功提交后同样抛出异常。
- 这不是简单的触摸开关或保存失败；不得以数据库已保存冒称编辑体验通过。
- 依据已批准方案，先补回归并修复，主agent验证并创建新本地源码提交，再用相同官方配置重建最终ARM64 APK。首轮包不再作为最终候选。

原始证据：`closure-pdf-repro-logcat.log`、`closure-image-repro-logcat.log`、`closure-resume-pdf-manifest.json`、本轮截图。原始日志保持本地，不force-add。
