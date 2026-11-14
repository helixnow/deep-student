/**
 * vfs entries: `portable.ts` carries the whole public type surface plus every value whose runtime closure loads no
 * Node module; `api.ts` re-exports it unchanged. Local file access goes through `src/local-runtime.ts`, whose
 * default port has no local filesystem, so the command implementations are portable as well.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as api from '../api.ts';
import * as portable from '../portable.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('vfs entries', () => {
  it('portable.ts loads no Node module at runtime', () => {
    expect(checkModulesClosure(ROOT, ['host/plugins/vfs/portable.ts'])).toEqual([]);
  });

  it('api.ts re-exports every portable.ts value unchanged and adds no Node-dependent runtime value', () => {
    for (const [name, value] of Object.entries(portable)) expect((api as Record<string, unknown>)[name], name).toBe(value);
    expect(Object.keys(api).filter((name) => !(name in portable))).toEqual([]);
  });
});
