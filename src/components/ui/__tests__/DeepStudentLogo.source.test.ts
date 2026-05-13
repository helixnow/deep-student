import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => {
  const absolutePath = resolve(process.cwd(), file);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

describe('DeepStudent about logo token contract', () => {
  const aboutTabSource = readSource('src/features/settings/components/AboutTab.tsx');
  const logoSource = readSource('src/components/ui/DeepStudentLogo.tsx');

  it('uses the DeepStudent SVG wordmark in the About tab instead of the generic image asset', () => {
    expect(aboutTabSource).toContain("import { DeepStudentLogo } from '../ui/DeepStudentLogo';");
    expect(aboutTabSource).toContain('<DeepStudentLogo');
    expect(aboutTabSource).toContain('w-44');
    expect(aboutTabSource).toContain('max-w-full');
    expect(aboutTabSource).not.toContain('src="/logo.svg"');
  });

  it('maps the DeepStudent.svg fills onto semantic tokens so dark mode follows the theme', () => {
    expect(logoSource).toContain('viewBox="0 0 409 147"');
    expect(logoSource).toContain('role="img"');
    expect(logoSource).toContain('fill-background');
    expect(logoSource).toContain('fill-foreground');
    expect(logoSource).not.toMatch(/fill="(?:#101820|white)"/u);
  });
});
