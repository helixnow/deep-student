# Wave2-E R5-03：anki_cards 读侧 nullable 加固

- 轮次：0824 Wave2-E 第 5 轮「nullable 读侧」
- 独占范围：`src-tauri/src/database/mod.rs` 的 anki_cards 读路径；
  `src-tauri/src/fsrs_review_service.rs` 中联表 anki_cards 的 `get::<_, String>`
- 约束：只改读取（`Option<String>` + `unwrap_or_default`），不重构 database，
  不改 `coordinator.rs`，无新 migration，未跑测试，未 commit

## 背景

`anki_cards` 的 `front` / `back` / `text` / `tags_json` / `images_json` /
`extra_fields_json` 列在历史库、导入或同步产生的行中可能为 NULL（旧建表
语句无 NOT NULL 约束，兼容性 `ALTER TABLE` 补列也允许 NULL）。共享 mapper
`map_anki_card_row` 与 `list_anki_library_cards` 已对三个 JSON 列做了
`Option<String>` 防御，但多处手写 mapper 仍直取 `String`：遇到 NULL 会让
整条查询以 `InvalidColumnType` 失败，导致整批卡片读不出来。

本轮统一读侧语义：可空文本列一律读成 `Option<String>`，NULL 兜底为
默认值（空串 / 空集合），不引入任何 schema 变更。

## 改动内容

### `src-tauri/src/database/mod.rs`（共 26 处 get）

| 位置 | 改动 |
| --- | --- |
| `map_anki_card_row` | `front` / `back` 改 `Option<String>` + `unwrap_or_default`（2 处；JSON 三列此前已是 Option） |
| `map_anki_library_record_row` | 同上（2 处） |
| `get_cards_for_task` 内联 mapper | `tags_json` / `images_json` / `extra_fields_json` 改 Option + 软解析，`front` / `back` 改 Option 兜底（5 处） |
| `get_cards_for_document` 内联 mapper | 同上（5 处） |
| `get_cards_by_ids` 内联 mapper | 同上（5 处） |
| `get_recent_anki_cards` 内联 mapper | 同上（5 处） |
| `list_anki_library_cards` 内联 mapper | `front` / `back` 改 Option 兜底（2 处；JSON 三列此前已是 Option） |

`text` 字段（`AnkiCard.text: Option<String>`）各处本就按 Option 读取，保持不动。
写路径、SQL 语句、函数签名均未改。

### `src-tauri/src/fsrs_review_service.rs`（共 12 处 get）

| 位置 | 改动 |
| --- | --- |
| `get_due_inner::map_due_row` | `front` / `back` / `tags_json` / `extra_fields_json` / `images_json` 改 Option + 兜底（5 处；SQL 已 COALESCE，属读侧双保险） |
| `load_review_cards_for_states` | 元组前两列（`front` / `back`，SQL 裸取无 COALESCE，真实 NULL 风险）及三个 JSON 列改 `Option<String>`（5 处）；NULL 视为空集合，**非法 JSON 仍保持原有硬错误语义**（`map_err` 路径未变） |
| `list_feedback_rows` | `front`、`tags_json` 改 Option + 兜底（2 处） |

其余联表 anki_cards 的查询只取 `ac.id` / `is_error_card` / `updated_at` 等
非目标列，或已是 `Option`（如 `get_card_tags`），保持不动。

## 语义说明

- NULL → 默认值：`front` / `back` → 空串；`tags` / `images` → 空 Vec；
  `extra_fields` → 空 HashMap；与既有共享 mapper `map_anki_card_row` 的
  行为完全一致。
- `load_review_cards_for_states` 特意区分「NULL（兜底默认）」与「非法
  JSON（仍报 `AppError::database`）」，不放宽原有数据损坏检测。
- 无新 migration；无 schema / SQL 改动；`coordinator.rs` 未触碰。

## 验证

- `cargo check` 编译通过（未跑测试，按本轮约束）。
