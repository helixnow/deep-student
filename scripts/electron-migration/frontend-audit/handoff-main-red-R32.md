# X2 → C1：main-red X2-R32（待集成断言修复，不是新的业务差异）

## 原因

- fulltest 基线 `677f6727c` 和当前 main `d51544ecf` 的 `batch4.test.ts` 仍断言 `媒体文件不存在: file_missing_x2`，并反向断言结果不等于 Rust 的 `媒体文件内容缺失`。
- L18 修复 `6b1b3fa40` 已为 main 祖先。它按 Rust `bilibili.rs:950-959` 先 `resolve_media_source`，经 `pipeline.rs:160-162` 返回 `媒体文件内容缺失: file_missing_x2`，`bilibili_stream.rs:531-540` 将其作为纯字符串拒绝。
- 本 lane 的断言翻转在 `04df0ba34`（协调者自动检查点）中，尚非 main 祖先；`3ec8e6bb6` 补充了 Rust 对照提交说明。工作树合并当前 main 后仍保留正确断言。
- 因此是 owner 业务修复与 X2 断言修复的集成时序差，不是新接口不兼容；不能为迎合旧断言回退 L18 或修改 Rust 文本。

## 集成要求

请正常集成本分支中 `04df0ba34` 的 `batch4.test.ts` 断言翻转，不要只摘取后续文档提交。
本轮保留精确 Rust `assert.equal`，没有加 skip、放宽匹配或删除业务测试。

## 当前最小复验

基线 main `d51544ecf`，X2 merge `e2c5d2b0d`。
作业 `20261104163033-b81759`：仅 `batch4.test.ts -t X2-R32`，**1 passed / exit 0**；同文件另一项由名称过滤未运行（Vitest 显示 1 skipped，未增加 skip）。真实 invoke 返回精确 Rust 字符串。
提交后再 merge main 并运行官方 lane-gate；不重跑旧 49 项或全量 1,673 调用点。
