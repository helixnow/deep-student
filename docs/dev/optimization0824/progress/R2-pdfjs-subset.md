# R2 pdfjs cmaps/静态资产保守裁剪（SA-R2-10）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R2-10（仅改 `vite.config.ts` + 本报告）
> 模型：`claude-fable-5-thinking-xhigh`
> 上游依据：`R1-static-assets-audit.md` §3.3（C1 wasm fallback、C2 cmaps 子集）
> 版本基准：`pdfjs-dist@5.4.296`

## 0. TL;DR

`viteStaticCopy` 的 pdfjs 三个整目录拷贝改为精确子集拷贝，**每个桌面安装包与 Android APK 各省 996,131 B（≈0.95 MiB，pdfjs 静态资产 −36.2%）**：

| dist 目录 | 裁剪前 | 裁剪后 | 节省 |
| --- | --- | --- | --- |
| `cmaps/` | 1,167,747 B（169 文件） | 623,393 B（68 文件） | **−544,354 B（−46.6%）** |
| `wasm/` | 802,108 B（7 文件） | 350,331 B（6 文件） | **−451,777 B（−56.3%）** |
| `standard_fonts/` | 780,306 B（16 文件） | 780,306 B（16 文件，未动） | 0 |
| **合计** | **2,750,161 B** | **1,754,030 B** | **−996,131 B（−36.2%）** |

`npm run build` 全流程（version:generate + licenses:check + typecheck + vite build）验证通过；dist 产物逐目录核对与预期完全一致（见 §4）。

## 1. cmaps：保留 68 个（609 KB）

保留策略 = **简中 GB 全系（核心场景，一个不裁）+ 其他 CJK 文字系统的"常用 Unicode"**（现代 UCS2/UTF16 编码 cmap + Adobe registry 系列）。`vite.config.ts` 中以 glob 白名单表达：

```ts
const keptCMapGlobs = [
  'UniGB-*', 'Adobe-GB1-*', 'GB*',                  // 简中 GB 全系
  'UniCNS-UCS2-*', 'UniCNS-UTF16-*',                // 繁中现代 Unicode
  'UniJIS-UCS2-*', 'UniJIS-UTF16-*',                // 日文现代 Unicode
  'UniKS-UCS2-*', 'UniKS-UTF16-*',                  // 韩文现代 Unicode
  'Adobe-CNS1-*', 'Adobe-Japan1-*', 'Adobe-Korea1-*', // registry 系列（含 ToUnicode）
  'LICENSE',
];
```

### 1.1 保留明细（按组）

| 组 | 文件数 | 体量 | 文件 |
| --- | --- | --- | --- |
| 简中 GB 全系 | 33 | 291,547 B | `UniGB-{UCS2,UTF8,UTF16,UTF32}-{H,V}`（8）、`Adobe-GB1-{0..5,UCS2}`（7）、遗留编码 `GB-EUC-*`、`GB-{H,V}`、`GBpc-EUC-*`、`GBK-EUC-*`、`GBKp-EUC-*`、`GBK2K-*`、`GBT-*`、`GBT-EUC-*`、`GBTpc-EUC-*`（18） |
| 繁中 Unicode + registry | 12 | 142,886 B | `UniCNS-{UCS2,UTF16}-{H,V}`、`Adobe-CNS1-{0..6,UCS2}` |
| 日文 Unicode + registry | 14 | 110,117 B | `UniJIS-{UCS2,UTF16}-{H,V}`、`UniJIS-UCS2-HW-{H,V}`、`Adobe-Japan1-{0..6,UCS2}` |
| 韩文 Unicode + registry | 8 | 76,763 B | `UniKS-{UCS2,UTF16}-{H,V}`、`Adobe-Korea1-{0..2,UCS2}` |
| 许可证 | 1 | 2,080 B | `LICENSE`（Adobe cmap BSD 声明，随分发保留） |
| **合计** | **68** | **623,393 B** | |

保留 `Adobe-*-UCS2` 的原因：pdf.js 对 Identity 编码的 CID 字体构建 ToUnicode（复制/搜索文字）时会按 registry 拉取对应 `-UCS2` 映射，缺失则该类 PDF 文本无法正确提取；`Adobe-*-{0..6}` 编号文件单个仅 200–500 B，作为编码 cmap 偶有出现，顺带保留（17 个合计 5.9 KB）。

