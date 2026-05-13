import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OverviewTab icon source contract', () => {
  it('uses Phosphor icons for the overview status surfaces', () => {
    const overviewSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/data-governance/OverviewTab.tsx'),
      'utf-8'
    );

    expect(overviewSource).toContain("} from '@phosphor-icons/react';");
    expect(overviewSource).not.toContain("from 'lucide-react'");
    expect(overviewSource).toContain('<Database className="h-4 w-4" />');
    expect(overviewSource).toContain('<Gauge className="h-4 w-4" />');
    expect(overviewSource).toContain('<CheckCircle className="h-5 w-5 text-emerald-500" />');
    expect(overviewSource).toContain('<HardDrive className="h-4 w-4" />');
    expect(overviewSource).toContain('<ArrowsLeftRight className="h-4 w-4" />');
    expect(overviewSource).toContain('<ArrowClockwise className={`h-3.5 w-3.5 mr-1.5 ${loading ? \'animate-spin\' : \'\'}`} />');
  });
});
