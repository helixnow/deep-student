# WP-043 精确阻断：真实 Tauri build.rs 需要缺失的 Linux PDFium 资源

第二个真实 app 构建 `20261105174903-ed84f3`，17:49:04.329Z–17:55:11.193Z，
**366.864s / exit101 / rust 类**。PROTOC 环境修正成功越过 lance-encoding；
新的原始失败：

```text
thread 'main' (3318267) panicked at build.rs:57:29:
failed to build Tauri application with app ACL: resource path `resources/pdfium/libpdfium.so` doesn't exist
```

来源是 `src-tauri/tauri.linux.conf.json:5`，不是 ACL 断言/业务代码错误。
`src-tauri/resources/pdfium/libpdfium.so` 未提供，且该资源路径不在本 lane 允许路径/D007 三根配置里。
维护应在本 X7 工作树提供项目原定 Linux x64 PDFium **chromium/7350** 动态库。
项目现有下载依据：`scripts/download-pdfium.sh:11–15,79–83,117–172`，
URL `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7350/pdfium-linux-x64.tgz`，
压缩包 `lib/libpdfium.so` → 上述资源位置。原脚本同时替换 licenses/，X7 未运行该越界写脚本。
不删资源声明、不用空库/占位库、不裁剪 features、不借 TAURI_CONFIG 绕根配置门禁。

现二进制不存在，A/harness 未 ready，A1/A2/golden 仍 0。
还需 D46 isolated identifier 精确 diff 放行、X3 public seed/DB 接缝正常合入、LLVM22 tools。
已有真实编译缓存保留；本包无第三次无条件重试。资源与配置落地后可按同环境增量继续，
初估 10–30 分钟给下一次构建结果，再 5–10 分钟首命令（条件 ETA，未测量）。
本次提交的是实际构建 checkpoint 与可运行录制器准备，不称 G3 或命令 C pass。
