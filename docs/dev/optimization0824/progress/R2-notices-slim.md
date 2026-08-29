# R2 THIRD_PARTY_NOTICES 生成瘦身（SA-R2-05）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R2-05
> 模型：`claude-fable-5-thinking-xhigh`

## 0. TL;DR

重写 `scripts/generate-third-party-notices.mjs` 的输出格式：`public/legal/THIRD_PARTY_NOTICES.txt` 由 **2,585,108 B → 1,260,465 B（2.47 MB → 1.20 MB，-51.2%）**，gzip 后 320,526 B → 144,096 B（-55.0%）。`licenses:generate && licenses:check` 通过；1862 个组件的清单与 License 表达式逐一不变；旧文件全部 815 段许可文本在新文件中可逐词还原（word-level 等价验证，仅 1 例差异且为旧文件本身过期，见 §4）。

## 1. 旧文件体积构成（2,585,108 B）

| 构成 | 字节 | 说明 |
| --- | --- | --- |
| 许可文本正文 | ~1,988,688 | 815 段「按字节去重」的文本，其中 **89 份完整 Apache-2.0 条款正文 ≈ 1,036,075 B（40%）** |
| 头部 + 组件清单 | ~248,981 | 每组件 4 行（含 `Upstream:` URL、12 位 hash id） |
| 每段 notice 的 Applies to / Source license files 列表 | ~168,831 | 与清单中 `Notices:` 映射双向冗余 |
| 分隔线等结构开销 | ~177,670 | 每段 2 条 80 列分隔线 + 标签行 |

## 2. 优化手段（全部不改动任何许可文本的词序）

1. **压缩空白**（`compactWhitespace`，在 `readText` 内统一应用）：去行尾空白、连续空行折叠为一行、去公共缩进。
2. **词序级合并重复**（`wordKey`）：去重键从「原文 SHA-256」改为「词序列 SHA-256」，仅换行/缩进/空行不同的同文文本合并，815 → 795 段（约 -141 KB）。
3. **Apache-2.0 条款正文提取**（`factorCommonTexts`）：以 `TERMS AND CONDITIONS FOR USE, ...` / `END OF TERMS AND CONDITIONS`（含第 9 节结尾词作为部分上游文件缺失 END 行时的后备锚点）定位条款正文，按词序分组，词序完全一致的正文只保留一份 `COMMON TEXT C<n>`，成员 notice 原位替换为一行引用、保留各自版权头/附录。命中 3 组 / 78 段，约 **-790 KB**（这是最大单项收益）。
4. **去冗余字段**：
   - 删除每段 notice 的 `Applies to:` 与 `Source license files:` 列表——组件 → 文本的映射由清单 `Notices:` 行单向保留，信息不丢失；
   - 删除清单 `Upstream:` 行（可由生态 + 包名从 registry 元数据重建）与 `license expression only` 占位行；
   - 12 位 hash id → 顺序短 id `N<n>`；每段 2×80 列分隔线 → 单行 `==== NOTICE N<n> ====`；清单条目间空行移除。

新文件构成：头部 976 B + 清单 121,366 B + COMMON TEXTS 28,878 B + 许可文本 1,109,040 B。

## 3. 兼容性核对

- `scripts/check-license-compliance.mjs` 未改动，逐项对照：两个锁文件 `SHA256:` 行原样保留；必需子串（`rs-fsrs@1.2.1`、`lancedb@0.22.1`、`object_store@0.12.4`、`PDFium chromium/7350`、`format@0.2.2`、`unzipper@0.12.5`）都在清单中；**`  License: <expr>` 两空格行格式保留**，禁用许可证正则扫描仍然有效（非平凡通过）；无机器绝对路径。
- 消费方检索：`OpenSourceAcknowledgementsSection.tsx` 仅 fetch 后原样 `<pre>` 展示，测试只断言 fetch 路径；`tauri.conf.json` 仅做资源拷贝。无任何代码解析该文件内部格式。

## 4. 验证

```text
npm run licenses:generate   # Wrote public/legal/THIRD_PARTY_NOTICES.txt (1862 components).
npm run licenses:check      # [license-compliance] OK
```

- **幂等**：连续两次生成 SHA-256 相同。
- **清单等价**：新旧文件各 1862 个组件，`组件 id → License 表达式` 逐一 diff = 0。
- **文本等价**：将新文件 795 段 notice 中的 COMMON TEXT 引用展开后，与旧文件 815 段文本做词序集合比对，**814/815 完全还原**；唯一差异是 `Study OS wallpapers` 的 ATTRIBUTION.md——SA-R2-04 已提交的 3840→2560 修改未曾再生成 notices，旧文件本身过期，本次顺带修正。
- 环境噪声处理：本 VM setup 重新下载 PDFium 时覆盖了 `src-tauri/resources/pdfium/licenses/pdfium.txt`（仅注释符格式差异，未提交），生成前已 `git checkout --` 还原，保证提交的 notices 与仓库内许可源文件自洽。

## 5. 变更清单

- `scripts/generate-third-party-notices.mjs`：新增 `compactWhitespace` / `wordKey` / `tokenize` / `findWordSequence` / `factorCommonTexts`，重写 `render`；采集逻辑（Cargo/NPM/捆绑资产、UNKNOWN 守卫）不变。
- `public/legal/THIRD_PARTY_NOTICES.txt`：再生成（-51.2%）。
- `docs/dev/optimization0824/progress/R2-notices-slim.md`：本报告。
- 工作树中其他并行子代理的改动未包含（仅 `git add` 上述 3 个文件）。
