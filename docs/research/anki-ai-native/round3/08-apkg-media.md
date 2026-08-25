# Round 3 #8：APKG 媒体完整导入/导出闭环

> 状态：已落地（代码 + 测试 + 文档）
> 范围：`apkg_importer_service.rs`、`apkg_exporter_service.rs`、`chatanki_executor.rs`（仅媒体接线/字段透出）、`cmd/apkg_import.rs`（契约测试）、e2e/integration 测试、`docs/anki-agent-tools.md`

## 1. mediaSkipped 缺口的全部成因（摸底结论）

改造前 `mediaSkipped = declared - imported` 是一个裸计数，把八类完全不同的问题混在一起，且 Agent 工具路径根本没有启用媒体导入。逐项成因：

| # | 成因 | 类别 | 改造前行为 |
|---|---|---|---|
| 1 | **chatanki_import_apkg 未接线媒体目录**：`execute_import_apkg` 构造 `ApkgImporterService::new(anki_db)` 时不调用 `with_media_dir`，只有桌面命令 `import_apkg_to_library` 接了 `app_data_dir/anki_media` | 路径/接线 | Agent 路径全部媒体计入 mediaSkipped，这是最大的一块缺口 |
| 2 | 清单声明的条目在 zip 内缺失（损坏包/手工包） | zip 结构 | 字符串 warning，无结构化统计 |
| 3 | 清单文件名不安全：路径穿越（`../`）、反斜杠（`..\`，Unix 上 `Path::file_name` 不切分 `\`）、盘符（`C:`）、控制字符、超长名 | 路径安全 | 部分场景仅 warning；`..\evil.png` 这类名字改造前会被原样落盘 |
| 4 | 解压后超过单条目 256 MiB 上限（现代包 zstd 媒体可构造解压炸弹） | 体积 | warning + 删半成品，无结构化统计 |
| 5 | 落盘/解压 IO 失败 | IO | 仅 warning |
| 6 | 现代 anki21b 包媒体清单（zstd + protobuf `MediaEntries`）解析失败 | zip 结构 | 全部媒体降级跳过，仅一条 warning |
| 7 | 包内数字媒体条目未出现在 media 清单（孤儿条目） | zip 结构 | **完全静默**：计入 mediaSkipped 但没有任何 warning |
| 8 | 媒体目录创建失败 | IO | warning，全量跳过 |

zip 条目名本身的穿越（zip slip，如条目名 `../escape`）在 `is_safe_zip_entry_name` 阶段整包拒绝（`apkg_invalid_archive`），这不计入 mediaSkipped，是硬失败——保持不变并有既有测试。

## 2. 落地设计

### 2.1 导入：媒体落盘 + 可解析引用

- **Agent 路径接线**（成因 #1 修复）：`execute_import_apkg` 从 `anki_db.db_path()` 派生 `<库目录>/anki_media` 作为媒体目录。生产环境 `mistakes.db` 就在 app data dir 根下，因此与桌面命令 `import_apkg_to_library` 的落盘位置**完全一致**，两条路径共享同一媒体库（Anki 按文件名寻址，同名复用）。
- **引用改写策略**：字段 HTML **保留** Anki 原生引用（`src="name.png"` / `[sound:name.mp3]`），不改写成绝对路径——改写会破坏再导出后桌面 Anki 的解析。可解析性由卡片 `images` 承担：被引用且落盘成功的媒体以**绝对路径**写入 `images`，路径 basename 与字段引用一一对应；`mediaReport.mediaDir` 同时透出目录，`mediaDir/name` 即可解析任意字段引用。这是导出端打包的既有依据（`collect_media_entries` 按 `card.images` 收集），因此“字段引用 ↔ images 路径 ↔ zip 条目”三者天然闭合。
- 图片与音频同等处理：`extract_media_filenames` 同时识别 `src="..."`、`src='...'` 与 `[sound:...]`，legacy JSON 清单与现代 zstd+protobuf 清单均支持，现代包媒体条目自动做 zstd 解压（带窗口上限）。

### 2.2 结构化统计（禁止静默丢）

`ApkgImportResult` 新增 `mediaReport`（无媒体且无跳过时不序列化，旧 JSON 契约不变）：

```json
{
  "declared": 14, "imported": 12, "skipped": 2,
  "skips": [{ "reason": "entry_missing", "count": 2, "filenames": ["a.png", "b.mp3"] }],
  "mediaDir": "/app-data/anki_media"
}
```

- 8 个稳定 reason 码：`entry_missing` / `unsafe_filename` / `entry_oversized` / `io_error` / `orphan_entry` / `manifest_unparsed` / `media_dir_unavailable` / `media_import_disabled`（完整语义见 `docs/anki-agent-tools.md`）。
- 不变量：`skips 各组 count 之和 == mediaSkipped`（混合场景测试断言）。`count` 全量计数，`filenames` 每组最多采样 20 个。
- 成因 #7（孤儿条目）从“完全静默”变为 `orphan_entry` + warning，按 zip 键列出。
- 未启用媒体目录的旧路径也产出 `media_import_disabled` 报告，不再只有裸计数。

### 2.3 导出：媒体打回 zip + 完整性透出

- 导出端已有 `collect_media_entries` → `write_media_to_zip`（清单键 `"0","1",...` → 文件名，流式拷贝）。本轮补齐：
  - **超大文件保护**：单文件超过 `MAX_EXPORT_MEDIA_FILE_BYTES`（256 MiB，与导入侧单条目上限对齐）跳过，进入 `missing_media` + warning，导出不中断。
  - **chatanki_export 透出**：改用 `export_multi_template_apkg_report`，工具输出新增 `exportedMedia`（恒返回）、`missingMedia` / `mediaWarnings`（非空才返回），AI 必须据此向用户汇报缺失。
- 往返闭环：导入落盘 → `images` 绝对路径 → 导出按 basename 打包 + 字段引用原样保留 → 再导入可完整还原（`media_round_trip_import_then_export_repacks_media` 全链路断言字节一致）。

### 2.4 安全

| 攻击面 | 防线 | 测试 |
|---|---|---|
| zip 条目名穿越（zip slip） | `is_safe_zip_entry_name` 整包拒绝（既有） | `rejects_traversal_oversize_and_missing_collection_without_persistence`（既有） |
| 清单文件名穿越 `../x` | 压平为 basename，只写媒体目录内 | `media_manifest_path_traversal_never_escapes_media_dir` |
| 反斜杠/盘符（`..\`、`C:`）| `sanitize_media_filename` 显式拒绝（**本轮新增**，Unix 上 `file_name` 不切分 `\`）| 同上 + `media_filename_sanitization_rejects_traversal_and_control_names` |
| 目标路径兜底 | 落盘前二次校验 `target.parent() == media_dir` | 同上（纵深防御） |
| 解压炸弹（zstd 媒体） | 解压量超单条目上限即中止、删半成品、结构化记 `entry_oversized` | `media_decompression_bomb_is_rejected_and_reported` |
| 超大导出媒体 | 256 MiB 上限跳过 + 报告 | `test_export_report_skips_oversized_media_file` |

## 3. 测试矩阵（本轮新增/扩展 12+ 用例）

**`apkg_importer_service.rs` 单测**（新增 7、扩展 3）：

1. `media_report_structures_every_skip_reason_without_silent_loss`（新增）：成功 + 缺失 + 不安全名 + 孤儿混合，count 之和 == mediaSkipped
2. `media_manifest_path_traversal_never_escapes_media_dir`（新增）：`../`、`C:\`、嵌套路径三类，断言媒体目录之外零写入
3. `media_decompression_bomb_is_rejected_and_reported`（新增）：512 KiB 零字节 zstd 炸弹 vs 128 KiB 上限，半成品删除
4. `media_import_links_audio_sound_references`（新增）：`[sound:...]` 音频落盘回链
5. `media_report_serializes_camel_case_contract`（新增）：mediaReport JSON 契约
6. `media_import_reuses_existing_file_for_duplicate_names`（新增）：同名声明两次全部算导入成功
7. `media_round_trip_import_then_export_repacks_media`（新增）：导入→导出→再导入全闭环，zip 清单与字节断言
8. `media_import_extracts_declared_files_and_links_referencing_cards`（扩展）：+ 结构化报告断言
9. `media_import_without_media_dir_keeps_legacy_skip_semantics`（扩展）：+ `media_import_disabled` 报告
10. `modern_media_manifest_failure_degrades_to_no_media_import`（扩展）：+ `manifest_unparsed` 报告
11. `media_filename_sanitization_rejects_traversal_and_control_names`（扩展）：+ 反斜杠/盘符/绝对路径用例

**`tests/chatanki_apkg_executor_e2e.rs`**（新增 1 个 Agent 级闭环）：

12. `executor_media_import_and_export_round_trip`：VFS 资源 → import_apkg（mediaReport/落盘位置断言）→ get_cards → chatanki_export（exportedMedia、导出 zip 字节断言）

**`tests/anki_export_integration.rs`**（新增 2）：

13. `test_export_report_packs_referenced_media_and_reports_missing`
14. `test_export_report_skips_oversized_media_file`（稀疏文件模拟 256 MiB+）

**契约单测**（扩展 2）：`cmd/apkg_import.rs::import_result_with_warnings_serializes_them_for_frontend`（mediaReport 透传）、`chatanki_executor.rs::test_chatanki_import_apkg_result_and_domain_event_contract`（含 mediaReport 的精确 JSON）。

## 4. 兼容性

- 无媒体包的导入结果 JSON 与改造前逐字节一致（`mediaReport`/`warnings` 空时不序列化）。
- `mediaSkipped`/`mediaImported` 语义不变；`with_media_dir` 未启用的调用方保持旧行为。
- 导出 JSON 输出仅在 APKG 格式追加字段，旧字段不动。
- 前端/旧调用方零改动可继续工作；新字段是纯增量。

## 5. 已知边界（如实声明）

- `.colpkg` 集合包仍整体拒绝（结构不同，既有 `colpkg_unsupported` 指引错误）。
- 现代包媒体清单解析失败时降级为全跳过（结构化 `manifest_unparsed`），不阻断卡片导入；无法恢复真实文件名，按 zip 键列出。
- 媒体不做去重哈希：同名即同一媒体（与 Anki 语义一致），不同内容同名时首个来源生效并在导出端告警。
- `images` 存绝对路径：跨设备同步该路径可能失效，但字段引用 + `anki_media/` 目录按 basename 可重建（与桌面 Anki collection.media 同构）。
