/** Two real stages, both emitted on the directly spawned app's stdout. */
export function auditLaunchEnvironment(stdout, pid, nativeVariables, jsVariables) {
  const lines = stdout.split(/\r?\n/);
  const native = lines.filter((line) => line.startsWith('[dstu-native-cache-v1]'));
  const js = lines.filter((line) => line.startsWith('[dstu-shell] [launch] packaged build: ignored development environment variables '));
  const match = native.length === 1
    ? /^\[dstu-native-cache-v1\] pid=([1-9]\d*) removed=([A-Z_,]+)$/.exec(native[0]) : null;
  const nativeOK = match !== null && Number(match[1]) === pid && match[2] === nativeVariables.join(',');
  const jsOK = jsVariables.length === 0 ? js.length === 0
    : js.length === 1 && js[0] === `[dstu-shell] [launch] packaged build: ignored development environment variables ${jsVariables.join(', ')}`;
  return { ok: nativeOK && jsOK, native: native.join(' | '), js: js.join(' | ') };
}
