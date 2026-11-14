/**
 * Health checks shared by the golden-path specs: failed IPC calls, renderer console errors, page errors
 * and `[ERROR]` lines in the Host main log. External requests are expected to fail (the launcher points
 * every proxy-aware client at a blackhole), so those calls are reported separately, never as product errors.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callsFromWire, type LaunchedApp, type WireCall } from './app.ts';

export interface Health {
  ipcCalls: number;
  failedCalls: WireCall[];
  /** Failed calls that only tried to reach a non-loopback URL (blocked by the smoke's blackhole proxy). */
  externalBlocked: WireCall[];
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  logErrors: string[];
  logWarnings: string[];
}

const EXTERNAL_URL = /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[^\s"'\\)]+/;

function bodyText(call: WireCall): string {
  return JSON.stringify(call.body ?? null);
}

function isExternalBlocked(call: WireCall): boolean {
  return call.cmd === 'plugin:http|fetch_send' && call.outcome === 'error' && EXTERNAL_URL.test(bodyText(call));
}

export function collectHealth(app: LaunchedApp, phases?: readonly string[]): Health {
  const rows = app.wire().filter((r) => phases === undefined || phases.includes(r.phase));
  const calls = callsFromWire(rows);
  const failed = calls.filter((c) => c.outcome === 'error');
  const consoleRows = rows.filter((r) => r.kind === 'console');
  const log = app.mainLog().split('\n');
  return {
    ipcCalls: calls.length,
    failedCalls: failed.filter((c) => !isExternalBlocked(c)),
    externalBlocked: failed.filter(isExternalBlocked),
    consoleErrors: consoleRows.filter((r) => r.level === 'error').map((r) => String(r.message)),
    consoleWarnings: consoleRows.filter((r) => r.level === 'warning').map((r) => String(r.message)),
    pageErrors: app.pageErrors.filter((e) => phases === undefined || phases.includes(e.phase)).map((e) => e.message),
    logErrors: log.filter((l) => l.includes('[ERROR]')),
    logWarnings: log.filter((l) => l.includes('[WARN]')),
  };
}

export function describeFailures(health: Health): string {
  const lines = [
    ...health.failedCalls.map((c) => `ipc ${c.cmd} [${c.phase}]: ${bodyText(c).slice(0, 400)}`),
    ...health.consoleErrors.map((m) => `console.error: ${m.slice(0, 400)}`),
    ...health.pageErrors.map((m) => `pageerror: ${m.slice(0, 400)}`),
    ...health.logErrors.map((l) => `log: ${l.slice(0, 400)}`),
  ];
  return lines.join('\n');
}

export function saveHealth(app: LaunchedApp, name: string, health: Health): string {
  const file = join(app.root, `${name}.health.json`);
  writeFileSync(file, `${JSON.stringify(health, null, 2)}\n`);
  return file;
}
