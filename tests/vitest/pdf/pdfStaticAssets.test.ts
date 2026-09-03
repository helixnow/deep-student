/**
 * pdfjs 静态资产配置守卫（WI-9）：
 *  - worker 只有一份权威来源（node_modules/pdfjs-dist/build，经 viteStaticCopy），
 *    public/ 不允许再出现手工同步的 worker 副本（WI-5 曾清理过一次）；
 *  - R2 wasm 裁剪不回退：拷贝 glob 永远匹配不到 openjpeg_nowasm_fallback.js；
 *  - cmaps 白名单（config/pdfjs-local-assets.json）持续覆盖简中核心 +
 *    ToUnicode 依赖，且与 vite.config.ts 消费同一清单。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const pdfjsDistDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

const viteConfigSource = fs.readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8');
const { keptCMapGlobs } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'pdfjs-local-assets.json'), 'utf8'),
) as { keptCMapGlobs: string[] };

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

describe('pdf worker 单一权威来源', () => {
  it('public/ 无 worker 副本，wrapper 仍是入口', () => {
    const publicEntries = fs.readdirSync(path.join(repoRoot, 'public'));
    expect(publicEntries.filter((name) => /^pdf\.worker\.min\./.test(name))).toEqual([]);
    const wrapper = fs.readFileSync(path.join(repoRoot, 'public', 'pdf.worker.wrapper.mjs'), 'utf8');
    expect(wrapper).toContain("import './pdf.worker.min.mjs'");
  });

  it('vite.config 从 node_modules/pdfjs-dist/build 拷贝 worker，且源文件存在', () => {
    expect(viteConfigSource).toMatch(/'build',\s*'pdf\.worker\.min\.mjs'/);
    expect(fs.existsSync(path.join(pdfjsDistDir, 'build', 'pdf.worker.min.mjs'))).toBe(true);
  });

  it('workerSrc 只在 EnhancedPdfViewer 设置一次，指向 wrapper', () => {
    const viewer = fs.readFileSync(
      path.join(repoRoot, 'src', 'features', 'pdf', 'components', 'EnhancedPdfViewer.tsx'),
      'utf8',
    );
    expect(viewer).toContain('pdf.worker.wrapper.mjs');
    // src 下不允许出现第二处 workerSrc 赋值（测试 mock 除外）
    const srcDir = path.join(repoRoot, 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
          const content = fs.readFileSync(entryPath, 'utf8');
          if (/GlobalWorkerOptions\.workerSrc\s*=/.test(content)) offenders.push(entryPath);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([
      path.join(srcDir, 'features', 'pdf', 'components', 'EnhancedPdfViewer.tsx'),
    ]);
  });
});

describe('R2 wasm fallback 裁剪不回退', () => {
  it('wasm 拷贝用 *.wasm + LICENSE* glob，匹配不到 452KB 的 JS fallback', () => {
    expect(viteConfigSource).toMatch(/\$\{wasmDir\}\/\*\.wasm/);
    expect(viteConfigSource).toMatch(/\$\{wasmDir\}\/LICENSE\*/);
    // 不允许恢复整目录拷贝 { src: wasmDir, dest: '' }
    expect(viteConfigSource).not.toMatch(/src:\s*wasmDir\s*[,}]/);
    for (const glob of ['*.wasm', 'LICENSE*']) {
      expect(globToRegExp(glob).test('openjpeg_nowasm_fallback.js')).toBe(false);
    }
  });

  it('保留的 wasm 源文件仍然存在（openjpeg + qcms）', () => {
    const wasmDir = path.join(pdfjsDistDir, 'wasm');
    const wasmFiles = fs.readdirSync(wasmDir).filter((name) => name.endsWith('.wasm'));
    expect(wasmFiles).toEqual(expect.arrayContaining(['openjpeg.wasm', 'qcms_bg.wasm']));
  });
});

describe('cmaps 本地子集清单', () => {
  it('vite.config 消费 config/pdfjs-local-assets.json（单一清单来源）', () => {
    expect(viteConfigSource).toContain('pdfjs-local-assets.json');
    expect(viteConfigSource).not.toMatch(/keptCMapGlobs\s*=\s*\[/);
  });

  it('白名单覆盖简中 GB 全系与各 registry 的 ToUnicode 依赖', () => {
    const patterns = keptCMapGlobs.map(globToRegExp);
    const mustKeep = [
      'UniGB-UCS2-H',
      'UniGB-UTF16-H',
      'GBK-EUC-H',
      'Adobe-GB1-UCS2',
      'Adobe-CNS1-UCS2',
      'Adobe-Japan1-UCS2',
      'Adobe-Korea1-UCS2',
      'UniCNS-UCS2-H',
      'UniJIS-UCS2-H',
      'UniKS-UCS2-H',
    ];
    for (const name of mustKeep) {
      expect(patterns.some((pattern) => pattern.test(name)), `${name} 应在本地子集内`).toBe(true);
      expect(fs.existsSync(path.join(pdfjsDistDir, 'cmaps', `${name}.bcmap`)), `${name}.bcmap 源文件应存在`).toBe(
        true,
      );
    }
    // R2 裁掉的遗留编码不应悄悄回到白名单（体积回归守卫）
    for (const trimmed of ['90ms-RKSJ-H', 'KSC-EUC-H', 'B5pc-H', 'ETen-B5-H']) {
      expect(patterns.some((pattern) => pattern.test(trimmed)), `${trimmed} 应保持在子集外（走运行时 fallback）`).toBe(
        false,
      );
    }
  });
});
