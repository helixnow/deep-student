import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const securityStatusIndicatorSource = readFileSync(
  resolve(process.cwd(), 'src/components/SecurityStatusIndicator.tsx'),
  'utf-8'
);

describe('SecurityStatusIndicator refresh button accessibility', () => {
  it('localizes the refresh button aria-label with the same key as its title', () => {
    expect(securityStatusIndicatorSource).toContain(
      "title={t('securityStatus.refresh')} aria-label={t('securityStatus.refresh')}"
    );
  });

  it('does not hardcode an English aria-label on the refresh button', () => {
    expect(securityStatusIndicatorSource).not.toContain('aria-label="refresh"');
  });
});
