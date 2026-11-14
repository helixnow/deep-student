# WP-043 部分 blocked：PDFium / D46 / LLVM 等维护（WP-153 更新）

真实构建 `20261105173612-f65814` 因 PROTOC 缺失 exit101；增量重试
`20261105174903-ed84f3` 使用已下载的锁定 protoc，因
`resources/pdfium/libpdfium.so` 缺失 exit101。两份原件保留于
`fixtures/differential/wp043/builds/`；无 binary、A 未启动、A1/A2/golden=0。
WP-153 仅完成 Node seed/HOME 准备，不重试构建。待维护落地原资源后另包授权增量构建。

1. 覆盖率工具实查：PATH 无 llvm-cov/llvm-profdata；
   `~/.rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/lib/rustlib/x86_64-unknown-linux-gnu/bin/`
   仅 gcc-ld、rust-lld、rust-objcopy、wasm-component-ld，无 LLVM coverage tools。
   请维护提供与 rustc 1.98.1 / LLVM 22.1.8 匹配的 llvm-tools-preview（llvm-cov、llvm-profdata），
   或明确等价绝对路径。现有 build-script profraw 不属于应用命令覆盖率。
2. X3 依赖已解除：正常 main `e6bce8aae` 已包含 `SCENARIO-V0.md`、
   createSeed/resolveSeed/copySeed 与 snapshotDirectory（本包以 git show main 核实）。
   WP-153 准备入口消费该接口与 skill ZIP 清单，HOME 指向当前副本；供方/消费准备自检不升级 G3。
   SQL 构造 seed 和 synthetic ZIP 均不是历史 A 产物。
3. D46 三文件机械 allowlist 未落盘。现命令使用原配置、--locked，不写根配置。
   隔离 identifier 所需精确配置 diff（D007 已授权、待维护放行路径）：

```diff
--- a/src-tauri/tauri.conf.json
+++ b/src-tauri/tauri.conf.json
@@
-  "identifier": "com.deepstudent.app",
+  "identifier": "com.deepstudent.differential",
```

现有 devUrl `http://127.0.0.1:1422` 可直接供应 harness，无须 WebDriver 或 Rust 业务改动。
录制器准备使用独立 HOME/XDG/TMP；当前入口删除 TAURI_LAB_INSTANCE_ID，要求编译后的隔离 identifier 拥有锁。
未通过脚本/TAURI_CONFIG 偷换 identifier 或规避根配置门禁。最终需要配置修改时仅增量构建。

事件边界：Tauri 2.11.5 的事件只发给已注册名称的监听者，不提供 wildcard；
get_app_version 源码无事件/DB 写入，但不能据此冒充全应用事件原文精度已解决。
一般事件 payload 经 eval 的数字精度仍待 X5/后继接缝；首版本字符串不受该数值问题影响。
