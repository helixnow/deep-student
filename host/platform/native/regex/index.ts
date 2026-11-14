import type {
  NativeRegex,
  NativeRegexPattern,
  RegexCaptures,
  RegexMatch,
  RegexProjectedReplacement,
} from './api.ts';
import { NativeRegexCompileError } from './api.ts';
export { NativeRegexCompileError } from './api.ts';
import { removeRun, runWasm } from '../wasm/loader.ts';

async function invoke(pattern: NativeRegexPattern, op: string, request: Record<string, unknown>): Promise<unknown> {
  const run = await runWasm({ engine: 'regex', op, pattern: pattern.pattern, ...request });
  try {
    const response = run.response;
    if (response.ok !== true) {
      throw new NativeRegexCompileError(pattern.pattern, String(response.error));
    }
    return response.value;
  } finally {
    await removeRun(run);
  }
}

function handle(pattern: string): NativeRegexPattern {
  return Object.freeze({ pattern });
}

export const regex: NativeRegex = {
  async compile(pattern: string): Promise<NativeRegexPattern> {
    await invoke(handle(pattern), 'compile', {});
    return handle(pattern);
  },
  async isMatch(pattern: NativeRegexPattern, text: string): Promise<boolean> {
    return (await invoke(pattern, 'is_match', { text })) as boolean;
  },
  async findIter(pattern: NativeRegexPattern, text: string): Promise<RegexMatch[]> {
    return (await invoke(pattern, 'find_iter', { text })) as RegexMatch[];
  },
  async captures(pattern: NativeRegexPattern, text: string): Promise<RegexCaptures | null> {
    return (await invoke(pattern, 'captures', { text })) as RegexCaptures | null;
  },
  async replace(pattern: NativeRegexPattern, text: string, replacement: string): Promise<string> {
    return (await invoke(pattern, 'replace', { text, replacement })) as string;
  },
  async replaceAll(pattern: NativeRegexPattern, text: string, replacement: string): Promise<string> {
    return (await invoke(pattern, 'replace_all', { text, replacement })) as string;
  },
  async replaceAllProjected(pattern: NativeRegexPattern, text: string, replacement: string,
    limitBytes: number): Promise<RegexProjectedReplacement> {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new TypeError(`limitBytes must be a non-negative safe integer: ${limitBytes}`);
    }
    return (await invoke(pattern, 'replace_all_projected', { text, replacement, limit: limitBytes })) as RegexProjectedReplacement;
  },
  async split(pattern: NativeRegexPattern, text: string): Promise<string[]> {
    return (await invoke(pattern, 'split', { text })) as string[];
  },
};
