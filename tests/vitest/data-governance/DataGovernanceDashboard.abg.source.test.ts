import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  resolve(process.cwd(), 'src/features/settings/components/DataGovernanceDashboard.tsx'),
  'utf-8',
);

describe('DataGovernanceDashboard A+B+G coexistence contract', () => {
  it('keeps A accessible tab names and the DEV-only debug gate', () => {
    const tabTriggers = dashboardSource.match(/<TabsTrigger[\s\S]*?<\/TabsTrigger>/g) ?? [];

    expect(tabTriggers).toHaveLength(8);
    for (const trigger of tabTriggers) {
      expect(trigger).toContain('aria-label=');
    }
    expect(dashboardSource).toContain(
      'const isDebugTabEnabled = (): boolean => import.meta.env.DEV;',
    );
    expect(dashboardSource).toContain('{debugTabEnabled && (');
    expect(dashboardSource).toContain(
      "if (tabTarget.tab === 'debug' && !debugTabEnabled) return;",
    );
  });

  it('keeps B E2EE ZIP password wiring on the current #177 API', () => {
    const handlerStart = dashboardSource.indexOf('const backupAndExportZip = useCallback');
    const handlerEnd = dashboardSource.indexOf('// 取消备份', handlerStart);
    const handlerSource = dashboardSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource).toContain('encryptionPassword?: string;');
    expect(handlerSource).toContain('DataGovernanceApi.backupAndExportZip(');
    expect(handlerSource).toContain('options.encryptionPassword,');
    expect(dashboardSource).toContain('onBackupAndExportZip={backupAndExportZip}');
  });

  it('keeps G 44px tab targets without dropping A or B', () => {
    const tabTriggers = dashboardSource.match(/<TabsTrigger[\s\S]*?<\/TabsTrigger>/g) ?? [];

    for (const trigger of tabTriggers) {
      expect(trigger).toContain('min-h-11 min-w-11');
      expect(trigger).toContain('[@media(pointer:coarse)]:!min-h-11');
      expect(trigger).toContain('[@media(pointer:coarse)]:!min-w-11');
    }
    expect(dashboardSource).toContain("aria-label={t('data:governance.tabs_nav_label')}");
    expect(dashboardSource).toContain('options.encryptionPassword,');
  });
});
