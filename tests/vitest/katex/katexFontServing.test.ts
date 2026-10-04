// @vitest-environment node
/**
 * KaTeX 字体可达性守卫。
 *
 * KaTeX 用 KaTeX_Main 私有区字形 U+E020 叠在 "=" 上画 \neq / \not=。字体文件一旦
 * 加载失败，整段公式退回 Times New Roman，U+E020 变成方框（"F′(x) ⊟0"）。
 * 2026-10 复现：worktree 把 node_modules 软链到主仓库时，Vite dev server 把字体 URL
 * 解析成 /@fs/<主仓库>/node_modules/katex/dist/fonts/…，不在 server.fs.allow 里 → 403。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import katex from 'katex';
import { isFileLoadingAllowed, resolveConfig } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveDevServerFsAllow } from '../../../vite.config';

const repoRoot = process.cwd();
const require = createRequire(path.join(repoRoot, 'package.json'));

/** 应用本体的 katex 与 Crepe（笔记编辑器）自带的 katex 各有一套 CSS + 字体。 */
function katexDistDirs(): string[] {
  const appKatex = path.dirname(require.resolve('katex/package.json'));
  const crepeRequire = createRequire(path.join(repoRoot, 'node_modules/@milkdown/crepe/package.json'));
  const crepeKatex = path.dirname(crepeRequire.resolve('katex/package.json'));
  return [...new Set([appKatex, crepeKatex])].map((dir) => path.join(dir, 'dist'));
}

/** katex.min.css 中 KaTeX_Main / KaTeX_AMS 的 @font-face 字体文件真实路径（Vite 解析软链后即请求此路径）。 */
function fontFilesFor(distDir: string): string[] {
  const css = fs.readFileSync(path.join(distDir, 'katex.min.css'), 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)]
    .map((m) => m[1].replace(/["']/g, ''))
    .filter((u) => /KaTeX_(Main|AMS)-Regular/.test(u));
  return urls.map((u) => fs.realpathSync(path.join(distDir, u)));
}

describe('KaTeX \\neq 依赖 KaTeX_Main 字体', () => {
  it("F'(x) \\neq 0 的 HTML 用 U+E020 叠加，字体链以 KaTeX_Main 打头", () => {
    const html = katex.renderToString("F'(x) \\neq 0", { throwOnError: false });
    expect(html).toContain('');
    const appCss = fs.readFileSync(path.join(repoRoot, 'src/shared/styles/app.css'), 'utf8');
    const rule = appCss.match(/\n\.katex\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/font-family:\s*KaTeX_Main\b/);
  });

  it('两套 katex.min.css 的 KaTeX_Main/AMS 字体文件真实存在', () => {
    for (const dir of katexDistDirs()) {
      const files = fontFilesFor(dir);
      expect(files.length).toBeGreaterThanOrEqual(6);
      for (const file of files) expect(fs.existsSync(file)).toBe(true);
    }
  });
});

describe('dev server 能 serve KaTeX 字体', () => {
  it('真实 vite.config 的 server.fs 放行全部 KaTeX_Main/AMS 字体', async () => {
    const config = await resolveConfig(
      { configFile: path.join(repoRoot, 'vite.config.ts'), logLevel: 'silent' },
      'serve',
    );
    for (const dir of katexDistDirs()) {
      for (const file of fontFilesFor(dir)) {
        expect(isFileLoadingAllowed(config, file), file).toBe(true);
      }
    }
  }, 60_000);

  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('node_modules 软链到工作区外时，白名单包含其真实路径', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fs-allow-')));
    tmpRoots.push(base);
    const checkout = path.join(base, 'checkout');
    const shared = path.join(base, 'shared', 'node_modules');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(path.join(shared, 'katex', 'dist', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"name":"probe"}');
    fs.symlinkSync(shared, path.join(checkout, 'node_modules'), 'dir');

    const allow = resolveDevServerFsAllow(checkout);
    expect(allow).toContain(checkout);
    expect(allow).toContain(shared);
  });

  it('没有 node_modules 时只保留工作区根', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fs-allow-')));
    tmpRoots.push(base);
    fs.writeFileSync(path.join(base, 'package.json'), '{"name":"probe"}');
    expect(resolveDevServerFsAllow(base)).toEqual([base]);
  });
});
