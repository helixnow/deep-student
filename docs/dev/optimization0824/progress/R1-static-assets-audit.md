# R1 静态资源体量审计（SA-R1-10）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R1-10（只读分析 + 文档，不改业务逻辑）
> 模型：`claude-fable-5-thinking-xhigh`
> 关联 WI：WI-5（PDF worker 冗余，由 SA-R1-05 落地）、WI-9（pdfjs 按需化，R5+）、WI-6（Android mobile-slim，R3+）

## 0. TL;DR

前端静态资源（不含 JS bundle）在 `dist/` 中合计约 **13.0 MB**，全部随桌面安装包（`frontendDist`）与 Android APK 分发。Top 3 体积大户：

| 排名 | 资产 | 体量 | 说明 |
| --- | --- | --- | --- |
| 1 | `public/wallpapers/study-os/`（4 张 3840×2160 WebP q92） | **4.9 MB** | 实测重压缩到 2560×1440 q82 仅 **1.35 MB**（-73%） |
| 2 | pdfjs viteStaticCopy 资产（cmaps 1.7M + wasm 0.8M + standard_fonts 0.8M） | **~3.2 MB** | 全量 169 个 cmap，绝大多数为 CJK 遗留编码 |
| 3 | `public/legal/THIRD_PARTY_NOTICES.txt` | **2.5 MB ×2** | 同时进 `dist/legal/` 和 tauri `resources/licenses/`，安装包内双份共 ~5 MB |

另有 `public/pdf.worker.min.js`（1.1 MB）**零引用**，属纯冗余（WI-5，SA-R1-05 处理）。

## 1. 体量测量

### 1.1 原始命令输出

审计环境未安装 `node_modules`、未构建 `dist`，因此原始命令只有 `public/` 部分产出：

```text
$ du -sh public/wallpapers public/legal public/pdf* \
    node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm} dist 2>/dev/null || true
4.9M    public/wallpapers
2.5M    public/legal
1.1M    public/pdf.worker.min.js
1.0M    public/pdf.worker.min.mjs
4.0K    public/pdf.worker.wrapper.mjs
```

pdfjs-dist 部分通过在 `/tmp` 临时安装 `pdfjs-dist@5.4.296`（与 `package.json` 锁定版本一致）实测，未触碰仓库：

```text
$ du -sh /tmp/pdfjs-measure/node_modules/pdfjs-dist/*/
13M     build/          # 含 pdf.worker.min.mjs 1,046,214 B，与 public/ 内副本逐字节同大小
1.7M    cmaps/          # 169 个 .bcmap
24K     iccs/
1016K   image_decoders/
18M     legacy/
804K    standard_fonts/ # 10 个 Foxit .pfb + 4 个 LiberationSans .ttf
592K    types/
808K    wasm/           # openjpeg.wasm 250K + qcms_bg.wasm 94K + openjpeg_nowasm_fallback.js 452K
1.4M    web/
```

### 1.2 dist 静态资产估算（viteStaticCopy + public/ 直拷）

`dist/` 未构建，但其静态部分可精确推导 = `public/` 全量拷贝 + viteStaticCopy 四个 target：

| 来源 | 体量 | 进入 dist 路径 |
| --- | --- | --- |
| `public/wallpapers/` | 4.9 MB | `dist/wallpapers/study-os/*.webp` |
| `public/legal/THIRD_PARTY_NOTICES.txt` | 2.5 MB | `dist/legal/THIRD_PARTY_NOTICES.txt` |
| `public/pdf.worker.min.js` | 1.1 MB | `dist/pdf.worker.min.js`（**无引用**） |
| `public/pdf.worker.min.mjs` + wrapper | 1.0 MB | `dist/pdf.worker.min.mjs`（wrapper 实际入口） |
| `public/icons/` + logo/svg/png 等 | ~0.4 MB | `dist/icons/` 等 |
| pdfjs-dist `cmaps/`（viteStaticCopy） | 1.7 MB | `dist/cmaps/` |
| pdfjs-dist `standard_fonts/`（viteStaticCopy） | 0.8 MB | `dist/standard_fonts/` |
| pdfjs-dist `wasm/`（viteStaticCopy） | 0.8 MB | `dist/wasm/` |
| 仓库 `LICENSE`（viteStaticCopy） | 34 KB | `dist/legal/DEEPSTUDENT_LICENSE.txt` |
| **合计（不含 JS bundle）** | **≈13.0 MB** | |

