import path from 'node:path';
import { Config } from '@remotion/cli/config';
import { webpackOverride } from './webpack-override.mjs';

// 终版用 PNG 截帧（JPEG 会让色度被 4:2:0 处理两遍、还多花码率）；预览脚本用 --image-format=jpeg 覆盖。
Config.setVideoImageFormat('png');
// 写 BT.709 矩阵与色彩标签：不写时按 BT.601 编码，而播放器按 BT.709 解码，饱和色会偏。
Config.setColorSpace('bt709');
Config.setConcurrency(Number(process.env.REMOTION_CONCURRENCY) || 4);
// 3D 段走 WebGL，用 ANGLE（Windows → D3D11，mac → Metal）；无 GPU 的 Linux 设 REMOTION_GL=swangle。
Config.setChromiumOpenGlRenderer((process.env.REMOTION_GL as 'angle' | 'swangle' | undefined) ?? 'angle');
Config.setPublicDir(path.resolve(process.cwd(), 'public'));

// 渲染机上装有 Chrome 时直接复用，避免首次渲染联网下载 headless shell。
if (process.env.REMOTION_CHROME) {
  Config.setBrowserExecutable(process.env.REMOTION_CHROME);
}

Config.overrideWebpackConfig(webpackOverride);
