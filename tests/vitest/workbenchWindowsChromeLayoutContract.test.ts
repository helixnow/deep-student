import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbench Windows chrome layout contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');
  const statusBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/workbench/components/StatusBar.tsx'),
    'utf-8',
  );
  const statusBarCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/workbench/components/StatusBar.css'),
    'utf-8',
  );
  const tokensSource = readFileSync(
    resolve(process.cwd(), 'src/features/workbench/styles/workbench.tokens.css'),
    'utf-8',
  );

  it('inlines the Windows window controls at the trailing end of the menubar', () => {
    // Windows 三键已融入 wb-menubar 最右端（data-chrome-inset='windows'），
    // 不再有共享 chrome 宽度 token，也没有 App 层的 chrome host 占位元素
    expect(statusBarSource).toContain("data-chrome-inset={winChromeInset ? 'windows' : undefined}");
    expect(statusBarSource).toContain('className="wb-menubar-window-controls"');
    expect(statusBarSource).toContain('<WindowControls />');
    expect(statusBarCssSource).toMatch(
      /\.wb-menubar\[data-chrome-inset='windows'\]\s*\{[\s\S]*?padding-right:\s*6px;/,
    );
    expect(statusBarCssSource).toMatch(
      /\.wb-menubar\[data-chrome-inset='windows'\] \.wb-menubar-drag-region\s*\{[\s\S]*?inset:\s*0;/,
    );
    expect(tokensSource).not.toContain('--wb-windows-chrome-width');
    expect(appSource).not.toContain('desktop-shell-workbench-chrome-host');
    expect(appCssSource).not.toContain('.desktop-shell-workbench-chrome-host');
  });

  it('keeps the trailing shortcuts from shrinking back underneath Windows controls', () => {
    expect(statusBarCssSource).toMatch(
      /\.wb-menubar\[data-chrome-inset='windows'\] \.wb-menubar-trailing\s*\{[\s\S]*?flex-shrink:\s*0;/,
    );
  });

  it('keeps the macOS integrated chrome rule independent from the Windows inset', () => {
    // 结束锚点用行首的独立 .wb-menubar-drag-region 规则（前缀 \n），
    // 避免命中 Windows 块里的 `[data-chrome-inset='windows'] .wb-menubar-drag-region`
    const macRuleStart = statusBarCssSource.indexOf(".wb-menubar[data-macos-chrome='integrated']");
    const macRuleEnd = statusBarCssSource.indexOf('\n.wb-menubar-drag-region {', macRuleStart);
    expect(macRuleStart).toBeGreaterThanOrEqual(0);
    expect(macRuleEnd).toBeGreaterThan(macRuleStart);
    const macRule = statusBarCssSource.slice(macRuleStart, macRuleEnd);

    // fallback 与 workbench.tokens.css 的 --wb-macos-traffic-lights-inset: 72px 同值
    expect(macRule).toContain('padding-left: var(--wb-macos-traffic-lights-inset, 72px);');
    expect(macRule).not.toContain('--wb-menubar-chrome-inset');
  });
});
