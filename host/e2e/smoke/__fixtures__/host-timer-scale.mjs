// Test-only Host entry (W12_HOST_TIMER_SCALE in window-main.mjs): a schedule Rust runs on minutes or hours
// becomes observable in seconds without changing the product's delays. Electron utility processes ignore
// `--import` / `--require` in execArgv, so window-main.mjs forks this module instead of the Host entry; it
// installs the rescaling and then imports the real entry (W12_HOST_ENTRY) unchanged.
// Only `setTimeout` calls made directly from a module whose URL contains `file`, with exactly one of the listed
// delays, are rescaled; every other timer in the Host keeps real time:
//   W12_HOST_TIMER_SCALE=file=<path fragment>&delays=<from>:<to>,<from>:<to>
import { pathToFileURL } from 'node:url';

const params = new URLSearchParams(process.env.W12_HOST_TIMER_SCALE ?? '');
const file = params.get('file') ?? '';
const delays = new Map((params.get('delays') ?? '').split(',').filter(Boolean)
  .map((pair) => pair.split(':').map(Number)));
const entry = process.env.W12_HOST_ENTRY;
if (!entry) throw new Error('host-timer-scale.mjs: W12_HOST_ENTRY is not set');

if (file !== '' && delays.size > 0) {
  const original = globalThis.setTimeout;
  const scaled = function setTimeout(callback, delay, ...args) {
    if (delays.has(delay)) {
      const caller = new Error().stack?.split('\n')[2] ?? '';
      if (caller.includes(file)) {
        process.stderr.write(`[w12-timer-scale] ${delay} ms → ${delays.get(delay)} ms (${caller.trim()})\n`);
        return original.call(this, callback, delays.get(delay), ...args);
      }
    }
    return original.call(this, callback, delay, ...args);
  };
  Object.defineProperties(scaled, Object.getOwnPropertyDescriptors(original));
  globalThis.setTimeout = scaled;
}

await import(pathToFileURL(entry).href);
