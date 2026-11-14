import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import {
  defaultProviderStrategies,
  defaultToolConfig,
  doSearch,
  getStrategy,
  type SearchInput,
} from '../../mcp/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L19 生产重试策略实现
import { calculateRetryDelay, shouldRetry } from '../../mcp/src/web-search.ts';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// tools_integration_tests.rs::test_provider_strategies_functionality
it('test_provider_strategies_functionality', () => {
  const strategies = defaultProviderStrategies();

  const bocha = getStrategy(strategies, 'bocha');
  expect(bocha.timeout_ms).toBe(10000);
  expect(bocha.max_retries).toBe(2);
  expect(bocha.rate_limit_per_minute).toBe(60);

  const serpapi = getStrategy(strategies, 'serpapi');
  expect(serpapi.timeout_ms).toBe(15000);
  expect(serpapi.max_retries).toBe(2);
  expect(serpapi.rate_limit_per_minute).toBe(20);

  expect(getStrategy(strategies, 'unknown_provider').timeout_ms).toBe(8000);
});

// tools_integration_tests.rs::test_provider_strategy_retry_logic
it('test_provider_strategy_retry_logic', () => {
  const strategy = defaultProviderStrategies().default;

  expect(calculateRetryDelay(strategy, 0)).toBe(200);
  expect(calculateRetryDelay(strategy, 1)).toBe(400);
  expect(calculateRetryDelay(strategy, 2)).toBe(800);
  expect(calculateRetryDelay(strategy, 3)).toBe(1600);
  expect(calculateRetryDelay(strategy, 10)).toBeLessThanOrEqual(5000);

  expect(shouldRetry(strategy, 0, 500, 'Internal Server Error')).toBe(true);
  expect(shouldRetry(strategy, 1, 429, 'Too Many Requests')).toBe(true);
  expect(shouldRetry(strategy, 0, 504, 'Gateway Timeout')).toBe(true);
  expect(shouldRetry(strategy, 0, 400, 'Bad Request')).toBe(false);
  expect(shouldRetry(strategy, 3, 500, 'Internal Server Error')).toBe(false);

  expect(shouldRetry(strategy, 0, null, 'Connection timeout')).toBe(true);
  expect(shouldRetry(strategy, 0, null, 'Network unreachable')).toBe(true);
  expect(shouldRetry(strategy, 0, null, 'Invalid API key')).toBe(false);
});

// tools_integration_tests.rs::test_web_search_tool_with_mock_server
it('test_web_search_tool_with_mock_server', async () => {
  const mockResponse = {
    results: [
      {
        title: 'Test Result 1',
        url: 'https://example.com/1',
        content: 'This is a test search result',
      },
      {
        title: 'Test Result 2',
        url: 'https://example.com/2',
        content: 'Another test search result',
      },
    ],
  };
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mockResponse));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const config = defaultToolConfig();
  config.default_engine = 'searxng';
  config.keys.searxng_endpoint = url;
  const input: SearchInput = {
    query: 'test query',
    top_k: 5,
    engine: 'searxng',
    site: null,
    time_range: null,
    start: 0,
    force_engine: null,
  };

  const result = await doSearch(config, input);
  expect(result.ok).toBe(true);
  // tools_integration_tests.rs:136-138：error 为空，usage 带 elapsed_ms。
  expect(result.error).toBeUndefined();
  expect(result.usage).toHaveProperty('elapsed_ms');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.startsWith('/search?')).toBe(true);
  expect(result.result).toEqual({ provider: 'searxng', raw: mockResponse });
  expect(result.citations).toHaveLength(2);
  expect(result.citations?.[0]?.documentId).toBe('https://example.com/1');
  expect(result.inject_text).toContain('Test Result 1');
});