### 1.2 删除明细（101 个，544,354 B）

| 组 | 文件数 | 体量 | 文件 |
| --- | --- | --- | --- |
| 日文遗留编码 + 罕见变体 | 53 | 323,691 B | `78-EUC-{H,V}`、`78-{H,V}`、`78-RKSJ-{H,V}`、`78ms-RKSJ-{H,V}`、`83pv-RKSJ-H`、`90ms-RKSJ-{H,V}`、`90msp-RKSJ-{H,V}`、`90pv-RKSJ-{H,V}`、`Add-{H,V}`、`Add-RKSJ-{H,V}`、`EUC-{H,V}`、`Ext-{H,V}`、`Ext-RKSJ-{H,V}`、`H`、`V`、`Hankaku`、`Hiragana`、`Katakana`、`Roman`、`WP-Symbol`、`NWP-{H,V}`、`RKSJ-{H,V}`、`UniJIS-{UTF8,UTF32}-{H,V}`、`UniJIS2004-{UTF8,UTF16,UTF32}-{H,V}`、`UniJISPro-{UCS2-V,UCS2-HW-V,UTF8-V}`、`UniJISX0213-UTF32-{H,V}`、`UniJISX02132004-UTF32-{H,V}` |
| 繁中遗留编码 + 罕见变体 | 32 | 137,024 B | `B5-{H,V}`、`B5pc-{H,V}`、`CNS-EUC-{H,V}`、`CNS1-{H,V}`、`CNS2-{H,V}`、`ETen-B5-{H,V}`、`ETenms-B5-{H,V}`、`ETHK-B5-{H,V}`、`HKdla-B5-{H,V}`、`HKdlb-B5-{H,V}`、`HKgccs-B5-{H,V}`、`HKm314-B5-{H,V}`、`HKm471-B5-{H,V}`、`HKscs-B5-{H,V}`、`UniCNS-{UTF8,UTF32}-{H,V}` |
| 韩文遗留编码 + 罕见变体 | 16 | 83,639 B | `KSC-EUC-{H,V}`、`KSC-{H,V}`、`KSC-Johab-{H,V}`、`KSCms-UHC-{H,V}`、`KSCms-UHC-HW-{H,V}`、`KSCpc-EUC-{H,V}`、`UniKS-{UTF8,UTF32}-{H,V}` |

取舍依据：现代 PDF 生成器几乎全部内嵌字体 + Identity 编码（不需要任何 cmap 文件）；预定义编码 cmap 只出现在老式 CJK 排版/扫描件。其中 UTF8/UTF32 编码变体在真实 PDF 中极罕见（Acrobat/InDesign 输出 UCS2/UTF16），遗留国标编码（RKSJ/EUC/B5/HK/KSC/Johab）集中于日/繁/韩旧文档——对本产品（简中学习工具）为边缘场景。**简中一侧的遗留编码（GBK/GBK2K/GBT 等）全部保留，简中 PDF 不受任何影响。**

### 1.3 命中缺失 cmap 的行为

pdf.js `getDocument` 默认 `stopAtErrors: false`（即 `ignoreErrors: true`）：加载不到内置 cmap 时仅 console 告警并跳过该字体的翻译，页面继续渲染（对应文字区域空白），**不 crash、不白屏**。R1 §3.3 已注明相同结论。

## 2. wasm：删除 `openjpeg_nowasm_fallback.js`（−451,777 B）

拷贝目标从整目录改为 `wasm/*.wasm` + `wasm/LICENSE*`，保留 `openjpeg.wasm`（250,009 B，JPEG 2000 解码）、`qcms_bg.wasm`（94,519 B，色彩管理）与 4 份许可证，唯一裁掉的是 452 KB 的 JS 回退。

不可达论证（读 `pdfjs-dist@5.4.296` worker 源码 `src/core/jpx.js` 段落确认）：

1. `openjpeg_nowasm_fallback.js` 只在两条路径被动态 `import`：`JpxImage.#instantiateWasm` 中 `WebAssembly.instantiate` 抛错，或调用方显式传 `useWasm: false`。
2. 本仓库 `src/` 无任何 `useWasm` 传参（已 grep 确认），走默认 `true`。
3. Tauri 各端 WebView（macOS/iOS WKWebView、Windows WebView2、Linux WebKitGTK、Android System WebView/Chromium）均支持 WebAssembly，`instantiate` 失败路径实际不可达。

