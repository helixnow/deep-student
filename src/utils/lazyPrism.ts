/**
 * Shared lazy-per-language PrismJS loader and tokenizer.
 *
 * Replaces monolithic `react-syntax-highlighter/dist/esm/prism` (~218 KiB gz of ~290 refractor
 * grammars) with on-demand `prismjs` core + per-language chunks already used across the app.
 */

export interface PrismToken {
  type: string;
  content: string | PrismToken | Array<string | PrismToken>;
  alias?: string | string[];
}

export type PrismTokenStream = Array<string | PrismToken>;

export interface PrismGrammar {
  [token: string]: unknown;
}

export interface PrismInstance {
  languages: Record<string, PrismGrammar | undefined>;
  tokenize(text: string, grammar: PrismGrammar): PrismTokenStream;
  highlight(text: string, grammar: PrismGrammar, language: string): string;
}

const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ecmascript: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  h: 'c',
  'c#': 'csharp',
  cs: 'csharp',
  dotnet: 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellsession: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  rb: 'ruby',
  yml: 'yaml',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
  properties: 'ini',
  xml: 'markup',
  html: 'markup',
  htm: 'markup',
  svg: 'markup',
  mathml: 'markup',
  vue: 'markup',
  svelte: 'markup',
  md: 'markdown',
  mkd: 'markdown',
  patch: 'diff',
  dockerfile: 'docker',
  gql: 'graphql',
  tex: 'latex',
  context: 'latex',
  rlang: 'r',
  rscript: 'r',
  octave: 'matlab',
  make: 'makefile',
  mk: 'makefile',
  jsonc: 'json',
  json5: 'json',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
  plsql: 'sql',
};

/** Literal dynamic import paths so Vite emits one tiny lazy chunk per language. */
const PRISM_LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  markup: () => import('prismjs/components/prism-markup'),
  clike: () => import('prismjs/components/prism-clike'),
  javascript: () => import('prismjs/components/prism-javascript'),
  typescript: () => import('prismjs/components/prism-typescript'),
  jsx: () => import('prismjs/components/prism-jsx'),
  tsx: () => import('prismjs/components/prism-tsx'),
  css: () => import('prismjs/components/prism-css'),
  scss: () => import('prismjs/components/prism-scss'),
  less: () => import('prismjs/components/prism-less'),
  python: () => import('prismjs/components/prism-python'),
  rust: () => import('prismjs/components/prism-rust'),
  go: () => import('prismjs/components/prism-go'),
  java: () => import('prismjs/components/prism-java'),
  kotlin: () => import('prismjs/components/prism-kotlin'),
  c: () => import('prismjs/components/prism-c'),
  cpp: () => import('prismjs/components/prism-cpp'),
  csharp: () => import('prismjs/components/prism-csharp'),
  sql: () => import('prismjs/components/prism-sql'),
  bash: () => import('prismjs/components/prism-bash'),
  powershell: () => import('prismjs/components/prism-powershell'),
  batch: () => import('prismjs/components/prism-batch'),
  ruby: () => import('prismjs/components/prism-ruby'),
  'markup-templating': () => import('prismjs/components/prism-markup-templating'),
  php: () => import('prismjs/components/prism-php'),
  swift: () => import('prismjs/components/prism-swift'),
  lua: () => import('prismjs/components/prism-lua'),
  json: () => import('prismjs/components/prism-json'),
  yaml: () => import('prismjs/components/prism-yaml'),
  toml: () => import('prismjs/components/prism-toml'),
  ini: () => import('prismjs/components/prism-ini'),
  markdown: () => import('prismjs/components/prism-markdown'),
  diff: () => import('prismjs/components/prism-diff'),
  docker: () => import('prismjs/components/prism-docker'),
  graphql: () => import('prismjs/components/prism-graphql'),
  latex: () => import('prismjs/components/prism-latex'),
  r: () => import('prismjs/components/prism-r'),
  matlab: () => import('prismjs/components/prism-matlab'),
  makefile: () => import('prismjs/components/prism-makefile'),
};

