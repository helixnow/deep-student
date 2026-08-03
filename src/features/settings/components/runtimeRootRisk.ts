/**
 * Authorized runtime root 高风险目录检测（纯前端字符串判断）
 *
 * 对标 另一桌面代理实现 `<personal_files_safety>` 的转译（对齐调研第三十二节 A4 项）：
 * 硬边界仍由 runtime root + 审批承担，这里只在 Settings 授权目录时做行为质量层的
 * 内联警示，不做任何拦截。
 *
 * 判定规则（大小写不敏感，兼容 Windows 反斜杠）：
 * - critical：盘符根（C:\、D:/）、文件系统根（/）、用户主目录本身
 *   （~、C:\Users\<name>、/home/<name>、/Users/<name>）及其父级（C:\Users、/home）。
 * - broad：路径末段是 Desktop/Downloads/Documents/桌面/下载/文档 之一，
 *   且深度较浅（去掉盘符/~ 后不超过 3 段），即授权的就是这些个人目录本身。
 * - safe：其余路径，包括上述目录的深层子目录（如 Documents/学习资料/高数）。
 */

export type AuthorizedRootRisk = 'safe' | 'broad' | 'critical';

/** 常见个人文件目录名（末段精确匹配，大小写不敏感） */
const BROAD_FOLDER_NAMES = new Set([
  'desktop',
  'downloads',
  'documents',
  '桌面',
  '下载',
  '文档',
]);

/** 主目录的容器目录名：C:\Users\<name>、/home/<name>、/Users/<name> */
const HOME_PARENT_NAMES = new Set(['users', 'home']);

/** 授权路径最深多少段以内、末段命中个人目录名才算 broad */
const BROAD_MAX_DEPTH = 3;

export function assessAuthorizedRootRisk(rawPath: string): AuthorizedRootRisk {
  const trimmed = rawPath.trim();
  if (!trimmed) return 'safe';

  const normalized = trimmed.replace(/\\/g, '/');
  const hasDrive = /^[a-zA-Z]:/.test(normalized);
  const isRooted = hasDrive || normalized.startsWith('/');
  const body = hasDrive ? normalized.slice(2) : normalized;

  let segments = body.split('/').filter((seg) => seg.length > 0 && seg !== '.');

  // ~ 开头视为用户主目录
  const startsWithHomeTilde = segments[0] === '~';
  if (startsWithHomeTilde) {
    segments = segments.slice(1);
    if (segments.length === 0) return 'critical';
  }

  // 盘符根 C:\、D:/ 或文件系统根 /
  if (segments.length === 0) {
    return isRooted ? 'critical' : 'safe';
  }

  const lowerSegments = segments.map((seg) => seg.toLowerCase());

  if (!startsWithHomeTilde) {
    // C:\Users、/home（所有主目录的父级）与 C:\Users\<name>、/home/<name>（主目录本身）
    if (HOME_PARENT_NAMES.has(lowerSegments[0]) && segments.length <= 2) {
      return 'critical';
    }
    // Linux root 用户主目录 /root
    if (lowerSegments[0] === 'root' && segments.length === 1) {
      return 'critical';
    }
  }

  const lastSegment = lowerSegments[lowerSegments.length - 1];
  if (BROAD_FOLDER_NAMES.has(lastSegment) && segments.length <= BROAD_MAX_DEPTH) {
    return 'broad';
  }

  return 'safe';
}
