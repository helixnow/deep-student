# optimization0824 初始调研摘要

> 来源：首轮 `claude-fable-5-thinking-xhigh` 子代理调研（2026-08-23）  
> 完整报告见父代理对话记录；本文件为可执行 WI 索引。

## 量化基线

| 维度 | 数据 |
| --- | --- |
| TS/TSX | 2,446 文件，~709K 行 |
| Rust | 522 文件，~589K 行 |
| npm lock | 1,295 包 |
| Cargo.lock | 1,221 crates |
| Release 墙钟 | ~141 min |
| PR CI | ~45–61 min |
| APK | 228MB（.so 116MB） |

## P0 快速 wins

1. **WI-1** 移除未使用的 `@anthropic-ai/claude-code`
2. **WI-2** Windows `LTO=false, codegen-units=16`
3. **WI-3** sccache + rust-cache 叠加
4. **WI-4** 前端 dist 一次构建五平台复用
5. **WI-5** 删除重复 pdf worker

## Agent vs Pi 结论

**保留优势**：子代理运行时、OS 沙箱、278 领域工具、工程纪律  
**补齐短板**：token 预算（WI-10）、provider 归一（WI-11）、session replay（WI-12）、hooks（WI-13）

详见 `COORDINATION.md` WI 总表。
