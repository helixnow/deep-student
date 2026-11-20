import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DataGovernanceDashboard tab icon source contract', () => {
  it('uses Phosphor icons for the data governance tab row', () => {
    const dashboardSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/DataGovernanceDashboard.tsx'),
      'utf-8'
    );

    expect(dashboardSource).toContain("} from '@phosphor-icons/react';");
    expect(dashboardSource).toContain('<Gauge className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<Archive className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<HardDrive className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<Cloud className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<FileText className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<Image className="h-3.5 w-3.5 shrink-0" />');
    expect(dashboardSource).toContain('<Bug className="h-3.5 w-3.5 shrink-0" />');
  });
});
