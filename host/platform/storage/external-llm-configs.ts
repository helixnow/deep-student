/**
 * 桌面端外部 AI 工具配置只读采集器（F3 平台层：允许使用 `node:fs` 与 `better-sqlite3`）。
 *
 * 仅在用户主动触发外部模型导入/同步时按需读取本机候选配置文件或用户显式选择的导出文件：
 * - Magpie (`~/.config/magpie/providers.json` + `plugin-providers.json`)
 * - CC Switch (`~/.cc-switch/cc-switch.db` 的 `providers` / `universal_providers` 表，及旧版 `config.json`)
 * - OpenCode (`~/.config/opencode/opencode.json[c]` + `~/.local/share/opencode/auth.json`)
 * - Claude Code (`~/.claude/settings.json`)
 * - Codex (`~/.codex/config.toml` + `~/.codex/auth.json`)
 */
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { PathsService } from '../paths/api.ts';
import type {
  ExternalConfigFileKind,
  ExternalConfigRawSource,
  ExternalConfigSourceId,
  ExternalLlmConfigsService,
  ExternalSqliteTables,
} from './api.ts';

const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SQLITE_FILE_BYTES = 64 * 1024 * 1024;
const SQLITE_HEADER_MAGIC = 'SQLite format 3\0';

export interface ExternalLlmConfigPathsOverride {
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly dataLocal: string;
  readonly temp: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueResolvedPaths(candidates: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function maskHomePrefix(targetPath: string, homeDir: string): string {
  const normalizedHome = homeDir.trim().replace(/[\\/]+$/, '');
  if (!normalizedHome) return targetPath;
  const isWin = process.platform === 'win32';
  const targetCmp = isWin ? targetPath.toLowerCase() : targetPath;
  const homeCmp = isWin ? normalizedHome.toLowerCase() : normalizedHome;
  if (targetCmp === homeCmp) return '~';
  const sep = targetPath.slice(normalizedHome.length, normalizedHome.length + 1);
  if (targetCmp.startsWith(homeCmp) && (sep === '/' || sep === '\\')) {
    return `~${targetPath.slice(normalizedHome.length).replaceAll('\\', '/')}`;
  }
  return targetPath;
}

function readRegularTextFile(filePath: string, maxBytes = MAX_TEXT_FILE_BYTES): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  if (stat.size > maxBytes) {
    throw new Error(`配置文件体积超出上限 (${stat.size} bytes)`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function hasSqliteMagicHeader(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, 16, 0);
    if (bytesRead < 16) return false;
    return header.toString('latin1') === SQLITE_HEADER_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        void closeErr;
      }
    }
  }
}

function queryCcSwitchDatabase(dbPath: string): ExternalSqliteTables {
  const db = new BetterSqlite3(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1500,
  });
  try {
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name?: unknown }>;
    const tableNames = new Set(
      tableRows
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter((name) => name !== ''),
    );

    const providers = tableNames.has('providers')
      ? (db.prepare('SELECT * FROM providers').all() as Record<string, unknown>[])
      : [];
    const universalProviders = tableNames.has('universal_providers')
      ? (db.prepare('SELECT * FROM universal_providers').all() as Record<string, unknown>[])
      : [];

    return {
      providers,
      universalProviders,
    };
  } finally {
    db.close();
  }
}

