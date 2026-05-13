import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('vendor API settings icon source contract', () => {
  it('uses Phosphor icons for vendor field labels in the API settings panel', () => {
    const source = readSource('src/features/settings/components/ApisTab.tsx');

    expect(source).toContain("} from '@phosphor-icons/react';");
    expect(source).not.toContain("from 'lucide-react'");
    expect(source).toContain('<LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />');
    expect(source).toContain('<Key className="h-3.5 w-3.5" aria-hidden="true" />');
    expect(source).toContain('<NotePencil className="h-3.5 w-3.5" aria-hidden="true" />');
  });

  it('uses Phosphor icons for vendor field labels in the vendor config modal', () => {
    const source = readSource('src/features/settings/components/VendorConfigModal.tsx');

    expect(source).toContain("} from '@phosphor-icons/react';");
    expect(source).toContain('<LinkSimple className="h-3.5 w-3.5" aria-hidden="true" />');
    expect(source).toContain('<Key className="h-3.5 w-3.5" aria-hidden="true" />');
    expect(source).toContain('<NotePencil className="h-3.5 w-3.5" aria-hidden="true" />');
  });

  it('uses Phosphor icons for model fetching controls and model counts', () => {
    const genericFetcher = readSource('src/features/settings/components/VendorModelFetcher.tsx');
    const siliconFlowSection = readSource('src/features/settings/components/SiliconFlowSection.tsx');

    expect(genericFetcher).toContain("} from '@phosphor-icons/react';");
    expect(genericFetcher).not.toContain("from 'lucide-react'");
    expect(genericFetcher).toContain('<Stack className="h-3.5 w-3.5" aria-hidden="true" />');

    expect(siliconFlowSection).toContain("} from '@phosphor-icons/react';");
    expect(siliconFlowSection).not.toContain("from 'lucide-react'");
    expect(siliconFlowSection).toContain('<Stack className="h-3.5 w-3.5" aria-hidden="true" />');
  });

  it('uses Phosphor icons for vendor API key actions', () => {
    const source = readSource('src/features/settings/components/VendorApiKeySection.tsx');

    expect(source).toContain("} from '@phosphor-icons/react';");
    expect(source).not.toContain("from 'lucide-react'");
    expect(source).toContain('<Trash className="h-3.5 w-3.5" />');
  });
});
