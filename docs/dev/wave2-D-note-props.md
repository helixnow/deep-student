# Wave2-D 笔记自定义属性（notes.props）设计备忘

> 0824 Wave2-D 第 3 轮。范围：props 读侧解析/观测 + 共享键语法。
> 代码入口：`src-tauri/src/vfs/note_props.rs`（键语法 + 畸形观测），
> `VfsNoteRepo::row_to_note`（读侧），共享测试向量见 `note_props::test_vectors`
> 及前端镜像 `src/features/workbench/apps/notes/__tests__/parseTagQuery.test.ts`。

## 裁决一：number/bool 编辑类型退化

**现状**：后端 props 值允许 string/number/bool 三种标量并原样存 JSON。
前端 `NoteCustomPropsEditor` 渲染时把所有值 `String(raw)`（第 77 行），
且保存走「整对象替换」——用户只要编辑任何一个属性，`priority: 2` 会被写回
`"2"`、`pinned: true` 写回 `"true"`，number/bool 静默退化为 string。

**裁决**：
- **读侧保留 JSON 原生类型**。`row_to_note` / `parse_props_cell` 不做任何
  类型折叠；测试已断言 `priority == json!(2)`、`pinned == json!(true)`。
- **写侧不得 stringify 未编辑的条目**。编辑器整对象替换时必须以原始
  JSON 值为底稿，只把用户真正改动的那个键的值替换为其输入（string）；
  不做 `"true"`/`"2"` 的猜测式类型还原（还原属于后续独立决策）。
- 本轮不改 UI，只固化上述契约；退化路径由本备忘 + 读侧类型断言测试钉住。

## 裁决二：畸形 props 的读侧观测（已实施）

- JSON 解析失败 / 非 object / 空 object（写侧应把 `{}` 规范化为 SQL NULL，
  落库 `{}` 说明有旁路写入）：`tracing::warn` + 进程级 `AtomicU64` 计数
  （`note_props::malformed_props_total`），随后回退 `None`。禁止静默。
- rusqlite `InvalidColumnName` = 查询没选 props 列（部分投影），是正常
  路径，保持静默 `None`，**不**计入畸形。其余列取值错误按畸形计数。

## 设计稿：props 投影表（N+1 消除，仅设计不实施）

**问题**：属性过滤（`search_notes` → `props_match_filters`）目前是
全量列出候选笔记后在内存里逐行解析 props JSON 再比对——候选集越大，
逐行 `serde_json::from_str` + HashMap 重建的开销越大；且过滤无法下推到
SQL，folder/type/prop 复合查询只能靠分页前全扫兜底。

**方案（草案）**：新增投影表

```sql
CREATE TABLE note_props_kv (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  key_norm   TEXT NOT NULL,   -- trim + lower（与 note_props::normalize_prop_key 同口径）
  value_text TEXT NOT NULL,   -- 标量统一转 text 供包含匹配；原始类型仍以 notes.props 为准
  value_type TEXT NOT NULL,   -- 'string' | 'number' | 'bool'（读侧类型契约的落库佐证）
  PRIMARY KEY (note_id, key_norm)
);
CREATE INDEX idx_note_props_kv_key ON note_props_kv(key_norm, value_text);
```

- 同步策略：与 `notes.props` 同事务重建该笔记的投影行（delete + insert，
  props 最多 32 条，代价可忽略）；`notes.props` 仍是唯一事实来源，
  投影可随时由回填任务重建。
- 查询：每个过滤键一个 `EXISTS (SELECT 1 FROM note_props_kv WHERE
  note_id = n.id AND key_norm = ?k AND value_text LIKE '%'||?v||'%')`，
  与 folder/type 条件一起下推，offset/limit 语义自然正确。
- 触发条件：笔记量或属性使用量上到内存过滤可感知延迟时再实施；
  届时迁移脚本 + 回填 + `search_helpers` 查询改写为一个独立轮次。
