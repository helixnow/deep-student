import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// C2-approved OS-answer adapter only. Callers still use the production UI,
// preload, shell dialog plugin and allowSelected; no IPC handler is replaced.
export function createDialogAnswer(application) {
  const dialogStub = { scope: 'harness-only: Electron main-process dialog.showOpenDialog answer; shell dialog plugin, allowSelected grant and all IPC are production', calls: [] };
  return {
    async install(paths) {
      await application.evaluate(({ dialog }, paths) => {
        const original = dialog.showOpenDialog;
        globalThis.__x1DialogStubCalls = [];
        dialog.showOpenDialog = async (...args) => {
          dialog.showOpenDialog = original;
          const options = args.find(arg => arg && typeof arg === 'object' && 'properties' in arg) ?? null;
          globalThis.__x1DialogStubCalls.push({ at: new Date().toISOString(), options, filePaths: paths });
          return { canceled: false, filePaths: paths };
        };
      }, paths);
    },
    async capture() {
      const stubCalls = await application.evaluate(() => globalThis.__x1DialogStubCalls ?? []);
      dialogStub.calls = stubCalls.map(call => ({ ...call,
        files: call.filePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }));
      if (dialogStub.calls.length !== 1) throw new Error(`dialog stub answered ${dialogStub.calls.length} calls, expected 1`);
    },
    evidence() { return { dialogStub }; },
  };
}
