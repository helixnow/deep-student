# 官方构建配置 ARM64 测试 APK — 最终产物核验

日期：2026-11-03。执行／审阅：主 agent。本地测试产物，不是正式发布，无上传／推送／发布。

## 最终产物

- APK：`build-android/DeepStudent-0.11.0-arm64-mobile-slim-ink-test.apk`。
- 大小：**135,634,180 bytes**（约129.35 MiB／135.63 MB）。
- SHA256：**`6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf`**。
- 校验和：同目录 `DeepStudent-0.11.0-arm64-mobile-slim-ink-test.apk.sha256`。
- 复现信息：同目录 `DeepStudent-0.11.0-arm64-mobile-slim-ink-test.build-info.json`，可提交副本 [closure-final-arm64-verification.json](closure-final-arm64-verification.json)。
- 源码提交：**`bc48e6eb42caaeaee894346b155b5e52f0ad8d55`**，基于主功能提交 `7fef25ec81628ecae55fa6452ff27e54f5da9c72`。
- 生成身份：Git hash `bc48e6eb`，build number `15983`，Sentry release `0.11.0+15983.bc48e6eb42caaeaee894346b155b5e52f0ad8d55`。
- 主 agent 不只读取版本生成文件；在最终APK的native主库bytes中确认完整源码SHA与short hash存在，并检查构建日志生成身份与源码clean。

## 亲自执行的产物护栏

| 护栏 | 结果 |
| --- | --- |
| 实际构建 | `closure-official-arm64-build-r2.log` exit0，Rust release优化编译9m10s，返回本次APK；mtime2026-11-03 17:40:49本机时间 |
| 签名 | apksigner verify verbose通过，1 signer，v2与v3=true |
| 独立测试证书 | DN `CN=DeepStudent Local Ink Test, OU=Test, O=Local Development, C=CN`；SHA256 `edf4c9868fbc1eb197aceaeb98fcad74d074d3a3cbb2af1ea16ecba1b58e3397` |
| 正式证书隔离 | 明确不同于仓库正式指纹3acac941…；未修改production fingerprint guard、未冒充可发布正式包 |
| 包／版本 | `com.deepstudent.app`，versionName0.11.0，versionCode214586，等于生成器值且高于published floor14640 |
| 平台 | minSdk24／targetSdk36／compileSdk36；唯一native ABI arm64-v8a，无x86诊断库混入 |
| packaged权限 | RECORD_AUDIO、MODIFY_AUDIO_SETTINGS、POST_NOTIFICATIONS、REQUEST_INSTALL_PACKAGES全部存在 |
| ZIP对齐 | 先zipalign-P16后签名；签名后zipalign-c-P16通过 |
| ELF 16KiB | 两库ELF64 little-endian AArch64，所有LOAD p_align16384，p_offset与p_vaddr模16384同余，ZIP未压缩 |
| 主库体积 | libdeep_student_lib.so **127,790,456 bytes** ≤ 官方262,144,000bytes（250MiB）护栏 |
| PDFium | libpdfium.so4,971,128bytes，真实ARM64库，未漏打包 |
| native内容hash | 主库 `3fc3482d8de7dd24232d186b3b5f7f8b266b89e169ebccc9684c5d6941a38ca8`；PDFium `de6d8f4e4047fdabdc6fbde379c81761ffb565422e007a853a95ebc0801d652b` |

原始sign／zipalign／aapt日志保留本地，JSON和本报告固化实际结论。包大小与首轮未签名包相同不代表同一产物；最终native／APK hash及内嵌source均已单独核验。

## 可复现构建

权威：`.github/workflows/reusable-build-android.yml`，文件SHA256 `d849d24f3b22c6e8e28339a9822517bcf2ed5b55ca1ca8ce85373a42b67b3922`。

使用受控Manifest／Kotlin／FileProvider／权限／图标／Bilibili／ARM64 PDFium，执行本项目 `scripts/ci/prepare-android-gradle.mjs`。`DS_ANDROID_PREBUILT_NATIVE=1`仅允许aarch64 release，保留ELF／JNI校验，不用于x86。

工具链：Rust1.98.1(48a229cea)、NDK29.0.13846066、SDK/build-tools36.0.0、ZuluJDK21.0.13、Node22.23.4、npm10.9.9。

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
npx --no-install tauri android build --target aarch64 --apk --ci \
  --features mobile-slim -- --locked --no-default-features
```

签名顺序：build-tools36 `zipalign -P 16 -v 4 unsigned.apk aligned.apk`，使用独立测试keystore／alias `ink-test`签名到新路径，`apksigner verify --verbose --print-certs`，`zipalign -c -P 16 -v 4 signed.apk`。keystore仅本地chmod600，不入Git，不使用／复制正式签名密钥。

## 与官方 CI 的明确差异

1. 本机ZuluJDK21而非CI Temurin17；满足17+，但不是字节级完全相同环境。
2. 本地独立**测试签名**；production certificate guard按设计不匹配，不能上传正式发布或承诺覆盖升级生产安装。不要卸载生产版绕过证书冲突。
3. 使用本项目checked-in release-tooling脚本，而非CI额外workflow-SHA checkout；权威文件hash已记录。
4. 使用现有本地缓存／Linux环境而非hostedUbuntu22.04与GHA sccache，不承诺bit-for-bit可重复。
5. 没有注入生产免费模型密钥；测试者需自行配置provider，不提取用户密钥嵌入APK。最终构建未启用UI自动化桥。

## 验证范围与非目标

先完成API36 x86_64模拟器诊断与PDF／图片来源背景缺陷修复，主agent测试并本地提交bc48e6eb后才重建此包。模拟器运行的是单独x86_64诊断包，**最终ARM64包未在真实ARM64设备安装运行**，不能伪称运行验收。

真机压感／手掌误触／延迟内存、API24实际运行与Android内模型调用仍未验证。首轮ARM64候选虽exit0，但因发现背景缺陷不交付；其历史证据见 [首轮记录](closure-arm64-first-build.md)。
