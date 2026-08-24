# Anki 新接线持久化测试

## 范围

新增 `src-tauri/tests/anki_new_wiring_tests.rs`，不修改生产主路径，覆盖三个此前缺少真实 SQLite 边界的合同：

1. 偏好观察经 `extract_preferences` / `consolidate` 写入
   `chatanki_preference_memory_store`，重载后重复观察会强化而非重复新增，且检索提示仍可用。
2. Image Occlusion 草稿生成的 `_occlusion` 与模型已有 `extra_fields`、识别 tag
   一起落库；回读后 spec 的图片引用、标签和 cloze 序号保持不变。
3. `_original_generation` 通过幂等写入 helper 生成后落库；卡片正文后续被编辑时，
   原始快照与其他扩展字段保持不变，并兼容数据库中的二次 JSON 编码形态。

这些测试使用生产 Mistakes migrations 建立临时数据库，不访问网络，不依赖用户数据。

## 验证

最终 rebase 后执行：

```bash
cd src-tauri
cargo test --test anki_new_wiring_tests
cargo test --test anki_ai_native_integration
```
