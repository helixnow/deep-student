import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { BootShell } from '../../../src/boot/BootShell';

/**
 * 启动面（boot surface）契约。
 *
 * 启动过程只允许有一个视觉面：index.html 的静态占位符 → React 首帧 → 应用。
 * 两处必须共用同一份样式与同一套类名，交接处才没有可见跳变；启动面本身是静态的
 * （无文案 / 无 spinner / 无进度），安全检查一类过程旁白只属于失败路径。
 *
 * 这三条都会被静默退化：有人给 BootShell 加一句「正在启动…」、有人把 boot 样式
 * 复制回 index.html 内联<style>、有人重新引入一个启动期 loading 卡片——都会重现
 * 「一闪而过的安全检查」或两帧之间的白/暗跳变。
 */
const readRepoFile = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

/**
 * 归一化成「标签 + 排序后的属性 + 子节点」结构，忽略空白与属性书写顺序差异。
 * 交接处要求的是同一棵树，不是同一段字符串——HTML 里为了可读性换行缩进，
 * React 渲染则是紧凑输出。
 */
type NormalizedNode = {
  tag: string;
  attrs: Record<string, string>;
  children: NormalizedNode[];
};

const normalizeNode = (node: Element): NormalizedNode => ({
  tag: node.tagName.toLowerCase(),
  attrs: Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b))),
  children: [...node.children].map(normalizeNode),
});

const INDEX_HTML = 'index.html';
const BOOT_CSS = 'public/boot.css';
const BOOT_SHELL = 'src/boot/BootShell.tsx';
const MAIN_TSX = 'src/main.tsx';

describe('boot surface contract', () => {
  it('loads the boot stylesheet render-blocking from index.html', () => {
    const html = readRepoFile(INDEX_HTML);
    expect(html).toContain('<link rel="stylesheet" href="/boot.css" />');
    expect(existsSync(resolve(process.cwd(), BOOT_CSS))).toBe(true);
  });

  it('keeps the boot styles single-sourced in public/boot.css', () => {
    // 样式只有一份：index.html 内联 <style> 与 BootShell 各自的 CSS 都会让两帧漂移。
    const html = readRepoFile(INDEX_HTML);
    expect(html).not.toMatch(/<style>[\s\S]*boot-loading/);
    expect(readRepoFile(BOOT_CSS)).toContain('.boot-loading__logo--shine');
  });

  it('renders the same DOM tree from React as the static placeholder', () => {
    const dom = new JSDOM(readRepoFile(INDEX_HTML));
    const placeholder = dom.window.document.querySelector('.boot-loading');
    expect(placeholder, 'index.html should keep a static boot placeholder').not.toBeNull();
    // 占位符标记只属于静态 HTML：React 接管后 #root 里不应再出现它
    // （scripts/ci/check-frontend-startup.mjs 以此判定首帧已完成）。
    placeholder!.removeAttribute('data-dstu-react-placeholder');

    const rendered = new JSDOM(`<div id="r">${renderToStaticMarkup(createElement(BootShell))}</div>`);
    expect(normalizeNode(rendered.window.document.getElementById('r')!.firstElementChild!))
      .toEqual(normalizeNode(placeholder!));
  });

  it('keeps the boot surface free of copy, spinners and i18n', () => {
    const shell = readRepoFile(BOOT_SHELL);
    expect(shell).not.toMatch(/useTranslation/);
    expect(shell).not.toMatch(/animate-spin/);
    expect(shell).not.toMatch(/animate-pulse/);
    // 启动面只有 img + 布局容器，不允许出现任何可见文字节点
    expect(shell).not.toMatch(/>[^<>\s][^<>]*</);
  });

  it('hands the first React frame to the boot surface, not a startup gate card', () => {
    const main = readRepoFile(MAIN_TSX);
    expect(main).toContain('root.render(<BootShell />);');
    // 组件与其 import 都不能回来；`StartupPreflightFailure` 这类调试场景名 /
    // ErrorBoundary 名是失败路径的身份标识，与被删除的卡片无关。
    expect(main).not.toContain('<StartupPreflight');
    expect(main).not.toMatch(/from '\.\/features\/data-recovery\/StartupPreflight'/);
    // 安全检查仍然存在，但只在需要用户介入的失败路径上出现。
    expect(main).toContain('recoveryTree(status)');
    expect(main).toContain('<ComponentRecoveryShell components={componentHealth} />');
  });

  it('keeps the startup gate IPCs concurrent instead of serialized', () => {
    const main = readRepoFile(MAIN_TSX);
    const gateIndex = main.indexOf('const maintenanceStatusPromise');
    expect(gateIndex).toBeGreaterThan(-1);
    // 维护状态必须在等待预检结果之前就已发起（否则首帧前白等第二个 IPC）。
    expect(gateIndex).toBeLessThan(main.indexOf('void getStartupRecoveryStatusWithTimeout()'));
    expect(main).toContain('await maintenanceStatusPromise');
  });

  it('orphans no locale key for the removed preflight card', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const data = readRepoFile(`src/locales/${locale}/data.json`);
      expect(data).not.toContain('"preflight_title"');
      expect(data).not.toContain('"preflight_description"');
      // 失败路径的文案必须仍在
      expect(data).toContain('"preflight_failed_title"');
    }
  });
});