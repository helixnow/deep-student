import { describe, expect, it } from 'vitest';

import { learningResourceSkill } from '../builtin-tools/learning-resource';
import { knowledgeRetrievalSkill } from '../builtin-tools/knowledge-retrieval';
import { BUILTIN_NAMESPACE, BUILTIN_TOOLS } from '../../../mcp/builtinMcpServer';

const REQUIRED_TYPES = ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'] as const;

function getBuiltinTool(name: string) {
  return BUILTIN_TOOLS.find(t => t.name === `${BUILTIN_NAMESPACE}${name}`);
}

describe('resource tool contract consistency', () => {
  it('learning-resource list/search schemas expose full resource type set', () => {
    const listTool = learningResourceSkill.embeddedTools.find(t => t.name === 'builtin-resource_list');
    const searchTool = learningResourceSkill.embeddedTools.find(t => t.name === 'builtin-resource_search');

    const listEnum = (((listTool?.inputSchema as any)?.properties?.type?.enum ?? []) as string[]);
    const searchEnum = ((((searchTool?.inputSchema as any)?.properties?.types?.items?.enum ?? []) as string[]));

    expect(listEnum).toEqual(expect.arrayContaining([...REQUIRED_TYPES, 'all']));
    expect(searchEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
  });

  it('unified search resource_types schema keeps parity with backend supported types', () => {
    const unifiedTool = knowledgeRetrievalSkill.embeddedTools.find(t => t.name === 'builtin-unified_search');
    const unifiedEnum = ((((unifiedTool?.inputSchema as any)?.properties?.resource_types?.items?.enum ?? []) as string[]));
    expect(unifiedEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
  });

  it('deprecated builtin server schemas remain aligned for resource tools', () => {
    const listEnum = (((getBuiltinTool('resource_list')?.inputSchema as any)?.properties?.type?.enum ?? []) as string[]);
    const searchEnum = ((((getBuiltinTool('resource_search')?.inputSchema as any)?.properties?.types?.items?.enum ?? []) as string[]));
    const unifiedEnum = ((((getBuiltinTool('unified_search')?.inputSchema as any)?.properties?.resource_types?.items?.enum ?? []) as string[]));

    expect(listEnum).toEqual(expect.arrayContaining([...REQUIRED_TYPES, 'all']));
    expect(searchEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
    expect(unifiedEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
  });
});