### 1.3 壁纸明细

```text
public/wallpapers/study-os/
  forest-mist.webp    2,305,638 B   VP8 3840×2160
  winter-ridge.webp   1,440,398 B   VP8 3840×2160
  alpine-lake.webp      779,202 B   VP8 3840×2160
  mountain-mist.webp    526,134 B   VP8 3840×2160（默认壁纸）
  ATTRIBUTION.md          2,226 B   CC0 来源记录（q92 编码，见文件尾 Processing 节）
```

### 1.4 cmaps 按文字系统分组（共 1,668 KB）

| 分组（前缀） | 体量 | 覆盖 |
| --- | --- | --- |
| UniJIS* / UniJISX*（日文） | 412 KB | 日文 Unicode 系 |
| UniCNS* + Adobe-CNS1*（繁中） | 296 KB | 台湾/香港 CNS 系 |
| UniGB* + Adobe-GB1*（简中） | 260 KB | 简体中文 GB 系 |
| UniKS* + Adobe-Korea1*（韩文） | 164 KB | 韩文 |
| 其余（90ms-RKSJ、EUC、B5pc、GBK-EUC、HKscs、KSC 等遗留 CJK 编码 + Identity 等） | ~536 KB | 旧式 CJK 编码 PDF |

结论：cmaps 几乎 100% 服务于 CJK PDF；非 CJK PDF 完全不需要该目录。但对本产品（中文学习工具）而言 GB/CNS 组是核心场景，**不能整目录砍**，只能按需加载或裁掉确定不支持的文字系统。

## 2. vite.config.ts 的 viteStaticCopy 分析

```158:165:vite.config.ts
    viteStaticCopy({
      targets: [
        { src: cMapsDir, dest: '' },
        { src: standardFontsDir, dest: '' },
        { src: wasmDir, dest: '' },
        { src: normalizePath(path.join(process.cwd(), 'LICENSE')), dest: 'legal', rename: 'DEEPSTUDENT_LICENSE.txt' },
      ],
    }),
```

- 前 3 个 target 把 `pdfjs-dist` 的 `cmaps/`、`standard_fonts/`、`wasm/` **整目录**拷进 `dist/` 根（`dest: ''`），运行时消费方是 `src/utils/pdfConfig.ts`（`cMapUrl`/`standardFontDataUrl`/`wasmUrl` 均指向 `BASE_URL` 下同名目录）。
- 拷贝是无条件的：桌面、Android、`ANALYZE` 构建全都带上这 3.2 MB，即使用户从不打开含 CJK/JPEG2000 的 PDF。
- `wasm/` 内 452 KB 的 `openjpeg_nowasm_fallback.js` 是"WASM 不可用时"的 JS 回退。Tauri WebView（WebKit/WebView2）均支持 WASM，该回退在本产品运行时基本不可达。
- 第 4 个 target 把仓库 `LICENSE`（34 KB）改名拷到 `dist/legal/DEEPSTUDENT_LICENSE.txt`，供设置页开源致谢面板 `fetch('./legal/DEEPSTUDENT_LICENSE.txt')` 使用（`src/features/settings/components/OpenSourceAcknowledgementsSection.tsx:86-87`）。此项体量可忽略，无需处理。

### 2.1 分发链路放大效应

`src-tauri/tauri.conf.json` 中 `frontendDist: "../dist"`，即上表 13 MB 全部进入每个桌面安装包与 Android APK 资产。此外：

```62:62:src-tauri/tauri.conf.json
      "../public/legal/THIRD_PARTY_NOTICES.txt": "licenses/THIRD_PARTY_NOTICES.txt",
```

`THIRD_PARTY_NOTICES.txt` 在安装包里存在**两份**：一份在 frontendDist（供设置页 `fetch('./legal/THIRD_PARTY_NOTICES.txt')` 展示），一份在 `resources/licenses/`（合规交付）。合计约 5 MB。

## 3. 可裁剪项与实施步骤（供 R2 执行）

### 3.1 【A｜收益最大】壁纸重压缩：4.9 MB → ~1.35 MB（-73%）

本轮已用仓库现有素材做过实测（ffmpeg libwebp）：