function readCcSwitchSqliteSafe(dbPath: string, tempDir: string): ExternalSqliteTables {
  const stat = fs.statSync(dbPath);
  if (!stat.isFile()) {
    throw new Error('目标数据库路径不是普通文件');
  }
  if (stat.size > MAX_SQLITE_FILE_BYTES) {
    throw new Error(`数据库文件体积超出上限 (${stat.size} bytes)`);
  }

  try {
    return queryCcSwitchDatabase(dbPath);
  } catch (directError) {
    // 当数据库所在目录只读或处于 WAL 锁竞争时，复制只读快照到临时目录再读取。
    let snapshotDir: string | null = null;
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      snapshotDir = fs.mkdtempSync(path.join(tempDir, 'ds-ext-ccswitch-'));
      const snapshotDb = path.join(snapshotDir, 'cc-switch.db');
      fs.copyFileSync(dbPath, snapshotDb);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (fs.existsSync(sidecar) && fs.statSync(sidecar).isFile()) {
          fs.copyFileSync(sidecar, `${snapshotDb}${suffix}`);
        }
      }
      return queryCcSwitchDatabase(snapshotDb);
    } catch {
      throw directError;
    } finally {
      if (snapshotDir !== null) {
        try {
          fs.rmSync(snapshotDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          void cleanupErr;
        }
      }
    }
  }
}

function resolveCcSwitchDirs(home: string, env: Readonly<Record<string, string | undefined>>): string[] {
  const defaultDir = path.join(home, '.cc-switch');
  const customDirs: string[] = [];
  const envDir = env.CC_SWITCH_CONFIG_DIR?.trim();
  if (envDir) customDirs.push(envDir);

  try {
    const settingsText = readRegularTextFile(path.join(defaultDir, 'settings.json'), 1024 * 1024);
    if (settingsText !== null) {
      const parsed = JSON.parse(settingsText) as Record<string, unknown>;
      for (const key of ['currentConfigDir', 'customConfigDir', 'configDir', 'dataDir']) {
        const val = parsed[key];
        if (typeof val === 'string' && val.trim() !== '') {
          customDirs.push(val.trim());
        }
      }
    }
  } catch (err) {
    void err;
  }

  return uniqueResolvedPaths([...customDirs, defaultDir]);
}

function inferKindFromExtension(filePath: string): ExternalConfigFileKind {
  const lower = path.extname(filePath).toLowerCase();
  if (lower === '.sql') return 'sql';
  if (lower === '.toml') return 'toml';
  if (lower === '.env') return 'env';
  return 'json';
}

function inferSourceFromPath(filePath: string): ExternalConfigSourceId {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('magpie')) return 'magpie';
  if (normalized.includes('cc-switch') || normalized.includes('ccswitch')) return 'cc-switch';
  if (normalized.includes('opencode')) return 'opencode';
  if (normalized.includes('.claude') || normalized.includes('claude')) return 'claude-code';
  if (normalized.includes('.codex') || normalized.includes('codex')) return 'codex';
  return 'custom-file';
}

