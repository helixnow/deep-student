import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../platform/errors/api.ts';
import {
  decodeToolNameFromApi, prepareFrontendMcpToolForLegacyApi, questionParsingRequestBody,
} from '../src/mod_compat.ts';
import { makeConfig } from './support.ts';

function asRecord(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

describe('llm_manager/mod.rs', () => {
  it('question_parsing_payload_uses_configured_output_budget', () => {
    const configured = makeConfig({
      maxOutputTokens: 65_536,
      maxTokensLimit: null,
    });
    const parsed = questionParsingRequestBody(configured, 'parse this');
    expect(parsed.max_tokens).toBe(65_536);

    const limited = makeConfig({
      maxOutputTokens: 40_000,
      maxTokensLimit: 24_000,
    });
    const limitedBody = questionParsingRequestBody(limited, 'parse this');
    expect(limitedBody.max_tokens).toBe(24_000);

    const small = makeConfig({
      maxOutputTokens: 1_024,
      maxTokensLimit: null,
    });
    const smallBody = questionParsingRequestBody(small, 'parse this');
    expect(smallBody.max_tokens).toBe(1_024);
  });

  it('prepare_frontend_mcp_tool_for_legacy_api_encodes_invalid_names_with_namespace_prefix', () => {
    const tool = {
      name: 'fetch:url',
      description: 'Fetch URL',
      inputSchema: { type: 'object' },
    };

    const prepared = prepareFrontendMcpToolForLegacyApi(tool, 'mcp.tools.');
    expect(prepared).not.toBeNull();
    if (prepared === null) throw new Error('tool should prepare');

    expect(prepared.bridgeName).toBe('fetch:url');
    expect(prepared.internalToolName).toBe('fetch:url');
    expect(decodeToolNameFromApi(prepared.apiName)).toBe('mcp.tools.fetch:url');
    expect(asRecord(prepared.schema.function).name).toBe(prepared.apiName);
  });
});
