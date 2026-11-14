# WP-043 17:49Z：首个真实 Tauri 构建 exit101，现有 vendored protoc 增量重试已提交

- 首 job `20261105173612-f65814` 已完成，exit101；首错 `lance-encoding v0.37.0` build.rs 找不到 protoc。
- 没有关闭 lance/default feature 或修改 Rust。已有依赖包
  `protoc-bin-vendored-linux-x86_64-3.2.0/bin/protoc` 可直接由 PROTOC 环境变量供原 build.rs 使用。
- 增量重试 job `20261105174903-ed84f3`，仍专用 rust / jobs12 / dev+coverage / 同 target / --locked。
  不安装工具、不改 Cargo.lock、不另开旁路编译；F7 依正常队列排程。
- 首构建中 instrumentation 给 build-script/proc-macro 写出的 10 个 profraw 已移入
  `fixtures/differential/wp043/builds/20261105173612-f65814/build-script-profraw/`。
  **它们不是应用运行覆盖率**。重试设置绝对 LLVM_PROFILE_FILE 到自有 fixtures，防污染源码目录。
- 基线 typecheck `20261105173516-710212`、原 recorder wrapper `20261105173516-9bab38` 均 exit0；
  原 12 个 Node 断言完整。新增 v0 exact refs/真实 SQLite capture/HTTP raw 传递测试是 recorder-only。
- 自动检查点提交 694e479f2/720635d82 在编译期间推进了 HEAD；Rust 源码/配置未变化。
  构建收据分别保提交时 SHA、实际源码 tree、收据时 SHA，不冒称二进制 metadata 一定等于提交时 SHA。
- 新 ETA：若增量构建无新阻断，18:20–18:40Z 给真实启动结果；D46 identifier 与 X3 main 缺口、LLVM 工具仍按上条上报。
  当前 A 仍未启动；A1/A2/golden=0，命令 C=0。