| 方案 | forest-mist | winter-ridge | alpine-lake | mountain-mist | 合计 |
| --- | --- | --- | --- | --- | --- |
| 现状 3840×2160 q92 | 2,306 KB | 1,440 KB | 779 KB | 526 KB | **4.9 MB** |
| 3840×2160 q80 | 1,209 KB | 646 KB | 342 KB | 285 KB | **2.38 MB**（-52%） |
| 2560×1440 q82 | 558 KB | 390 KB | 231 KB | 192 KB | **1.35 MB**（-73%） |

壁纸以 `background-size: cover` + blur/dim 调节展示（`WallpaperLayer.tsx`），2560×1440 在绝大多数桌面显示器上视觉无损；且 4 张中仅当前选中的 1 张会被加载，压缩纯粹是砍安装包体量。

R2 实施步骤：

1. 优先从 `ATTRIBUTION.md` 记录的 Wikimedia 原图重新导出（避免二次有损）；离线环境可直接对现有 webp 重压缩，上表即二次压缩后的实测效果，肉眼阈值建议 q80–85。
2. 推荐命令（原图流程）：`cwebp -q 82 -resize 2560 1440 <src> -o <name>.webp`（或 ffmpeg `-vf scale=2560:1440 -c:v libwebp -quality 82`）。
3. 覆盖 `public/wallpapers/study-os/*.webp`，同名替换，代码零改动（`WALLPAPER_PRESETS` 的 `imageUrl` 不变）。
4. 更新 `ATTRIBUTION.md` 的 Processing 节（尺寸/质量参数）。
5. 验证：`npx vitest run src/features/workbench/components/__tests__/WallpaperLayer.test.tsx`（断言 4 个 preset 路径存在）+ 人工切换 4 张壁纸看观感（重点看渐变天空区块效应）。

### 3.2 【B｜零风险去重】legal 双份 → 单份 + 压缩：-2.5 MB（安装包），frontendDist 内 2.5 MB → ~0.6 MB

两个独立子项：

**B1：消除安装包双份（-2.5 MB，纯配置）**
`resources/licenses/THIRD_PARTY_NOTICES.txt` 是合规硬需求（`scripts/check-license-compliance.mjs:96` 校验该映射，不可删）；frontendDist 里的那份仅服务设置页展示，二选一去重：

- 方案 B1a（推荐，改动小）：保留 `public/legal/` 这份、删掉 tauri resources 映射——**不可行**，合规脚本强制要求 resources 映射存在。
- 方案 B1b（实际可行）：`public/legal/` 从 git 与拷贝链路中移除，设置页改为通过 Tauri `resolveResource('licenses/THIRD_PARTY_NOTICES.txt')` + `readTextFile` 读取 resources 内那份；`OpenSourceAcknowledgementsSection.tsx` 的 `fetch` 改为平台分支（Tauri 环境走 fs API，纯 web dev 环境 fallback 到 fetch）。需同步改 `tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx:119` 的断言。
- 方案 B1c（保守替代）：暂不动运行时代码，仅做 B2 压缩，双份合计从 5 MB 降到 ~1.2 MB。

**B2：NOTICES 文本瘦身（2.5 MB → ~0.6 MB）**
`scripts/generate-third-party-notices.mjs` 生成的 2.5 MB 文本中大量为重复的 MIT/Apache-2.0 全文。改造生成脚本：相同许可证文本只保留一份全文，组件条目引用许可证 ID（SPDX 风格"license text appendix"）。注意重新跑 `npm run licenses:generate` 后需通过 `scripts/check-license-compliance.mjs`（其校验文件存在与映射，不校验内容长度）。

R2 建议顺序：先 B2（低风险高收益），B1b 视轮次容量决定。

### 3.3 【C｜cmaps/wasm 裁剪或按需】-0.5 ~ -3.2 MB

三个层次，按风险递增：

**C1：裁掉 `openjpeg_nowasm_fallback.js`（-452 KB，低风险）**
Tauri WebView 必然支持 WASM。把 viteStaticCopy 的 `{ src: wasmDir, dest: '' }` 改为带 filter 的精确拷贝（`vite-plugin-static-copy` 支持 glob）：

