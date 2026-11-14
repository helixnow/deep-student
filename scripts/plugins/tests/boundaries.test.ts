import { expect, it } from 'vitest';
import { checkFile } from '../check-boundaries.mjs';

it('keeps platform imports, cross-plugin implementation access and SQL out of application code', () => {
  expect(checkFile('src/plugins/notes/application.ts', `
    import { invoke } from '@tauri-apps/api/core';
    import fs from 'node:fs';
    import { database } from '../qbank/private.js';
    const query = 'UPDATE notes SET title = ?';
  `)).toHaveLength(4);
  expect(checkFile('src/plugin-runtime/host.ts', "import notes from '../plugins/notes/index.js';")).toHaveLength(1);
  expect(checkFile('src/plugins/notes/repository/queries.ts', "export const query = 'SELECT title FROM notes WHERE id = ?';")).toEqual([]);
  expect(checkFile('src/plugins/notes/application.ts', "import type { PluginDefinition } from '../../plugin-runtime/host.js';")).toEqual([]);
  expect(checkFile('src/plugins/notes/repository/queries.ts', "import Database from 'better-sqlite3';")).toHaveLength(1);
});
