import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillRequires, SkillRequiresProbe } from '../api.ts';
import { partitionRequires, pythonImportName } from './requires-core.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

// The pure frontmatter / `requires` parser lives in `requires-core.ts` so the mobile host can
// reuse it without `node:child_process`; these re-exports keep the desktop API unchanged.
export {
  emptyRequiresProbe, extractFrontmatter, invalidRequiresSorted, parseRequires,
} from './requires-core.ts';
export { partitionRequires, pythonImportName };

// skill_requires.rs:101-336 deliberately uses a YAML-ish parser, not a YAML library.
const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());


export function probeSearchDirs(sourcePath: string | undefined, home: string | undefined): string[] {
  const dirs: string[] = [];
  const push = (dir: string) => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  for (const dir of sourcePath?.split(path.delimiter) ?? []) push(dir);
  if (process.platform !== 'win32') {
    for (const dir of [
      ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : ['/home/linuxbrew/.linuxbrew/bin', '/home/linuxbrew/.linuxbrew/sbin']),
      '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ]) push(dir);
  }
  if (home !== undefined) for (const relative of ['.local/bin', '.cargo/bin', 'bin']) push(path.join(home, relative));
  return dirs;
}

export async function probeBinInDirs(bin: string, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    const metadata = await stat(path.join(dir, bin)).catch(() => null);
    if (metadata?.isFile() && (metadata.mode & 0o111) !== 0) return true;
  }
  return false;
}

function commandSucceeds(command: string, args: string[], env = process.env): Promise<boolean> {
  return new Promise(resolve => {
    execFile(command, args, { env, windowsHide: true, maxBuffer: Infinity }, error => resolve(error === null));
  });
}

// Rust times out the blocking task's join; it does not terminate its process.
async function probeTimeout(work: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
  } finally { clearTimeout(timer); }
}

export async function probeBin(bin: string): Promise<boolean> {
  const dirs = probeSearchDirs(process.env.PATH, process.env.HOME);
  return probeTimeout(process.platform === 'win32'
    ? commandSucceeds('where', [bin], { ...process.env, PATH: dirs.join(path.delimiter) })
    : probeBinInDirs(bin, dirs));
}

async function probePythonPackage(name: string): Promise<boolean> {
  return probeTimeout((async () => {
    const script = `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(pythonImportName(name))}) else 1)`;
    for (const python of ['python3', 'python']) if (await commandSucceeds(python, ['-c', script])) return true;
    return false;
  })());
}

export async function probeRequires(requires: SkillRequires): Promise<SkillRequiresProbe> {
  const [valid, invalid] = partitionRequires(requires);
  const bins: SkillRequiresProbe['bins'] = [];
  for (const name of valid.bins) bins.push({ name, found: await probeBin(name) });
  const env = valid.env.map(name => ({ name, set: process.env[name] !== undefined }));
  const python_packages: SkillRequiresProbe['python_packages'] = [];
  for (const name of valid.python_packages) python_packages.push({ name, found: await probePythonPackage(name) });
  return {
    bins, env, python_packages,
    invalid: [...new Set(invalid)].sort(compareUtf8),
    missing_count: bins.filter(b => !b.found).length + env.filter(e => !e.set).length + python_packages.filter(p => !p.found).length,
  };
}

function binMissingHint(bin: string): string {
  const lower = asciiLower(bin);
  if (process.platform === 'win32') {
    const packages: Record<string, string> = {
      python: 'Python.Python.3', python3: 'Python.Python.3', node: 'OpenJS.NodeJS.LTS', npm: 'OpenJS.NodeJS.LTS', npx: 'OpenJS.NodeJS.LTS',
      pandoc: 'JohnMacFarlane.Pandoc', git: 'Git.Git', uv: 'astral-sh.uv', rg: 'BurntSushi.ripgrep.MSVC', ripgrep: 'BurntSushi.ripgrep.MSVC',
    };
    return Object.hasOwn(packages, lower)
      ? `${bin} was not found on PATH. Ask the user to install it, or propose \`local_shell_execute\` with \`winget install ${packages[lower]}\` after approval.`
      : `${bin} was not found on PATH. Ask the user to install it manually, then retry loading this skill.`;
  }
  const hints: Record<string, string> = {
    python: 'Install Python 3 via your system package manager (e.g. apt install python3).',
    python3: 'Install Python 3 via your system package manager (e.g. apt install python3).',
    node: 'Install Node.js LTS via your system package manager or nvm.', npm: 'Install Node.js LTS via your system package manager or nvm.', npx: 'Install Node.js LTS via your system package manager or nvm.',
    pandoc: 'Install pandoc via your system package manager.', git: 'Install git via your system package manager.',
  };
  const hint = Object.hasOwn(hints, lower) ? hints[lower] : 'Install it via your system package manager.';
  return `${bin} was not found on PATH. ${hint} After installation, retry loading this skill.`;
}

export function formatMissingRequiresHints(probe: SkillRequiresProbe): string[] {
  return [
    ...probe.bins.filter(b => !b.found).map(b => binMissingHint(b.name)),
    ...probe.env.filter(e => !e.set).map(e => `Environment variable ${e.name} is not set. Ask the user to configure it in Settings or their shell profile before using this skill.`),
    ...probe.python_packages.filter(p => !p.found).map(p => {
      const module = pythonImportName(p.name);
      const note = module !== asciiLower(p.name.replaceAll('-', '_')) && asciiLower(module) !== asciiLower(p.name) ? ` (import as \`${module}\`)` : '';
      return `Python package \`${p.name}\` is not importable${note}. Prefer proposing \`local_shell_execute\` with \`uv pip install ${p.name}\` (or \`python3 -m pip install ${p.name}\`) after the skill is trusted and the command is approved, then retry loading this skill.`;
    }),
  ];
}
