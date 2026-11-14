import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { DataSpaceStartup } from '../startup.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('a legacy data dir under a non-ASCII path migrates non-ASCII entries into slotA byte-for-byte and adopts the key', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-非ASCII-'));
  roots.push(parent);
  const base = path.join(parent, '学习 数据', 'Élève ü 📚');
  fs.mkdirSync(path.join(base, '图片 资源'), { recursive: true });
  fs.writeFileSync(path.join(base, 'mistakes.db'), 'db');
  fs.writeFileSync(path.join(base, '笔记 é.md'), '内容');
  fs.writeFileSync(path.join(base, '图片 资源', '图 1.png'), 'png');
  const key = randomBytes(32).toString('base64');

  const startup = new DataSpaceStartup(base, { recover: async () => {} } as never);
  await startup.start();
  expect(startup.status()).toMatchObject({ recovery_required: false });

  const slotA = startup.activeDir();
  expect(slotA).toBe(path.join(base, 'slots', 'slotA'));
  expect(fs.readdirSync(slotA).sort()).toEqual(['mistakes.db', '图片 资源', '笔记 é.md'].sort());
  expect(fs.readFileSync(path.join(slotA, '笔记 é.md'), 'utf8')).toBe('内容');
  expect(fs.readFileSync(path.join(slotA, '图片 资源', '图 1.png'), 'utf8')).toBe('png');
  expect(JSON.parse(fs.readFileSync(path.join(base, 'slots', 'state.json'), 'utf8'))).toMatchObject({ active: 'slotA' });

  fs.writeFileSync(path.join(slotA, '.master_key'), key);
  await new DataSpaceStartup(base, { recover: async () => {} } as never).start();
  expect(fs.readFileSync(path.join(base, '.master_key'), 'utf8')).toBe(key);
});
