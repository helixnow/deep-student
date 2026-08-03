import { afterEach, describe, expect, it } from 'vitest';

import { contextTypeRegistry } from '../context/registry';
import { collectSchemaToolIds } from './collector';

const TEST_TYPE_ID = 'collector-no-skill-allowlist-test';

afterEach(() => {
  contextTypeRegistry.unregister(TEST_TYPE_ID);
});

describe('collectSchemaToolIds', () => {
  it('collects context tools without applying a skill allowlist', () => {
    contextTypeRegistry.register({
      typeId: TEST_TYPE_ID,
      xmlTag: 'collector_test',
      label: 'Collector test',
      labelEn: 'Collector test',
      tools: ['builtin-note_read', 'mcp_external_lookup'],
      formatToBlocks: () => [],
    });

    const result = collectSchemaToolIds({
      pendingContextRefs: [{
        resourceId: 'res-test',
        hash: 'hash-test',
        typeId: TEST_TYPE_ID,
      }],
    });

    expect(result.schemaToolIds).toEqual([
      'builtin-note_read',
      'mcp_external_lookup',
    ]);
  });
});
