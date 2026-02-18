#!/usr/bin/env node
/**
 * 生成 Tauri 自动更新清单文件 (latest.json)
 *
 * 用法:
 *   node scripts/generate-update-manifest.mjs
 *
 * 环境变量:
 *   GITHUB_REPO       - GitHub 仓库 (默认: helixnow/deep-student)
 *   BUILD_TARGET       - 构建目标平台，逗号分隔 (默认: 自动检测已有产物)
 *   OUTPUT_DIR         - latest.json 输出目录 (默认: 项目根目录)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const GITHUB_REPO = process.env.GITHUB_REPO || 'helixnow/deep-student';

// 读取版本号
const tauriConfigPath = join(projectRoot, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf-8'));
const version = tauriConfig.version;

// 产物搜索路径映射
const PLATFORM_MAP = {
  'darwin-aarch64': {
    targetDir: 'aarch64-apple-darwin',
    bundleSubdir: 'macos',
    ext: '.app.tar.gz',
  },
  'darwin-x86_64': {
    targetDir: 'x86_64-apple-darwin',
    bundleSubdir: 'macos',
    ext: '.app.tar.gz',
  },
  'darwin-universal': {
    targetDir: 'universal-apple-darwin',
    bundleSubdir: 'macos',
    ext: '.app.tar.gz',
  },
  'windows-x86_64': {
    targetDir: 'x86_64-pc-windows-msvc',
    bundleSubdir: 'nsis',
    ext: '-setup.exe',
  },
  'linux-x86_64': {
    targetDir: 'x86_64-unknown-linux-gnu',
    bundleSubdir: 'appimage',
    ext: '.AppImage.tar.gz',
  },
};

/**
 * 在构建产物目录中查找更新包和签名文件
 */
function findArtifacts(platformKey, platformInfo) {
  const targetBase = join(projectRoot, 'src-tauri', 'target');
  const bundlePath = join(targetBase, platformInfo.targetDir, 'release', 'bundle', platformInfo.bundleSubdir);

  if (!existsSync(bundlePath)) return null;

  const files = readdirSync(bundlePath);

  // 查找更新包 (tar.gz 或 zip)
  const artifactFile = files.find(f => f.endsWith(platformInfo.ext));
  if (!artifactFile) return null;

  // 查找签名文件
  const sigFile = files.find(f => f === artifactFile + '.sig');
  if (!sigFile) {
    console.warn(`  [warn] ${platformKey}: 找到更新包但缺少签名文件 (.sig)`);
    console.warn(`         请确保构建时设置了 TAURI_SIGNING_PRIVATE_KEY 环境变量`);
    return null;
  }

  const signature = readFileSync(join(bundlePath, sigFile), 'utf-8').trim();
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${artifactFile}`;

  return { url: downloadUrl, signature };
}

/**
 * macOS 通用二进制需要映射到两个平台标识
 */
function resolveUniversalMac(platforms) {
  if (platforms['darwin-universal']) {
    // 通用二进制同时服务 aarch64 和 x86_64
    if (!platforms['darwin-aarch64']) {
      platforms['darwin-aarch64'] = { ...platforms['darwin-universal'] };
    }
    if (!platforms['darwin-x86_64']) {
      platforms['darwin-x86_64'] = { ...platforms['darwin-universal'] };
    }
    delete platforms['darwin-universal'];
  }
}

// 主逻辑
console.log(`🔍 正在为 v${version} 生成更新清单...`);

const platforms = {};

for (const [key, info] of Object.entries(PLATFORM_MAP)) {
  const result = findArtifacts(key, info);
  if (result) {
    platforms[key] = result;
    console.log(`  ✅ ${key}: ${result.url}`);
  }
}

resolveUniversalMac(platforms);

if (Object.keys(platforms).length === 0) {
  console.error('❌ 未找到任何平台的更新产物。');
  console.error('   请先运行构建命令，并确保设置了签名环境变量：');
  console.error('   export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/deep-student.key');
  console.error('   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="你的密码"');
  process.exit(1);
}

const manifest = {
  version,
  notes: `Deep Student v${version} 更新`,
  pub_date: new Date().toISOString(),
  platforms,
};

const outputDir = process.env.OUTPUT_DIR || projectRoot;
const outputPath = join(outputDir, 'latest.json');
writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

console.log(`\n✅ 更新清单已生成: ${outputPath}`);
console.log(`   版本: v${version}`);
console.log(`   平台: ${Object.keys(platforms).join(', ')}`);
console.log(`\n📋 下一步: 将 latest.json 和更新包上传到 GitHub Release v${version}`);
