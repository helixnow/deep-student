# F7-native lane 状态

2026-11-04 夜（接管）：按架构师D10（批准pngjs@7.0.0/jpeg-js@0.4.4）把PNG/JPEG编码恢复为pngjs/jpeg-js（撤回sharp切换：Electron下GLib-GObject警告且非D10指定）；DOCX讲义 picture() 只对base64/解码失败静默退化（Rust `.ok()?`），编码器故障改为抛错；新增 `nativeOffice` provider（docx、rtf、pptx 已实现，其余格式由 `formats`/`OfficeEngineUnavailableError` 如实报告）。
2026-11-04 深夜（继任）：按架构师批准的一次 wasm32-wasip1 重建，`nativeOffice` 改由同 crate WASI 引擎提供全部 8 种格式（docx/xlsx/xls/xlsb/ods/pptx/rtf/html），删除 TS 重复移植与 `OfficeEngineUnavailableError`，新增 `IoError`。构建作业 20261104153802-9913ff（7m14s），回归作业 20261104154637-f2ea71（27 文件 151 passed/5 skipped）。pptx-to-md 的 zip 去 bzip2/zstd/xz 特性为已批准偏差（见 SPEC/NEEDS）。已通知 L18。
2026-11-05（继任）：架构师批准的第二次 wasm 重建，一次编入 fsrs 6.6.2 optimize/evaluate、regex replace_all_projected（L24）、DOCX 结构化/PPTX metadata（L18）、image 0.24 编码（未接线）。构建作业 20261104193343-0fb691（12m45s），全量回归 20261104200158-b8309d（30 文件 181 passed/5 skipped）。已通知 L15、L24、L18。
2026-11-05（裁定后）：`nativeImage.encode` 改接同 crate image 0.24 编码（D12，未重编），删除 encode-worker.mjs；fsrs 同步移植的 ≤13 ulp 差记为已知偏差并加 ≤16 ulp 断言。回归作业 20261104201151-2b63b4（native+qbank+media 144 文件 897 passed/7 skipped）。
2026-11-06（WP-095）：C1 批准的一次增量 wasm 构建只加 `roxmltree =0.20.0` 与 `xml.parse` op（作业 20261105165453-467913，exit 0，6m39s）；新增同步 `runWasmSync` 与 `mindmapXml` provider（类型取自 L13 api）。超过约 3000 层嵌套时栈溢出抛错，见 SPEC「WP-095」。
2026-11-06（WP-085）：`nativeSqliteBusy` 用 better-sqlite3 自己的 `loadExtension` 把 `sqlite3_busy_handler` 装到同一 `sqlite3*` 上（C 源码 + linux-x64 预编译产物，作业 20261105175214-71fa3e）；Node/Electron 各 12 passed。mac/win 产物、F3 接线、L20b S06 仍待（SPEC「WP-085」）。
2026-11-06（WP-161）：handler 抛错改按 rusqlite busy.rs:60 视为 false、不重抛，删去 `throwPendingHandlerError`；产物 sha256 不变；Node/Electron 各 13 passed。
其余等待项如下（不表示已完成）：

| 待办 | 等待方 | 证据 |
|---|---|---|
| tiktoken / @node-rs/argon2 进入 root；D12 落笔并从 root package.json 移除 pngjs/jpeg-js（本 lane 已不再使用） | 架构师 | 编码已改同 crate WASI（encode-worker.mjs 已删） |
| 3条consumer测试替身TS2741（diagnostics必需） | L12修复35c63591d仅在其分支未进main；L11（vfs-repos attachment-processing）main中未修 | lane-gate typecheck exit2，F7零错误（作业20261104143709-3831ab） |
| regex `replace_all_projected` 单op（L24有界替换） | 架构师授权产物维护 / X7差分向量 | SPEC「C2 08:17增量」 |
| Lance独立compact/prune/index | 架构师 | NEEDS.md 对应行 |
| L13 用真实 `mindmapXml` 复验 `mindmap_import`（WP-095 已提供 provider） | L13（合 main 后） | SPEC「WP-095」；本 lane 不改 L13 测试替身/映射 |
| 三平台差分：fsrs f32 移植 ≤16 ulp、同 crate 图片编码、PDFium两版本golden | X7 / C级 | SPEC「已知偏差」「nativeImage.encode」 |
| `nativeSqliteBusy` darwin/win32 产物（win 需 node.lib 下载 + delay-load） | C2 目标 runner | SPEC「WP-085」方案表 |
| F3 `Connection.setBusyHandler` 接线 → L20b S06 | F3 → L20b | SPEC「WP-085」 |
| macOS / Windows 目标平台验证 | 目标runner | 未在目标平台验证 |

恢复条件：上述任一方交付后，先 `git merge --no-edit main`，再运行 `lane-gate.mjs`。

## v2 §1 自查（2026-11-04）

- 1.7 运行时语义：`runAppContainer`取消后曾自加5s `Date.now()`上限并报错；Rust windows.rs:2002
  为INFINITE等待。已删除，与`runFullAccessJob`一致（异步100ms轮询）。Linux作业
  20261104143709-e9785b 1 passed/3 skipped exit0；Windows分支未在目标平台验证。
- 其余：生产代码`Date.now`仅vector cleanup（Rust同为墙钟）与Starlark绝对deadline；
  `as unknown as`仅用于exceljs/pdfium库类型缺口，非入站数据解码。
- L05 W3（readAt/refreshInformation/runFullAccessJob/acquireAclMutex）已在945dda9d5提供并通知。
