import { spawn } from 'node:child_process';
import { decodeUtf8Strict, rustTrim } from '../util/index.ts';
import { ioMessage } from '../paths/compat.ts';
import type { DiagnosticsService, PackageManagerInfo, PackageInstallResult } from './api.ts';

async function output(command: string, args: string[]): Promise<{ success: boolean; stdout: Buffer; stderr: Buffer } | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.once('error', () => resolve(null));
    child.once('close', code => resolve({ success: code === 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}
const available = async (command: string) => (await output(process.platform === 'win32' ? 'where' : 'which', [command]))?.success === true;
async function version(command: string): Promise<string | null> {
  const result = await output(command, ['--version']);
  if (!result?.success) return null;
  try { return rustTrim(decodeUtf8Strict(result.stdout)); }
  catch { try { return rustTrim(decodeUtf8Strict(result.stderr)); } catch { return null; } }
}
const uvInstall = process.platform === 'win32' ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"' : 'curl -LsSf https://astral.sh/uv/install.sh | sh';
const cargoInstall = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh";
async function check(kind: 'node' | 'python' | 'uv' | 'cargo'): Promise<PackageManagerInfo> {
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  let is_available = false, installedVersion: string | null = null, install_command: string | null = null;
  const hints: string[] = [];
  if (kind === 'node') {
    const npx = await available('npx'), npm = await available('npm'), node = await available('node');
    is_available = npx || npm;
    installedVersion = npx ? await version('npx') : npm ? await version('npm') : node ? await version('node') : null;
    if (!node && !npm) hints.push('Node.js 未安装', '推荐安装方式：', ...(mac ? ['  • Homebrew: brew install node', '  • 官方下载: https://nodejs.org', '  • nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && nvm install node'] : win ? ['  • Chocolatey: choco install nodejs', '  • Scoop: scoop install nodejs', '  • 官方下载: https://nodejs.org', '  • Winget: winget install OpenJS.NodeJS'] : ['  • 包管理器: sudo apt install nodejs npm (Debian/Ubuntu)', '  • 包管理器: sudo yum install nodejs (RedHat/CentOS)', '  • 官方下载: https://nodejs.org']));
  } else if (kind === 'python') {
    const pip = await available('pip') || await available('pip3');
    const python = await available('python') || await available('python3');
    is_available = pip || python;
    installedVersion = pip ? (await version('pip') ?? await version('pip3')) : python ? (await version('python') ?? await version('python3')) : null;
    if (!python) hints.push('Python 未安装', '推荐安装方式：', ...(mac ? ['  • Homebrew: brew install python', '  • 官方下载: https://www.python.org/downloads/'] : win ? ['  • Chocolatey: choco install python', '  • Scoop: scoop install python', '  • 官方下载: https://www.python.org/downloads/', '  • Winget: winget install Python.Python.3.12'] : ['  • 包管理器: sudo apt install python3 python3-pip', '  • 官方下载: https://www.python.org/downloads/']));
  } else {
    is_available = await available(kind);
    if (is_available) installedVersion = await version(kind);
    else if (kind === 'uv') {
      install_command = uvInstall;
      hints.push('uv 未安装（高性能 Python 包管理器）', '推荐安装方式：', ...(win ? ['  • PowerShell: irm https://astral.sh/uv/install.ps1 | iex', '  • Scoop: scoop install uv'] : [`  • 一键安装: ${uvInstall}`, '  • Homebrew: brew install uv']));
    } else {
      install_command = win ? null : cargoInstall;
      hints.push('Cargo/Rust 未安装', '推荐安装方式：', ...(win ? ['  • 下载 rustup-init.exe: https://rustup.rs', '  • Scoop: scoop install rustup'] : [`  • Rustup: ${cargoInstall}`, '  • Homebrew: brew install rust']));
    }
  }
  return { manager_type: kind === 'node' ? 'npm/npx' : kind === 'python' ? 'pip/python' : kind, is_available, version: installedVersion, install_command, install_hints: hints };
}
/** dstu-platform/package_manager.rs:280–363. Timeout reaps direct child without waiting on inherited pipes. */
export function runInstallCommand(command: string, timeout = 600000): Promise<[boolean, string]> {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'powershell' : 'sh', [win ? '-Command' : '-c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    let kept = 0, timedOut = false;
    child.stdout.resume();
    child.stderr.on('data', (value: Buffer) => {
      const part = value.subarray(0, Math.max(0, 1024 * 1024 - kept));
      if (part.length) { stderr.push(part); kept += part.length; }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`启动安装进程失败: ${ioMessage(error)}`)); });
    child.once('exit', () => {
      if (timedOut) {
        child.stdout.destroy(); child.stderr.destroy();
        reject(new Error(`安装超时（${Math.floor(timeout / 1000)} 秒），已终止安装进程`));
      }
    });
    child.once('close', code => { clearTimeout(timer); if (!timedOut) resolve([code === 0, Buffer.concat(stderr).toString('utf8')]); });
  });
}
export interface DiagnosticsLogger {
  info(message: string): void;
}

const silent: DiagnosticsLogger = { info: () => undefined };

export function createDiagnosticsService(log: DiagnosticsLogger = silent): DiagnosticsService {
  return {
    async checkPackageManager(command) {
      const lower = command.toLowerCase();
      if (lower === 'npx' || lower.endsWith('npx.cmd') || lower.endsWith('npx.exe')) return check('node');
      if (lower === 'uv' || lower.endsWith('uv.exe')) return check('uv');
      if (['pip', 'pip3', 'python', 'python3'].includes(lower)) return check('python');
      return lower === 'cargo' ? check('cargo') : null;
    },
    async checkAllPackageManagers() {
      const result: Record<string, unknown> = {};
      for (const kind of ['node', 'python', 'uv', 'cargo'] as const) {
        const info = await check(kind);
        result[kind] = { is_available: info.is_available, version: info.version, install_hints: info.install_hints,
          ...(kind === 'uv' || kind === 'cargo' ? { can_auto_install: info.install_command !== null } : {}) };
      }
      return result;
    },
    async autoInstallPackageManager(manager): Promise<PackageInstallResult> {
      const result = (success: boolean, message: string, installed_version: string | null = null) => ({ success, message, installed_version });
      if (manager !== 'uv' && !(manager === 'cargo' && process.platform !== 'win32')) return result(false, `不支持自动安装 ${manager}，请手动安装`);
      const info = await check(manager);
      if (info.is_available) return result(true, `${manager} 已安装`, info.version);
      if (info.install_command === null) return result(false, `${manager} 需要手动安装。安装提示：\n${info.install_hints.join('\n')}`);
      // Rust `auto_install_package_manager`（417）：执行安装命令前记录 info。
      log.info(`正在自动安装 ${manager}: ${info.install_command}`);
      try {
        const [success, stderr] = await runInstallCommand(info.install_command);
        return success ? result(true, `${manager} 安装成功`, (await check(manager)).version) : result(false, `${manager} 安装失败: ${stderr}`);
      } catch (error) { return result(false, `${manager} 安装失败: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}
