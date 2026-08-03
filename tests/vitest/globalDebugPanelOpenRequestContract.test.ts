import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GlobalDebugPanel open request contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const panelSource = readFileSync(
    resolve(process.cwd(), 'src/components/dev/GlobalDebugPanel.tsx'),
    'utf-8',
  );

  it('keeps pre-mount open requests and forwards them to the lazy panel', () => {
    expect(appSource).toContain("type: 'DSTU_OPEN_DEBUGGER'");
    expect(appSource).toContain("type: 'DEV_TOGGLE_DEBUG_PANEL'");
    expect(appSource).toContain('<LazyGlobalDebugPanel openRequest={debugPanelOpenRequest} />');
    expect(panelSource).toContain('openRequest?: number;');
    expect(panelSource).toContain('if (openRequest > 0)');
  });
});
