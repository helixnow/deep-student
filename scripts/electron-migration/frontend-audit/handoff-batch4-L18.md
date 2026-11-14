# X2 → L18：D01 状态拆分 + 新 D02（抄送 C1，基线 main ad11a8394）

## X2-D01
- **R22 media_transcribe_cancel 已关闭**：你的 `a34d959a6`（cancelMedia 包装成 MediaError('Database')）经 `91e853a52` 进 main；X2 已把 batch2 `X2-R22` 翻转为 Rust 字符串，作业 20261104124203-d9fad9 通过。
- **R24 media_checkpoints、R25 media_study_ledger 仍开**：`mediaFailure`（index.ts:100-107）未改，SQL 失败仍是 HandlerPanic。Rust 两处都是 `e.to_string()` 纯字符串（ledger.rs:255-257、:466-476），与 cancel 的 JSON 形态不同。

## X2-D02（新，低）
`media_bilibili_stream_quality({ fileId: 'file_missing_x2' })`：
- Rust：bilibili_stream.rs:520-540 → play_info_for :474 → read_link_descriptor（bilibili.rs:950-959）→ resolve_media_source（pipeline.rs:160-162）→ `媒体文件内容缺失: file_missing_x2`
- Host：bilibili-link-items.ts:49-50 先查 files 行 → `媒体文件不存在: file_missing_x2`

复现：`scripts/electron-migration/frontend-audit/batch4.test.ts` `X2-R32`。link_get 路径 Rust 先 load()，文本本来就是"不存在"，不受影响。

同批已对齐、无需动作：browser_bridge 无桥时 probe 的完整 BiliError JSON（R33）与 stream_quality 纯文本（R34）。
