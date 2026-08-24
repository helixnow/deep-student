# R2 壁纸重压缩（SA-R2-04）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R2-04（落地 R1 报告 §3.1 方案 A）
> 模型：`claude-fable-5-thinking-xhigh`
> 前置：`R1-static-assets-audit.md` §1.3 / §3.1

## 0. TL;DR

`public/wallpapers/study-os/` 4 张壁纸由 3840×2160 q92 重压缩为 **2560×1440 q82**，总体积 **5,051,372 B → 1,410,396 B（4.86 MB → 1.35 MB，-72.6%）**，优于 <1.5 MB 目标。全部从 Wikimedia 原图单次编码（非二次有损），SSIM 0.977–0.987 / PSNR 40.8–45.1 dB，视觉质量可接受。代码零改动，`WallpaperLayer` 测试 19/19 通过。

## 1. 实施方式

R1 报告建议优先从 `ATTRIBUTION.md` 记录的 Wikimedia Commons 原图重新导出以避免二次有损。本 VM 网络可达 `upload.wikimedia.org`，故走原图流程：

1. 下载 4 张 CC0 原图（尺寸与 ATTRIBUTION.md 记录逐一吻合：3840×2560 / 5472×3648 / 4288×2848 / 5184×3456）。
2. 用仓库自带 `sharp@0.34.5`（libwebp 后端）编码，复刻原处理管线、仅改目标尺寸与质量：

```js
sharp(src)
  .rotate()                                            // EXIF 自动转向
  .resize(2560, 1440, { fit: 'cover', position: 'centre' })  // 16:9 居中裁切
  .webp({ quality: 82, smartSubsample: true, effort: 6 })
  .toFile(out);
```

3. 同名覆盖 `public/wallpapers/study-os/*.webp`，`WALLPAPER_PRESETS` 的 `imageUrl` 不变，代码零改动。
4. 更新 `ATTRIBUTION.md` 头部尺寸说明与 Processing 节（2560×1440、q82、单次编码）。

工具选择说明：VM 无 cwebp/imagemagick；`sharp` 已在 `node_modules` 中且与构建链同源，另有 ffmpeg 用于质量度量。

## 2. 体积结果

| 文件 | 原（3840×2160 q92） | 新（2560×1440 q82） | 降幅 |
| --- | --- | --- | --- |
| forest-mist.webp | 2,305,638 B | 580,282 B | -74.8% |
| winter-ridge.webp | 1,440,398 B | 402,584 B | -72.1% |
| alpine-lake.webp | 779,202 B | 236,126 B | -69.7% |
| mountain-mist.webp（默认） | 526,134 B | 191,404 B | -63.6% |
| **合计** | **5,051,372 B（4.86 MB）** | **1,410,396 B（1.35 MB）** | **-72.6%** |

dist/安装包收益 ≈ **-3.5 MB**（与 R1 §4 预估一致）。

## 3. 视觉质量验证

以"原图 → 同管线裁切/缩放 → 无损 PNG"为基准，用 ffmpeg 度量 q82 编码损失（数值仅反映 WebP 编码，不含缩放）：

| 文件 | SSIM (All) | PSNR (avg, dB) |
| --- | --- | --- |
| mountain-mist | 0.9872 | 45.07 |
| alpine-lake | 0.9848 | 44.18 |
| winter-ridge | 0.9817 | 42.34 |
| forest-mist | 0.9766 | 40.82 |

- 4 张均 PSNR > 40 dB / SSIM > 0.976，摄影内容下属"视觉无差"区间；R1 提示的渐变天空区（SSIM Y 通道 0.977–0.984）未见明显块效应退化。
- 运行时壁纸经 `WallpaperLayer` 的 blur/dim 叠加展示，进一步掩蔽编码噪声。
- 局限：远程 VM 无法人工逐张目测，以上为客观指标结论；如需可在桌面端切换 4 张 preset 复核观感。

## 4. 测试

```text
npx vitest run src/features/workbench/components/__tests__/WallpaperLayer.test.tsx
Test Files  1 passed (1) / Tests  19 passed (19)
```

新文件均通过 sharp 解码校验（webp, 2560×1440）。

## 5. 变更清单

- `public/wallpapers/study-os/{forest-mist,winter-ridge,alpine-lake,mountain-mist}.webp`：同名替换。
- `public/wallpapers/study-os/ATTRIBUTION.md`：尺寸/质量参数更新。
- `docs/dev/optimization0824/progress/R2-wallpapers.md`：本报告。
- 无任何代码/配置改动。工作树中另有并行子代理的 `.github/workflows` 改动，本次提交未包含。
