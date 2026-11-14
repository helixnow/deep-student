import { describe, expect, it } from 'vitest';
import { auditLaunchEnvironment } from '../scripts/launch-env-audit.mjs';
import { DEV_ONLY_ENV, MAC_NATIVE_CACHE_ENV } from '../shell/launch-env.ts';

const pid = 1234;
const native = `[dstu-native-cache-v1] pid=${pid} removed=${MAC_NATIVE_CACHE_ENV.join(',')}`;
const jsVariables = DEV_ONLY_ENV.filter((name) => !(MAC_NATIVE_CACHE_ENV as readonly string[]).includes(name));
const js = `[dstu-shell] [launch] packaged build: ignored development environment variables ${jsVariables.join(', ')}`;
const audit = (stdout: string) => auditLaunchEnvironment(stdout, pid, MAC_NATIVE_CACHE_ENV, jsVariables).ok;

describe('native + JS launch environment audit', () => {
  it('accepts only the joint deletion evidence with the actual spawned PID and exact variable lists', () => {
    expect(audit(`${native}\n${js}\n`)).toBe(true);
    expect(audit(`${js}\n${native}\n`)).toBe(true);
  });
  it.each([
    js, native,
    `${native.replace('1234', '1235')}\n${js}`,
    `${native.replace('-v1]', '-v2]')}\n${js}`,
    `${native.replace(',NODE_COMPILE_CACHE_PORTABLE', '')}\n${js}`,
    `${native},NODE_OPTIONS\n${js}`,
    `${native} extra\n${js}`,
    `prefix ${native}\n${js}`,
    `${native}\n${native}\n${js}`,
    `${native}\n${js}, NODE_COMPILE_CACHE`,
    `${native}\n${js}\n${js}`,
    `[launch] ignored development environment variables ${DEV_ONLY_ENV.join(', ')} multipart`,
  ])('rejects incomplete, forged or ambiguous audit evidence (%#)', (text) => {
    expect(audit(text)).toBe(false);
  });
});
