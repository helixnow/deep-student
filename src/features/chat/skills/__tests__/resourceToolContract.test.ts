import { describe, expect, it } from 'vitest';

import { learningResourceSkill } from '../builtin-tools/learning-resource';
import { knowledgeRetrievalSkill } from '../builtin-tools/knowledge-retrieval';
import {
  BUILTIN_NAMESPACE,
  getBuiltinToolsWithDynamicSchema,
} from '@/mcp/builtinMcpServer';

const REQUIRED_TYPES = ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'] as const;

// 🔧 2026-07: 废弃的静态 BUILTIN_TOOLS 数组已删除；
// 本测试现在校验从 Skills SSOT 动态派生的服务器 Schema。
const derivedTools = getBuiltinToolsWithDynamicSchema();

function getDerivedTool(name: string) {
  return derivedTools.find(t => t.name === `${BUILTIN_NAMESPACE}${name}`);
}

describe('resource tool contract consistency', () => {
  it('resource_read schema exposes UTF-8 byte paging and expected_hash', () => {
    const tool = learningResourceSkill.embeddedTools.find((t) => t.name === 'builtin-resource_read');
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: {
        offset?: { type?: string; minimum?: number; default?: number };
        max_bytes?: { type?: string; minimum?: number; maximum?: number };
        expected_hash?: { type?: string };
        page_start?: { type?: string };
        page_end?: { type?: string };
      };
    };
    expect(schema.required).toEqual(['resource_id']);
    expect(schema.properties?.offset?.minimum).toBe(0);
    expect(schema.properties?.offset?.default).toBe(0);
    expect(schema.properties?.max_bytes?.minimum).toBe(1);
    expect(schema.properties?.max_bytes?.maximum).toBe(1048576);
    expect(schema.properties?.expected_hash?.type).toBe('string');
    expect(schema.properties?.page_start).toBeDefined();
    expect(schema.properties?.page_end).toBeDefined();
    expect(tool?.description).toContain('next_offset');
    expect(tool?.description).toContain('sha256');
    expect(learningResourceSkill.content).toContain('next_offset');
  });

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

  it('skills-derived builtin server schemas remain aligned for resource tools', () => {
    const listEnum = (((getDerivedTool('resource_list')?.inputSchema as any)?.properties?.type?.enum ?? []) as string[]);
    const searchEnum = ((((getDerivedTool('resource_search')?.inputSchema as any)?.properties?.types?.items?.enum ?? []) as string[]));
    const unifiedEnum = ((((getDerivedTool('unified_search')?.inputSchema as any)?.properties?.resource_types?.items?.enum ?? []) as string[]));

    expect(listEnum).toEqual(expect.arrayContaining([...REQUIRED_TYPES, 'all']));
    expect(searchEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
    expect(unifiedEnum).toEqual(expect.arrayContaining(REQUIRED_TYPES));
  });

  it('deprecated standalone retrieval tools are not exposed by the derived server schema', () => {
    // rag_search / multimodal_search 已收敛进 unified_search，
    // 动态派生的工具列表不应再暴露独立条目。
    expect(getDerivedTool('rag_search')).toBeUndefined();
    expect(getDerivedTool('multimodal_search')).toBeUndefined();
    expect(getDerivedTool('unified_search')).toBeDefined();
  });

  it('unified_search schema top_k stays aligned with the documented cap of 30', () => {
    const topK = (getDerivedTool('unified_search')?.inputSchema as any)?.properties?.top_k;
    expect(topK?.maximum).toBe(30);
    expect(topK?.minimum).toBe(1);
  });
});
