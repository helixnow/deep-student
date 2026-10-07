/**
 * 英文界面里「学习桌面」统一叫 Study Desktop（与 README / 官网口径一致），
 * 曾同时出现 Learning Desktop menu / Study Desktop menu / Quit Learning Desktop。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'src/locales/en-US');

describe('en-US naming of the study desktop', () => {
  it('never says "Learning Desktop"', () => {
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => /learning desktop/i.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('uses Study Desktop for the brand menu and quit item', () => {
    const wb = JSON.parse(readFileSync(path.join(dir, 'workbench.json'), 'utf8'));
    const flat = JSON.stringify(wb);
    expect(flat).toContain('"brandMenu":"Study Desktop menu"');
    expect(flat).toContain('"brandExit":"Quit Study Desktop"');
  });
});
