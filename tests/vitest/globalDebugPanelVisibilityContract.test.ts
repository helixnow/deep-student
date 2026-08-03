import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GlobalDebugPanel visibility contract', () => {
  const panelSource = readFileSync(
    resolve(process.cwd(), 'src/components/dev/GlobalDebugPanel.tsx'),
    'utf-8',
  );
  const panelHostSource = readFileSync(
    resolve(process.cwd(), 'src/debug-panel/DebugPanelHost.tsx'),
    'utf-8',
  );
  const panelStyles = readFileSync(
    resolve(process.cwd(), 'src/components/dev/GlobalDebugPanel.css'),
    'utf-8',
  );

  it('keeps the owned portal and controls outside generic debug-overlay hiding rules', () => {
    expect(panelSource).toContain("el.id = 'dstu-debugger-toggle-portal';");
    expect(panelSource).toContain("'dstu-dbg-toggle'");
    expect(panelStyles).toContain('.dstu-dbg-toggle');
    expect(panelStyles).not.toContain('.dstu-debug-toggle');
    expect(panelHostSource).toContain('className="dstu-dbg-root fixed"');
    expect(panelHostSource).not.toContain('className="dstu-dbg-root fixed z-debug"');
  });
});