/** Prism grammar dependency chain aligned with prismjs components.json `require` entries. */
const PRISM_LANGUAGE_DEPENDENCIES: Record<string, string[]> = {
  javascript: ['clike'],
  typescript: ['javascript'],
  jsx: ['markup', 'javascript'],
  tsx: ['jsx', 'typescript'],
  c: ['clike'],
  cpp: ['c'],
  csharp: ['clike'],
  java: ['clike'],
  kotlin: ['clike'],
  go: ['clike'],
  ruby: ['clike'],
  swift: ['clike'],
  php: ['markup-templating'],
  'markup-templating': ['markup'],
  scss: ['css'],
  less: ['css'],
  markdown: ['markup'],
};

export function resolvePrismLanguage(rawLanguage?: string | null): string | null {
  if (!rawLanguage) return null;
  const key = rawLanguage.trim().toLowerCase();
  if (!key || key === 'text' || key === 'plain' || key === 'plaintext') return null;
  return PRISM_LANGUAGE_ALIASES[key] ?? (PRISM_LANGUAGE_LOADERS[key] ? key : null);
}

let prismCoreInstance: PrismInstance | null = null;
let prismCorePromise: Promise<PrismInstance | null> | null = null;
const loadedPrismLanguages = new Set<string>();
const pendingLanguageLoads = new Map<string, Promise<void>>();

function loadPrismCore(): Promise<PrismInstance | null> {
  if (prismCoreInstance) return Promise.resolve(prismCoreInstance);
  if (!prismCorePromise) {
    prismCorePromise = import('prismjs')
      .then((mod) => {
        const candidate = ((mod as { default?: unknown })?.default ?? mod) as PrismInstance;
        const resolved =
          candidate && typeof candidate.tokenize === 'function'
            ? candidate
            : ((globalThis as { Prism?: PrismInstance }).Prism ?? null);
        if (resolved && typeof resolved.tokenize === 'function') {
          (globalThis as { Prism?: PrismInstance }).Prism = resolved;
          prismCoreInstance = resolved;
          return resolved;
        }
        return null;
      })
      .catch((err: unknown) => {
        prismCorePromise = null;
        console.warn('[lazyPrism] Failed to load prismjs core:', err);
        return null;
      });
  }
  return prismCorePromise;
}

function collectLanguageChain(language: string, acc: string[]): string[] {
  if (acc.includes(language)) return acc;
  for (const dep of PRISM_LANGUAGE_DEPENDENCIES[language] ?? []) {
    collectLanguageChain(dep, acc);
  }
  if (!acc.includes(language)) acc.push(language);
  return acc;
}

export function getLoadedPrismGrammar(rawLanguage?: string | null): {
  prism: PrismInstance;
  grammar: PrismGrammar;
  language: string;
} | null {
  const resolved = resolvePrismLanguage(rawLanguage);
  if (!resolved || !prismCoreInstance) return null;
  const grammar = prismCoreInstance.languages[resolved];
  return grammar ? { prism: prismCoreInstance, grammar, language: resolved } : null;
}

export async function loadPrismLanguage(rawLanguage?: string | null): Promise<{
  prism: PrismInstance;
  grammar: PrismGrammar;
  language: string;
} | null> {
  const resolved = resolvePrismLanguage(rawLanguage);
  if (!resolved) return null;

  const prism = await loadPrismCore();
  if (!prism) return null;

  for (const lang of collectLanguageChain(resolved, [])) {
    if (loadedPrismLanguages.has(lang) || prism.languages[lang]) {
      loadedPrismLanguages.add(lang);
      continue;
    }
    const loader = PRISM_LANGUAGE_LOADERS[lang];
    if (!loader) continue;
    let inFlight = pendingLanguageLoads.get(lang);
    if (!inFlight) {
      inFlight = loader()
        .then(() => {
          loadedPrismLanguages.add(lang);
        })
        .catch((err: unknown) => {
          console.warn(`[lazyPrism] Failed to load prism language "${lang}":`, err);
        })
        .finally(() => {
          pendingLanguageLoads.delete(lang);
        });
      pendingLanguageLoads.set(lang, inFlight);
    }
    await inFlight;
  }

  const grammar = prism.languages[resolved];
  return grammar ? { prism, grammar, language: resolved } : null;
}
