# Wave2-A 第 3 轮：issue #122 UTF-8 乱码定位探针

> 定位探针，**不声称修复 issue #122**。解码行为（U+FFFD 替换语义）完全不变，
> 仅在 invalid/lossy 分支新增 `log::warn!`，用于在真实用户日志中区分乱码来源。

## 目的

issue #122 的乱码（`�`）可能来自三类路径：

1. 上游本身发来非法 UTF-8 字节（非"切断"而是"无效"）——`decode()` 的 `Some(invalid_len)` 分支；
2. 流在多字节字符中间被截断后关闭（网络中断）——解码器 `flush()` 的非空残留分支；
3. 跨 chunk 切断但已被增量解码器正确拼接——此路径不产生 `�`，也不打日志。

三个探针分别覆盖路径 1 与路径 2（解码器层 + SSE 事件缓冲层）。若用户日志中
出现探针输出，即可确定 `�` 的来源分支；若乱码复现但探针无输出，则说明乱码
产生于这两个文件之外（如前端渲染或上游 JSON 内容本身）。

## 隐私约束

所有探针**只记录长度类元数据**（invalid_len、valid_up_to、pos、pending 长度、
chunk 长度、缓冲区长度、待发行数），**不打印任何 chunk 字节或用户文本内容**。

## 探针位置（精确行号）

### `src-tauri/src/llm_manager/utf8_stream.rs`

- 第 3-4 行：文件头注明「issue #122 定位探针，不声称修复」。
- 第 49-50 行：`decode()` 入口记录 `pending_len_before`（仅取长度，供探针使用）。
- **第 80-87 行**：`decode()` 的 `Some(invalid_len)` 真非法字节分支的 `log::warn!`，
  记录 `invalid_len`、`valid_up_to`、`pos`、`pending_len_before`、`chunk_len`。
- **第 113-116 行**：`flush()` 非空残留（流在字符中间截断）分支的 `log::warn!`，
  记录 `pending_len`。

### `src-tauri/src/utils/sse_buffer.rs`

- 第 1-4 行：文件头注明「issue #122 定位探针，不声称修复」。
- **第 211-216 行**：`SseEventBuffer::flush()` 中解码器返回非空 lossy 尾部时的
  `log::warn!`，记录 `tail_len`、`text_buffer_len`、`pending_lines`（行数）。

## 行为不变性

- `decode()`：非法字节仍替换为 U+FFFD 并跳过 `invalid_len` 继续解析，逻辑未动；
- `flush()`：非空残留仍按 lossy 语义返回单个 U+FFFD，逻辑未动；
- `SseEventBuffer` 的行切分 / 事件组装 / 大小上限保护均未改动；
- 新增的 `pending_len_before` 局部变量仅读取长度，不影响后续
  `std::mem::take(&mut self.pending)` 的既有流程。

## 限制

- 按本轮铁律未运行 cargo/测试；`log = "0.4"` 已在 `src-tauri/Cargo.toml`
  （第 105 行）声明，且 `log::warn!` 在代码库中已广泛使用，宏可用性无风险。
- 探针只能证明/排除这两个文件内的两条 U+FFFD 产生路径，不覆盖前端渲染层。