```ts
{ src: normalizePath(path.join(wasmDir, '*.wasm')), dest: 'wasm' },
{ src: normalizePath(path.join(wasmDir, 'LICENSE*')), dest: 'wasm' },
```

注意 `src` 用 glob 时 `dest` 需显式写 `'wasm'`（目录整拷与 glob 拷贝的 dest 语义不同，务必构建后 `ls dist/wasm` 验证）。

**C2：cmaps 子集（-0.5 ~ -1.2 MB，中风险）**
产品主场景是简中 + 英文教材 PDF。可保留 GB/CNS/JIS 组、裁掉韩文与部分遗留编码；或激进保留 GB+CNS（-1.1 MB）。实施：viteStaticCopy 改为列举保留前缀的 glob（`UniGB*`、`Adobe-GB1*`、`UniCNS*`、`Adobe-CNS1*`、`GBK*`、`B5pc*`、`ETen*`、`Identity*` 等）。风险：用户打开日/韩 PDF 时 pdfjs 请求缺失 cmap，对应文字渲染为空白（不 crash，控制台警告）。**必须配合 E2E 用例**：加载一份日文 PDF 断言不抛错。
> 注：遗留编码（90ms-RKSJ/EUC/KSC 等 ~536 KB）主要出现在老旧扫描/排版 PDF，教材场景占比可观，建议第一刀只裁韩文组（-164 KB）观察反馈，不建议激进裁剪。

**C3：cmaps/fonts 按需远程 + 本地缓存（-3.2 MB，WI-9 范畴，R5+）**
`cMapUrl` 支持任意 URL。方案：安装包不带 cmaps，运行时首次用到时从 CDN 拉取并缓存到 appData（Tauri fs），`pdfConfig.ts` 指向本地缓存目录的 `convertFileSrc`。涉及离线可用性权衡，留给 WI-9 专项设计，本轮不做。

### 3.4 【D｜交叉引用】pdf.worker.min.js 冗余（WI-5，SA-R1-05 落地）

- `public/pdf.worker.min.mjs`（1,046,214 B）与 pdfjs-dist@5.4.296 的 `build/pdf.worker.min.mjs` **字节数完全一致**，是 wrapper（`public/pdf.worker.wrapper.mjs` 第 15 行 `import './pdf.worker.min.mjs'`）的真实入口，唯一消费方 `EnhancedPdfViewer.tsx:56`。
- `public/pdf.worker.min.js`（1,087,212 B）在 `src/`、`scripts/`、`src-tauri/`、`index.html` 中**零引用**，可直接删除（-1.1 MB）。
- 后续升级 pdfjs-dist 时 `public/pdf.worker.min.mjs` 会静默过期（worker 与主库版本不匹配会报 API version mismatch）。建议 R2+ 把它也改为 viteStaticCopy 从 `node_modules/pdfjs-dist/build/` 拷贝，消除手工同步。本条与 SA-R1-05 的改动同文件区域，R2 合并时注意冲突。

## 4. 收益汇总（R2 可落地部分）

| 项 | 改动面 | dist 收益 | 安装包收益 |
| --- | --- | --- | --- |
| A 壁纸重压缩 | 仅替换 4 个 webp | -3.5 MB | -3.5 MB |
| B2 NOTICES 瘦身 | 生成脚本 | -1.9 MB | -3.8 MB（双份） |
| B1b legal 去重 | 设置页读取路径 + tauri 配置 | -0.6 MB（B2 后） | -0.6 MB |
| C1 wasm fallback | vite.config.ts 一处 | -0.45 MB | -0.45 MB |
| C2 cmaps 保守子集 | vite.config.ts 一处 + E2E | -0.16 ~ -1.2 MB | 同左 |
| D worker 冗余（SA-R1-05） | 删 1 文件 | -1.1 MB | -1.1 MB |
| **合计（A+B2+C1+D 保守组合）** | | **≈ -7 MB（13.0 → ~6 MB）** | **≈ -8.9 MB/包** |

## 5. 审计环境说明

- `node_modules` 未安装、`dist` 未构建（无后台 install 进程）；pdfjs-dist 体量来自 `/tmp` 临时安装同版本包实测，壁纸压缩收益来自 `/tmp` ffmpeg 实测，均未修改仓库。
- 本报告为只读审计，未改动任何业务代码/配置；所有实施步骤留给 R2 子代理。
