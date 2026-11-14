/**
 * 移动端技能路径：桌面 `files.ts` 的路径语义在 OPFS 上的对应实现。
 *
 * 桌面允许的技能根来自 `buildAllowedSkillsBases`（`~/.deep-student/skills`、`<appData>/.skills`、
 * 项目内 `.skills` / `.agents/skills` / `.claude/skills` / `.github/skills` 等）。移动端没有
 * 工作目录，也没有 `<data>/ds91/skills`，这些根全部折叠到同一个目录
 * `<ctx.paths.appDataDir>/skills`，因此前端传 `~/.deep-student/skills`、`.skills` 或
 * `<appData>/.skills` 都会落到同一份技能上：卸载重装、切窗口前后读到的是同一批目录。
 *
 * 校验只有一道词法包含判断：OPFS 没有符号链接，词法路径就是真实路径（见 `platform/files/opfs.ts`）。
 * 错误文案与桌面 `fail()` 一致，前端按 `Invalid input: …` / `IO error: …` 前缀分流。
 */
import { posix } from '../../../../platform/util/path.ts';

export const SKILLS_DIR_NAME = 'skills';
export const MARKET_TEMP_SUBDIR = 'temp/skill-market';

/** 相对路径别名：桌面会按工作目录展开，移动端统一落到技能根。 */
const RELATIVE_ALIASES = ['.skills', '.agents/skills', '.claude/skills', '.github/skills', 'skills-cursor'];

/** 桌面绝对技能根（`~` 展开后的形状），移动端同样折叠到技能根。 */
const ABSOLUTE_ALIASES = ['.deep-student/skills', '.skills', 'skills'];

export { debugPath, fail, type FailCode } from '../errors-core.ts';
import { debugPath, fail } from '../errors-core.ts';

/** 只做词法规范化：消掉 `.`、`..` 与重复分隔符，保留绝对性。 */
export function normalizePosix(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const component of value.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') { parts.pop(); continue; }
    parts.push(component);
  }
  const joined = parts.join('/');
  return absolute ? `/${joined}` : joined;
}

/** `Path::starts_with`：按组件比较，大小写敏感。 */
export function isWithin(value: string, base: string): boolean {
  const normalized = normalizePosix(value);
  const parent = normalizePosix(base);
  return normalized === parent || normalized.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

export interface MobileSkillPathsOptions {
  appDataDir: string;
  /** 桌面 `~`（移动端 `ctx.paths.os.home` 就是 appDataDir）。 */
  home: string;
  logger?: { warn?(message: string): void };
}

export class MobileSkillPaths {
  readonly appDataDir: string;
  readonly home: string;
  readonly skillsDir: string;
  readonly marketTempDir: string;
  private readonly logger: { warn?(message: string): void };

  constructor(options: MobileSkillPathsOptions) {
    this.appDataDir = normalizePosix(options.appDataDir);
    this.home = normalizePosix(options.home);
    this.skillsDir = posix.join(this.appDataDir, SKILLS_DIR_NAME);
    this.marketTempDir = posix.join(this.appDataDir, MARKET_TEMP_SUBDIR);
    this.logger = options.logger ?? {};
  }

  /** 唯一的允许技能根（桌面 `getAllowedSkillsBases()`）。 */
  getAllowedSkillsBases(): string[] {
    return [this.skillsDir];
  }

  /** `~` / `~/...` 展开成绝对路径；其余原样返回。 */
  expandHome(raw: string): string {
    const value = raw.trim();
    if (value === '~') return this.home;
    if (value.startsWith('~/')) return posix.join(this.home, value.slice(2));
    return value;
  }

  /** 技能命令的路径展开：`~` 展开后，把桌面的各个技能根折叠到 {@link skillsDir}。 */
  expandSkillPath(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return this.skillsDir;
    const expanded = this.expandHome(trimmed);
    if (!posix.isAbsolute(expanded)) {
      const normalized = normalizePosix(expanded);
      if (RELATIVE_ALIASES.some(alias => normalized === alias || normalized.startsWith(`${alias}/`))) {
        return this.skillsDir;
      }
      return posix.join(this.skillsDir, normalized);
    }
    const normalized = normalizePosix(expanded);
    for (const alias of ABSOLUTE_ALIASES) {
      const absolute = posix.join(this.appDataDir, alias);
      if (normalized === absolute) return this.skillsDir;
    }
    return normalized;
  }

  /** `validate_path`：不在技能根内就拒绝，并给出与桌面一致的文案。 */
  validateSkillPath(raw: string): string {
    const value = this.expandSkillPath(raw);
    const bases = this.getAllowedSkillsBases();
    if (bases.some(base => isWithin(value, base))) return value;
    this.logger.warn?.(`[Skills] 路径遍历检测: ${debugPath(raw)} 不在允许的目录范围内`);
    fail('INVALID_INPUT',
      `Path traversal detected: ${debugPath(value)} is not within allowed skills directories. Allowed bases: [${bases.map(debugPath).join(', ')}]`);
  }

  /** 非技能类目标（导出 zip、市场临时包）：只展开，范围由 `ctx.files` 的允许根兜底。 */
  expandForFiles(raw: string): string {
    return this.expandHome(raw);
  }
}