export function createExternalLlmConfigsService(
  pathsOrOverride: PathsService | ExternalLlmConfigPathsOverride,
): ExternalLlmConfigsService {
  const resolveDirs = (): ExternalLlmConfigPathsOverride => {
    if ('os' in pathsOrOverride) {
      return {
        home: pathsOrOverride.os.home,
        config: pathsOrOverride.os.config,
        data: pathsOrOverride.os.data,
        dataLocal: pathsOrOverride.os.dataLocal,
        temp: pathsOrOverride.os.temp,
        env: process.env,
      };
    }
    return {
      ...pathsOrOverride,
      env: pathsOrOverride.env ?? process.env,
    };
  };

  return {
    async scanDefaultSources() {
      const dirs = resolveDirs();
      const env = dirs.env ?? {};
      const home = dirs.home;
      const sources: ExternalConfigRawSource[] = [];

      // 1. Magpie (`providers.json` + optional `plugin-providers.json`)
      const magpieDirs = uniqueResolvedPaths([
        env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'magpie') : null,
        path.join(home, '.config', 'magpie'),
        path.join(dirs.config, 'magpie'),
      ]);
      for (const dir of magpieDirs) {
        const providersPath = path.join(dir, 'providers.json');
        const pluginProvidersPath = path.join(dir, 'plugin-providers.json');
        try {
          const text = readRegularTextFile(providersPath);
          const companionText = readRegularTextFile(pluginProvidersPath);
          if (text !== null || companionText !== null) {
            sources.push({
              source: 'magpie',
              kind: 'json',
              pathLabel: maskHomePrefix(text !== null ? providersPath : pluginProvidersPath, home),
              text: text ?? '{}',
              companionText: companionText ?? null,
              sqliteTables: null,
              error: null,
            });
          }
        } catch (error) {
          sources.push({
            source: 'magpie',
            kind: 'json',
            pathLabel: maskHomePrefix(providersPath, home),
            text: null,
            companionText: null,
            sqliteTables: null,
            error: errorMessage(error),
          });
        }
      }

      // 2. CC Switch (`cc-switch.db` SQLite SSOT + legacy `config.json`)
      const ccSwitchDirs = resolveCcSwitchDirs(home, env);
      for (const dir of ccSwitchDirs) {
        const dbPath = path.join(dir, 'cc-switch.db');
        if (fs.existsSync(dbPath)) {
          try {
            const sqliteTables = readCcSwitchSqliteSafe(dbPath, dirs.temp);
            sources.push({
              source: 'cc-switch',
              kind: 'sqlite-rows',
              pathLabel: maskHomePrefix(dbPath, home),
              text: null,
              companionText: null,
              sqliteTables,
              error: null,
            });
            continue;
          } catch (error) {
            sources.push({
              source: 'cc-switch',
              kind: 'sqlite-rows',
              pathLabel: maskHomePrefix(dbPath, home),
              text: null,
              companionText: null,
              sqliteTables: null,
              error: errorMessage(error),
            });
          }
        }
        const legacyJsonPath = path.join(dir, 'config.json');
        try {
          const legacyText = readRegularTextFile(legacyJsonPath);
          if (legacyText !== null) {
            sources.push({
              source: 'cc-switch',
              kind: 'json',
              pathLabel: maskHomePrefix(legacyJsonPath, home),
              text: legacyText,
              companionText: null,
              sqliteTables: null,
              error: null,
            });
          }
        } catch (error) {
          sources.push({
            source: 'cc-switch',
            kind: 'json',
            pathLabel: maskHomePrefix(legacyJsonPath, home),
            text: null,
            companionText: null,
            sqliteTables: null,
            error: errorMessage(error),
          });
        }
      }

      // 3. OpenCode (`opencode.jsonc` / `opencode.json` + `auth.json`)
      const opencodeConfigCandidates = uniqueResolvedPaths([
        env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc') : null,
        env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json') : null,
        path.join(home, '.config', 'opencode', 'opencode.jsonc'),
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.config', 'opencode', 'config.json'),
        path.join(dirs.config, 'opencode', 'opencode.jsonc'),
        path.join(dirs.config, 'opencode', 'opencode.json'),
      ]);
      const opencodeAuthCandidates = uniqueResolvedPaths([
        env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json') : null,
        path.join(home, '.local', 'share', 'opencode', 'auth.json'),
        path.join(dirs.data, 'opencode', 'auth.json'),
        path.join(dirs.dataLocal, 'opencode', 'auth.json'),
      ]);
      let opencodeAuthText: string | null = null;
      let opencodeAuthPath: string | null = null;
      for (const authPath of opencodeAuthCandidates) {
        try {
          const content = readRegularTextFile(authPath);
          if (content !== null) {
            opencodeAuthText = content;
            opencodeAuthPath = authPath;
            break;
          }
        } catch (err) {
          void err;
        }
      }
      let opencodeConfigEmitted = false;
      for (const configPath of opencodeConfigCandidates) {
        try {
          const text = readRegularTextFile(configPath);
          if (text !== null) {
            sources.push({
              source: 'opencode',
              kind: 'json',
              pathLabel: maskHomePrefix(configPath, home),
              text,
              companionText: opencodeAuthText,
              sqliteTables: null,
              error: null,
            });
            opencodeConfigEmitted = true;
            break;
          }
        } catch (error) {
          sources.push({
            source: 'opencode',
            kind: 'json',
            pathLabel: maskHomePrefix(configPath, home),
            text: null,
            companionText: null,
            sqliteTables: null,
            error: errorMessage(error),
          });
          opencodeConfigEmitted = true;
          break;
        }
      }
      if (!opencodeConfigEmitted && opencodeAuthText !== null && opencodeAuthPath !== null) {
        sources.push({
          source: 'opencode',
          kind: 'json',
          pathLabel: maskHomePrefix(opencodeAuthPath, home),
          text: '{}',
          companionText: opencodeAuthText,
          sqliteTables: null,
          error: null,
        });
      }

      // 4. Claude Code (`~/.claude/settings.json`)
      const claudePaths = uniqueResolvedPaths([
        env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'settings.json') : null,
        path.join(home, '.claude', 'settings.json'),
      ]);
      for (const claudePath of claudePaths) {
        try {
          const text = readRegularTextFile(claudePath);
          if (text !== null) {
            sources.push({
              source: 'claude-code',
              kind: 'json',
              pathLabel: maskHomePrefix(claudePath, home),
              text,
              companionText: null,
              sqliteTables: null,
              error: null,
            });
            break;
          }
        } catch (error) {
          sources.push({
            source: 'claude-code',
            kind: 'json',
            pathLabel: maskHomePrefix(claudePath, home),
            text: null,
            companionText: null,
            sqliteTables: null,
            error: errorMessage(error),
          });
          break;
        }
      }

      // 5. Codex (`~/.codex/config.toml` + `~/.codex/auth.json`)
      const codexDirs = uniqueResolvedPaths([
        env.CODEX_HOME ?? null,
        path.join(home, '.codex'),
      ]);
      for (const codexDir of codexDirs) {
        const configTomlPath = path.join(codexDir, 'config.toml');
        const authJsonPath = path.join(codexDir, 'auth.json');
        try {
          const tomlText = readRegularTextFile(configTomlPath);
          const authText = readRegularTextFile(authJsonPath);
          if (tomlText !== null || authText !== null) {
            sources.push({
              source: 'codex',
              kind: 'toml',
              pathLabel: maskHomePrefix(tomlText !== null ? configTomlPath : authJsonPath, home),
              text: tomlText ?? '',
              companionText: authText,
              sqliteTables: null,
              error: null,
            });
            break;
          }
        } catch (error) {
          sources.push({
            source: 'codex',
            kind: 'toml',
            pathLabel: maskHomePrefix(configTomlPath, home),
            text: null,
            companionText: null,
            sqliteTables: null,
            error: errorMessage(error),
          });
          break;
        }
      }

      return {
        supported: true,
        sources,
      };
    },

    async readExternalFile(rawPath: string) {
      const dirs = resolveDirs();
      const trimmed = rawPath.trim();
      if (!trimmed) {
        throw new Error('文件路径不能为空');
      }
      const resolved = path.resolve(trimmed);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('所选配置文件不存在');
        }
        throw error;
      }
      if (!stat.isFile()) {
        throw new Error('所选路径不是有效文件');
      }

      const pathLabel = maskHomePrefix(resolved, dirs.home);
      const ext = path.extname(resolved).toLowerCase();
      const isSqlite =
        ext === '.db' || ext === '.sqlite' || ext === '.sqlite3' || hasSqliteMagicHeader(resolved);

      if (isSqlite) {
        const sqliteTables = readCcSwitchSqliteSafe(resolved, dirs.temp);
        return {
          source: 'cc-switch',
          kind: 'sqlite-rows',
          pathLabel,
          text: null,
          companionText: null,
          sqliteTables,
          error: null,
        };
      }

      if (stat.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(`配置文件体积超出上限 (${stat.size} bytes)`);
      }
      const text = fs.readFileSync(resolved, 'utf8');
      return {
        source: inferSourceFromPath(resolved),
        kind: inferKindFromExtension(resolved),
        pathLabel,
        text,
        companionText: null,
        sqliteTables: null,
        error: null,
      };
    },
  };
}
