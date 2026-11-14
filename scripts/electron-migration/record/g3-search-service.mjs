// Local SearXNG mock for `${search.searxngUrl}` (host/plugins/browser/equivalence README, pending-mock).
// A (dstu-mcp web_search.rs SearxngProvider) and B (host/plugins/mcp/src/web-search-providers.ts) both
// send `GET {endpoint}/search?q=…&format=json…`; every request gets the scenario's next scripted
// response (`scenario.search.searxng`, default ["success"]), the last one repeating, as fixed bytes.
import { createServer } from 'node:http';

/** Fixed loopback port inside a g3 worker's network namespace (LLM 47110, cloud 47120-47122, MCP 47130). */
export const SEARCH_PORT = 47140;
export const SEARCH_ENGINES = ['searxng'];
export const SEARXNG_RESPONSES = {
  success: { status: 200, body: { query: 'g3', number_of_results: 2, results: [
    { title: 'G3 SearXNG result one', url: 'https://example.invalid/g3/one', content: 'First fixed result of the G3 SearXNG mock.', engine: 'g3' },
    { title: 'G3 SearXNG result two', url: 'https://example.invalid/g3/two', content: 'Second fixed result of the G3 SearXNG mock.', engine: 'g3' }],
    answers: [], corrections: [], infoboxes: [], suggestions: [], unresponsive_engines: [] } },
  empty: { status: 200, body: { query: 'g3', number_of_results: 0, results: [], answers: [], corrections: [], infoboxes: [], suggestions: [], unresponsive_engines: [] } },
  'http-500': { status: 500, body: { error: 'g3 searxng mock: scripted failure' } },
};
export const searchBindingKinds = () => ({ 'search.searxngUrl': 'string' });

/** Why `scenario.search` cannot be served, or null. */
export function searchGap(scenario) {
  if (scenario.search === undefined) return null;
  if (!scenario.search || typeof scenario.search !== 'object' || Array.isArray(scenario.search)) return 'search must be an object of engine → response names';
  for (const engine of Object.keys(scenario.search)) if (!SEARCH_ENGINES.includes(engine)) return `search engine ${engine} has no mock (known: ${SEARCH_ENGINES.join(', ')})`;
  const list = scenario.search.searxng;
  if (list === undefined) return null;
  if (!Array.isArray(list) || !list.length || !list.every(name => typeof name === 'string')) return 'search.searxng must be a non-empty list of response names';
  const unknown = list.find(name => !Object.hasOwn(SEARXNG_RESPONSES, name));
  return unknown === undefined ? null : `search.searxng response ${unknown} is not one of ${Object.keys(SEARXNG_RESPONSES).sort().join(', ')}`;
}

export async function startSearchService({ host = '127.0.0.1', port = SEARCH_PORT, searxng = ['success'] } = {}) {
  const requests = [];
  let served = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = new URL(request.url, 'http://mock').pathname;
      if (request.method !== 'GET' || path.replace(/\/+$/, '') !== '/search') {
        requests.push({ method: request.method, url: request.url, response: null });
        response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const name = searxng[Math.min(served++, searxng.length - 1)];
      const { status, body } = SEARXNG_RESPONSES[name];
      requests.push({ method: request.method, url: request.url, response: name });
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const url = `http://${host}:${server.address().port}`;
  return {
    port: server.address().port,
    searxngUrl: url,
    requests: () => structuredClone(requests),
    stop: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