极端兜底行为：若真发生 WASM 初始化失败，回退 JS 也加载不到时，pdf.js 抛 `JpxError`——仅影响**含 JPEG 2000 图片**的 PDF 的图片显示，属可接受的降级。

## 3. standard_fonts：评估后整目录保留（"仅留 Liberation"不采纳）

任务给出的选项是"保留 Liberation 子集（若可行）"。实测拆解后**判定不划算，未执行**：

- 目录构成：10 个 Foxit `.pfb` 合计仅 200,615 B，4 个 `LiberationSans-*.ttf` 573,724 B，许可证 5,967 B——大头本来就是 Liberation。
- "只留 Liberation"＝裁掉全部 Foxit，仅省 ~196 KB；但 Foxit 字形承载的是 PDF 标准 14 字体中的 **Times/Courier/Symbol/ZapfDingbats**（pdf.js `getFontNameToFileMap` 映射），未内嵌字体的英文教材/试卷/老文档命中率高，裁掉后这类 PDF 全部退化为系统字体替换渲染（Android WebView 无 Times 类衬线字体，退化更明显）。
- 结论：~196 KB 收益 vs 高频场景保真度损失，风险收益比不成立。本轮 wasm 一项（−441 KB）已覆盖两倍于它的体量。

## 4. 验证

### 4.1 npm run build 成功

共享工作区内有其他 R2 子代理的未提交改动（`package-lock.json` 变更导致 `licenses:check` 哈希不匹配、dnd 迁移半成品导致 typecheck 报错，均与本任务无关；已核对 HEAD 的 `package-lock.json` SHA256 = NOTICES 内嵌值 `dedb13cf…`，即干净检出下检查通过）。因此在**独立 git worktree（HEAD + 仅本任务的 `vite.config.ts` 改动）**中执行完整验证：

```text
$ git worktree add /tmp/r2-10-verify HEAD && cp vite.config.ts /tmp/r2-10-verify/
$ cd /tmp/r2-10-verify && npm ci && npm run build   # prebuild: version:generate + licenses:check + typecheck
...
[vite-plugin-static-copy] Copied 76 items.
✓ built in 1m 13s
BUILD EXIT:0
```

76 项 = 68 cmaps + 6 wasm + standard_fonts 整目录 + `legal/DEEPSTUDENT_LICENSE.txt`。

### 4.2 dist 产物核对

```text
$ ls dist/cmaps | wc -l          → 68
$ du -sb dist/cmaps              → 623,393 B（裁剪前 1,167,747 B）
$ ls dist/wasm                   → openjpeg.wasm qcms_bg.wasm LICENSE_{OPENJPEG,PDFJS_OPENJPEG,PDFJS_QCMS,QCMS}
$ du -sb dist/wasm               → 350,331 B（裁剪前 802,108 B）
$ ls dist/standard_fonts | wc -l → 16（未动，780,306 B）
```

- glob 拷贝的文件与 `node_modules` 源文件 SHA256 逐一致（抽验 `UniGB-UCS2-H.bcmap` 一致）；dist 根目录无 glob 拍平造成的散落文件。
- 运行时消费方 `src/utils/pdfConfig.ts`（`cMapUrl: BASE_URL + 'cmaps/'` 等三项）零改动，路径语义不变。

## 5. 风险与回滚

- **风险面**：仅影响"未内嵌字体且使用非 GB 遗留编码/罕见 UTF8/UTF32 编码"的日/繁/韩旧式 PDF——对应文字渲染空白 + console 告警（不 crash）。简中 PDF（含 GBK/GBK2K 等遗留编码）与所有内嵌字体的现代 PDF 完全不受影响。
- **回滚**：将 `viteStaticCopy` 三个 target 恢复为整目录 `{ src: cMapsDir|wasmDir, dest: '' }` 即可，运行时零依赖变化。
- **后续建议**（不在本轮范围）：按 R1 §3.3 C2 的建议补一条 E2E——加载一份日文 PDF 断言不抛错、页面可渲染；cmaps 全量按需远程 + 本地缓存（WI-9）留待 R5+。
