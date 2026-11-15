export const PLAIN_TEXT_CODE_EXTENSIONS: readonly string[] = [
  'py', 'pyw', 'ipynb', 'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'c', 'cpp',
  'cc', 'cxx', 'h', 'hpp', 'hh', 'cs', 'go', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'log',
  'tex', 'bib', 'rst', 'adoc',
  'vue', 'svelte', 'astro',
  'lua', 'pl', 'pm', 'r', 'jl', 'dart',
  'gradle', 'cmake', 'makefile', 'mk', 'dockerfile', 'gitignore', 'editorconfig',
  'proto', 'graphql', 'gql', 'prisma', 'sol',
  'asm', 's', 'vb', 'fs', 'fsx', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'elm',
  'nim', 'zig',
];

/** ★ 代码/纯文本扩展名（与前端 `ATTACHMENT_CODE_TEXT_EXTENSIONS` 同一清单） */
export function isPlainTextCodeExtension(ext: string): boolean {
  return PLAIN_TEXT_CODE_EXTENSIONS.includes(ext.trim().toLowerCase());
}
