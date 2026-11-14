// Preload (`node --import`) for determinism tests: every clock or randomness read is recorded
// with the non-internal stack frames that led to it, and the list is written to
// $W0_NONDETERMINISM_LOG when the process exits. Reads still return their real values.
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const records = [];
let recording = false;
Error.stackTraceLimit = Infinity;

function note(kind) {
  if (recording) return;
  recording = true;
  try {
    const frames = (new Error().stack ?? '').split('\n').slice(1).map(line => line.trim())
      .filter(line => line.startsWith('at ') && !line.includes('node:') && !line.includes('nondeterminism-probe.mjs'));
    records.push({ kind, frames });
  } finally {
    recording = false;
  }
}

/** Non-configurable entries (node:crypto `getRandomValues`) delegate to a wrapped webcrypto method. */
function wrap(owner, name, kind) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor && !descriptor.configurable) return;
  const original = owner[name];
  if (typeof original !== 'function') return;
  Object.defineProperty(owner, name, { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true,
    value: function (...args) { note(kind); return original.apply(this, args); } });
}

wrap(Date, 'now', 'Date.now');
wrap(Math, 'random', 'Math.random');
wrap(performance, 'now', 'performance.now');
const hrtime = process.hrtime;
const hrtimeBigint = hrtime.bigint;
process.hrtime = function (...args) { note('process.hrtime'); return hrtime.apply(this, args); };
process.hrtime.bigint = function () { note('process.hrtime.bigint'); return hrtimeBigint.call(hrtime); };
for (const name of ['randomBytes', 'randomUUID', 'randomInt', 'randomFillSync', 'randomFill', 'getRandomValues']) wrap(crypto, name, `crypto.${name}`);
wrap(crypto.webcrypto, 'getRandomValues', 'webcrypto.getRandomValues');
wrap(crypto.webcrypto, 'randomUUID', 'webcrypto.randomUUID');
syncBuiltinESMExports();

const NativeDate = Date;
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) note('new Date()');
    return Reflect.construct(target, args, newTarget);
  },
  apply(target, self, args) {
    note('Date()');
    return Reflect.apply(target, self, args);
  },
});

process.on('exit', () => {
  if (process.env.W0_NONDETERMINISM_LOG) writeFileSync(process.env.W0_NONDETERMINISM_LOG, JSON.stringify(records));
});
