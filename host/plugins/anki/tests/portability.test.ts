/**
 * anki 的跨插件门面 `api.ts`（review、chatanki、memory 等都从这里取值）在移动端也要能加载：
 * 运行时闭包（`import type` 不计）不得触达 Node 专有依赖。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('anki api.ts portability', () => {
  it('the runtime closure of host/plugins/anki/api.ts is free of Node-specific deps', () => {
    expect(checkModulesClosure(ROOT, ['host/plugins/anki/api.ts'])).toEqual([]);
  });
  it('export values and card generation closures are portable', () => {
    expect(checkModulesClosure(ROOT, [
      'host/plugins/anki/src/apkg-export-model.ts',
      'host/plugins/anki/src/generation-cards-json.ts',
      'host/plugins/anki/src/anki-cards.ts',
      'host/plugins/anki/src/save-cards.ts',
      'host/plugins/anki/src/document-processing.ts',
      'host/plugins/anki/src/enhanced-service.ts',
      'host/plugins/anki/src/streaming-anki-runtime.ts',
      'host/plugins/anki/src/apkg-import-persist.ts',
      'host/plugins/anki/src/serde-json.ts',
    ])).toEqual([]);
  });
});
