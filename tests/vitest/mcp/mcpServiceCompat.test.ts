import { describe, expect, it } from 'vitest';
import { isTauriStreamChannelCompatError } from '../../../src/mcp/mcpService';

describe('isTauriStreamChannelCompatError', () => {
  it('returns true for tauri streamChannel body-read compatibility errors', () => {
    expect(
      isTauriStreamChannelCompatError(
        new Error('invalid args `streamChannel` for command `fetch_read_body` missing required key streamChannel'),
      ),
    ).toBe(true);
  });

  it('returns false for unrelated transport errors', () => {
    expect(isTauriStreamChannelCompatError(new Error('MCP error -32000: Connection closed'))).toBe(false);
  });
});
