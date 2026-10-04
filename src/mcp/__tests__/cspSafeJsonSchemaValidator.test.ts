// @vitest-environment node
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { config as zodConfig } from 'zod';

// Under a real CSP, zod's `allowsEval` probe fails, so the SDK's protocol schemas never JIT.
// zod decides that per schema at construction time, so turn JIT off *before* the SDK modules
// (and their schemas) are loaded; otherwise zod's lazily generated fast-path parsers would hit
// the throwing Function stub below and hang the request.
const previousJitless = zodConfig().jitless;
zodConfig({ jitless: true });
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
const { createCspSafeJsonSchemaValidator } = await import('../cspSafeJsonSchemaValidator');
type Client = InstanceType<typeof Client>;

/**
 * Release builds run under CSP `script-src 'self'` (no 'unsafe-eval'), where `new Function`
 * throws EvalError. Emulate that by making the global Function constructor throw while the
 * MCP client lists/calls tools. A Proxy keeps `instanceof Function` checks working.
 */
const OriginalFunction = globalThis.Function;
function forbidEval() {
  const evalError = () => {
    throw new EvalError('Refused to evaluate a string as JavaScript (CSP: no unsafe-eval)');
  };
  globalThis.Function = new Proxy(OriginalFunction, {
    apply: evalError,
    construct: evalError,
  });
}
afterEach(() => {
  globalThis.Function = OriginalFunction;
});

afterAll(() => {
  zodConfig({ jitless: previousJitless });
});

const outputSchema = {
  type: 'object',
  properties: { sum: { type: 'number' } },
  required: ['sum'],
} as const;

async function connectPair(client: Client, structuredContent: Record<string, unknown>) {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
        outputSchema,
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return server;
}

describe('createCspSafeJsonSchemaValidator', () => {
  it('lists and validates tools with outputSchema without eval', async () => {
    const client = new Client(
      { name: 'csp-test', version: '1.0.0' },
      { jsonSchemaValidator: createCspSafeJsonSchemaValidator() },
    );
    const server = await connectPair(client, { sum: 3 });
    try {
      forbidEval();
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(['add']);
      const result = await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } });
      expect(result.structuredContent).toEqual({ sum: 3 });
    } finally {
      globalThis.Function = OriginalFunction;
      await client.close();
      await server.close();
    }
  });

  it('still rejects structured content that violates outputSchema without eval', async () => {
    const client = new Client(
      { name: 'csp-test', version: '1.0.0' },
      { jsonSchemaValidator: createCspSafeJsonSchemaValidator() },
    );
    const server = await connectPair(client, { sum: 'not-a-number' });
    try {
      forbidEval();
      await client.listTools();
      await expect(client.callTool({ name: 'add', arguments: { a: 1, b: 2 } })).rejects.toThrow(
        /does not match the tool's output schema/i,
      );
    } finally {
      globalThis.Function = OriginalFunction;
      await client.close();
      await server.close();
    }
  });

  it('control: the SDK default (Ajv) validator fails to list tools when eval is forbidden', async () => {
    const client = new Client({ name: 'csp-test', version: '1.0.0' });
    const server = await connectPair(client, { sum: 3 });
    try {
      forbidEval();
      await expect(client.listTools()).rejects.toThrow(/evaluate a string as JavaScript/);
    } finally {
      globalThis.Function = OriginalFunction;
      await client.close();
      await server.close();
    }
  });
});
