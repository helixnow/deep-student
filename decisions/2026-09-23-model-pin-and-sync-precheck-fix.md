# 2026-09-23 会话模型固定标志 + 同步预检豁免修复

## 背景

两个实机 bug：

1. **模型分配切换不生效**：设置里改默认模型后，已存在的会话仍用旧模型。
2. **上传同步预检失败**：报 `vfs.note_document_revisions` 缺 `__change_log` update/delete 触发器。

## 根因（详见当日分析会话）

### Bug 1
`TauriAdapter.applyRuntimeModelSelection` 把解析出的模型（含全局默认 fallback）写回 `chatParams.modelId` 并自动持久化到 `chat_v2_session_state.chat_params_json`。首次发送后全局默认被"烘焙"成会话固定值，`resolveEffectiveChatModelId` 第一分支（`chatParams.modelId` 非空即用）永远命中旧值，读不到新全局默认。

### Bug 2
- `note_document_revisions` 的 delete 触发器是**设计豁免**（剪枝不回放他设备），registry 已有 `TableClassification::change_log_trigger_exempt`，但 `validate_sync_registry_drift` 从不调用它。
- pin 触发器 `trg__change_log_note_document_revisions_pin` 是 `AFTER UPDATE OF pinned`，预检 op 嗅探找子串 `" AFTER UPDATE "`，匹配不到 `UPDATE OF`，update 被误报。
- 预检对 Download 方向也硬失败。

## 决策

### Bug 1 —— 方向 1：pinned 标志
- `ChatParams` 增加 `modelIdPinnedByUser?: boolean`（可选，旧会话 JSON 无此字段反序列化为 undefined，按 false 处理）。
- 仅当用户在 ModelPicker/InputBar 显式单选模型时置 `true` 并持久化 modelId。
- `applyRuntimeModelSelection` **不再**把 fallback 解析结果写回 store；仅当 `modelIdPinnedByUser === true` 时写回 modelId。`modelDisplayName` 也不回写（避免把 fallback 显示名固化）。
- `resolveEffectiveChatModelId` 不变（优先级：chatParams.modelId 非空 → 全局默认 → 兜底）；但因 fallback 不再回写，未固定会话的 `chatParams.modelId` 保持空，每次发送都会现取全局默认。
- `resetChatParams` 保留逻辑：只保留 pinned 会话的 modelId，未固定会话重置后 modelId 清空。
- 旧会话迁移：无此字段 → undefined → 视为未固定 → 下次发送取全局默认。**这是行为变化**：旧会话里被烘焙的 modelId 仍在 JSON 里，第一分支仍会命中。为让旧会话也能跟随，发送时若 `modelIdPinnedByUser !== true`，则在解析前把传入的 `modelId` 视为"可能是烘焙残留"——不能直接丢（用户可能在旧版本手选过）。折衷：未固定且 chatParams.modelId 与当前全局默认不同，仍尊重 chatParams.modelId 一次，但本次起不再回写；用户想跟随新默认可在会话里重选或重置。**最终决定：未固定会话的持久化 modelId 一律忽略，直接取全局默认**——因为旧版本里"手选模型"也会走同一条 setChatParams 路径，无法区分；为彻底修复"切换不生效"，牺牲旧会话的固化值，让它回归全局默认。用户若需要固定，新版本里重选一次即 pinned。

### Bug 2 —— 接豁免 + 修嗅探 + 补测试
- `validate_sync_registry_drift` 的三 op 循环里调 `TableClassification::change_log_trigger_exempt(db_name, table, required)`，豁免命中跳过该 op。
- op 嗅探：`UPDATE` 分支容忍 `UPDATE OF`，把 `contains(" AFTER UPDATE ")` 改为同时匹配 `" AFTER UPDATE OF "`（BEFORE 同理）；更稳用 starts_with 前缀判断。
- 补单元测试：豁免表缺 delete 不报错；`AFTER UPDATE OF` 触发器被识别为 update。
- Download 方向门控暂不动（超出本次范围，另议）。

## 影响面
- 前端：ChatParams 类型、createDefaultChatParams、applyRuntimeModelSelection、useInputBarV2 单选路径、resetChatParams。
- Rust：commands_sync.rs 预检 + 测试。
- 无 schema 变更（modelIdPinnedByUser 是 chat_params_json 里的可选字段）。
