/** Async transport only. Synchronous compiler work lives in a standalone Node child, not the Vitest RPC loop. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { TYPE_CONTRACT_TIMEOUT_MS } from './typecheck-budget';

const root = path.resolve(__dirname, '../../..');
const worker = path.join(__dirname, 'typecheck-worker.mjs');

export interface TypeTestResult {
  clean: string[];
  tags: string[];
  unexpected: string[];
  missing: string[];
  errors: Record<string, string>;
}

interface NodeConfigResult {
  noEmit: boolean;
  files: string[];
  errors: string[];
}

type Request =
  | { kind: 'contract'; file: string; configPath?: string }
  | { kind: 'owned'; rootNames: string[] }
  | { kind: 'node-config'; configPath: string };

const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function runCompiler<T>(request: Request, valid: (value: unknown) => value is T): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [worker, JSON.stringify(request)], {
      cwd: root,
      encoding: 'utf8',
      timeout: TYPE_CONTRACT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (error, stdout, stderr) => {
      const failure = (message: string) => new Error(`TypeScript compiler child (${request.kind}) ${message}\nstderr:\n${stderr || '(empty)'}`);
      if (error) {
        reject(failure(`failed: ${error.message}`));
        return;
      }
      try {
        const result: unknown = JSON.parse(stdout);
        if (!valid(result)) throw new Error('invalid result shape');
        resolve(result);
      } catch (error) {
        reject(failure(`returned invalid JSON/result: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export function runTypeTest(file: string, configPath?: string): Promise<TypeTestResult> {
  return runCompiler({ kind: 'contract', file, configPath }, (value): value is TypeTestResult =>
    record(value) && stringArray(value.clean) && stringArray(value.tags) && stringArray(value.unexpected) && stringArray(value.missing)
    && record(value.errors) && Object.values(value.errors).every((error) => typeof error === 'string'));
}

export function runOwnedTypecheck(rootNames: string[]): Promise<string[]> {
  return runCompiler({ kind: 'owned', rootNames }, stringArray);
}

export function runNodeConfigTypecheck(configPath: string): Promise<NodeConfigResult> {
  return runCompiler({ kind: 'node-config', configPath }, (value): value is NodeConfigResult =>
    record(value) && typeof value.noEmit === 'boolean' && stringArray(value.files) && stringArray(value.errors));
}
