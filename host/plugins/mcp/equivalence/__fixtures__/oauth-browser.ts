/**
 * Stand-in for the system browser during G3 OAuth scenarios. `mcp-service.ts` writes
 * `<logDir>/bin/xdg-open`, which runs this file; with that directory first on the app's PATH,
 * Rust `tauri_plugin_opener::open_url` (auth.rs:767) and B `plugin:opener|open_url` (Electron
 * `shell.openExternal`) both reach it, so the authorization URL is visited the same way on A and B.
 *
 * It GETs the URL without following redirects, then follows each `Location` itself (at most
 * 5 hops), only to `http` loopback hosts: a scenario can never reach the network through it.
 * Like a real browser it "opens" whatever comes back, so it always exits 0; what happened is
 * appended to the `--log` file as JSON lines.
 *
 * Plain Node TS (type-stripping safe); imports only `node:` modules (copied alone by selfContained).
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface BrowserRecord {
  kind: 'browser';
  url: string;
  /** `fetched` (status below), `refused` (not an http loopback URL), `failed` (network error), `hop-limit`. */
  outcome: 'fetched' | 'refused' | 'failed' | 'hop-limit';
  status: number | null;
  location: string | null;
  detail: string | null;
}

const MAX_HOPS = 5;

function loopbackHttp(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.username === '' && url.password === '';
  } catch { return false; }
}

export async function browse(start: string): Promise<BrowserRecord[]> {
  const records: BrowserRecord[] = [];
  let url = start;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_HOPS) {
      records.push({ kind: 'browser', url, outcome: 'hop-limit', status: null, location: null, detail: `more than ${MAX_HOPS} redirects` });
      return records;
    }
    if (!loopbackHttp(url)) {
      records.push({ kind: 'browser', url, outcome: 'refused', status: null, location: null, detail: 'only http loopback URLs are visited' });
      return records;
    }
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      records.push({ kind: 'browser', url, outcome: 'failed', status: null, location: null, detail: error instanceof Error ? error.message : String(error) });
      return records;
    }
    const location = response.headers.get('location');
    const body = await response.text();
    records.push({ kind: 'browser', url, outcome: 'fetched', status: response.status, location, detail: body.slice(0, 200) });
    if (response.status < 300 || response.status >= 400 || location === null) return records;
    url = new URL(location, url).toString();
  }
}

async function main(argv: string[]): Promise<number> {
  const logIndex = argv.indexOf('--log');
  const log = logIndex >= 0 ? argv[logIndex + 1] : undefined;
  const urls = argv.filter((_, index) => index !== logIndex && index !== logIndex + 1);
  if (log === undefined || urls.length !== 1) {
    process.stderr.write('usage: oauth-browser.ts --log <file> <url>\n');
    return 2;
  }
  const records = await browse(urls[0] ?? '');
  appendFileSync(log, records.map(record => `${JSON.stringify(record)}\n`).join(''));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`oauth-browser failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
