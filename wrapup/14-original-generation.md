# 收尾续作 #4：`_original_generation` 首次入库快照

## 结论

流式卡片在第一次写入 `anki_cards` 前，会把清理后的 `front`、`back` 和可选
`text` 序列化到 `extra_fields["_original_generation"]`。`anki_gold_set` 的既有
读取端可以直接解出该快照，用户后续修改卡片正文后即可挖掘「改前劣化、改后金标」
修正对，供 grounded critic 使用。

## 写入边界

- 只在 `StreamingAnkiService::parse_and_save_card` 的新卡入库路径写入。
- 使用 `insert_original_generation_once` 的幂等语义；只要键已存在，无论值是否为
  合法 JSON，都逐字节保留，不覆盖用户或旧版本写入的值。
- 快照取自模板占位符清理、Cloze `text` 补齐之后的实际入库正文，与卡片初始可见态
  一致；`text=None` 时不写 JSON `text` 属性。
- 快照 JSON 值按 UTF-8 字节计算，硬上限为 16 KiB。超限时跳过快照并记录 warning，
  不截断正文，也不影响卡片入库。
- 序列化失败同样只降级为无快照卡，不改变既有生成、lint、去重和入库错误语义。
- 没有 schema migration；存储形态仍是 `HashMap<String, String>` 二次编码到
  `extra_fields_json`。

## 回归覆盖

新增 12 个测试：

1. front/back/text 完整写入并可由读取端往返解析；
2. `text=None` 时省略字段；
3. 显式空 `text` 保持为 `Some("")`；
4. 同一 map 二次调用不覆盖首次值；
5. 既有非法/用户值也不覆盖，并优先于体积校验；
6. 恰好 16 KiB 可写；
7. 超一字节拒绝且 map 无任何部分写入；
8. 多字节 Unicode 按 UTF-8 字节而非字符数计限；
9. 真实 `parse_and_save_card` 路径写入并持久化基础卡快照；
10. Cloze 卡快照包含最终 `text`；
11. 真实解析路径保留既有 `_original_generation`；
12. 超限快照失败时卡片仍正常落库。
