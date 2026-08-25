# Anki Rust 编译与核心单测收尾（子代理 #1）

日期：2026-08-24

## 执行命令

```bash
cd src-tauri
cargo check --lib
```

Rust 标准测试框架一次只接受一个名称过滤器，因此将指定过滤器逐项执行：

```bash
for filter in \
  anki_protocol:: \
  anki_qa_lint:: \
  anki_critic:: \
  anki_preference_memory:: \
  anki_fsrs_feedback:: \
  anki_gold_set:: \
  anki_image_occlusion:: \
  anki_model_routing:: \
  chatanki_transform
do
  cargo test --lib -- "$filter"
done
```

执行器测试按指定线程数运行：

```bash
cargo test --lib -- chatanki_executor:: -- --test-threads=8
```

## 结果

- `cargo check --lib`：通过；仅保留仓库已有 warning，未处理无关 `dead_code`。
- 9 个 Anki 核心过滤器：全部通过，0 失败。
  - `anki_protocol::`：21 通过。
  - `anki_qa_lint::`：65 通过。
  - `anki_critic::`：43 通过。
  - `anki_preference_memory::`：19 通过。
  - `anki_fsrs_feedback::`：通过。
  - `anki_gold_set::`：30 通过。
  - `anki_image_occlusion::`：21 通过。
  - `anki_model_routing::`：17 通过。
  - `chatanki_transform`：64 通过。
- `chatanki_executor::`：125 通过，0 失败，使用 8 个测试线程。

## 修复

1. 更新 `chatanki_executor` 单测调用，为新增的生成调优和偏好提示参数补默认值，恢复 test target 编译。
2. 将 `anki_gold_set` 中返回借用结果的临时样本数组改为局部绑定，修复 3 处 `E0716` 生命周期错误。
3. 修复空 `CardSnapshot` 的编辑比率：`combined()` 固定含 front/back 换行分隔符，旧代码因此无法识别空快照，并会把空到非空的比率算成 `2.0`；现改为基于快照字段判空，按契约返回 `1.0`。
4. 检查 `AnkiGenerationOptions` 构造点；当前字面量已包含新增 serde-default 字段，最小测试构造通过 serde 反序列化，不需要额外补字段。

Linux 本地验证使用支持 edition 2024 的 stable Rust，并准备了 Tauri、`protoc`、`lld` 与未跟踪的 PDFium 运行资源；这些环境准备未提交到仓库。
