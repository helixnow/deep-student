/**
 * 记忆系统文件夹的显示名本地化（仅显示层）。
 *
 * 记忆服务（src-tauri/src/memory/**）以固定中文标题在 VFS `folders` 表中建目录：
 * 根目录「记忆」（config.rs DEFAULT_FOLDER_TITLE）、种子分类（category_manager.rs
 * SEED_CATEGORIES）、提取提示词/技能里的标准分类路径（auto_extractor.rs、
 * vfs-memory.ts、dstu-memory-orchestrator.ts）、每日学习日志（daily_log.rs）与
 * 画像目录 `__system__`（learner_profile.rs）。智能体工具按这些中文路径段寻址，
 * 所以**存储名不能改**；这里只在 UI 渲染时把已知系统名映射成当前语言的标签。
 *
 * 模型自由命名的子目录（提示词允许"使用新的分类路径"）不在映射表内，原样显示。
 * 只有位于记忆根目录之内的文件夹才做映射，避免误译用户自建的同名普通文件夹。
 * 重命名等编辑入口必须继续使用存储名。
 */
import type { TFunction } from 'i18next';

/** 记忆根目录默认标题（与 config.rs DEFAULT_FOLDER_TITLE 一致） */
export const MEMORY_ROOT_DEFAULT_TITLE = '记忆';

/** 系统定义的记忆文件夹存储名 → i18n 键（learningHub:memoryFolders.*） */
const MEMORY_FOLDER_LABEL_KEYS: Readonly<Record<string, string>> = {
  [MEMORY_ROOT_DEFAULT_TITLE]: 'root',
  偏好: 'preferences',
  个人背景: 'personalBackground',
  工作环境: 'workEnvironment',
  经历: 'experience',
  学科状态: 'subjectStatus',
  时间节点: 'keyDates',
  项目: 'projects',
  学习日志: 'studyLog',
  __system__: 'system',
};

/** 系统定义的记忆文件夹存储名列表（测试/文档用） */
export const MEMORY_SYSTEM_FOLDER_TITLES: readonly string[] = Object.keys(MEMORY_FOLDER_LABEL_KEYS);

/** 已知系统名 → 完整 i18n 键；非系统名返回 null */
export function getMemoryFolderLabelKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const key = MEMORY_FOLDER_LABEL_KEYS[title.trim()];
  return key ? `learningHub:memoryFolders.${key}` : null;
}

/** 本地化单个记忆文件夹标题（调用方需已确认该文件夹位于记忆根目录内） */
export function localizeMemoryFolderTitle(title: string, t: TFunction): string {
  const key = getMemoryFolderLabelKey(title);
  if (!key) return title;
  return String(t(key, { defaultValue: title }));
}

/** 本地化记忆相对路径（如 `经历/学科状态`），逐段映射，分隔符保持原样 */
export function localizeMemoryFolderPath(path: string, t: TFunction): string {
  if (!path) return path;
  return path
    .split(/(\s*[/／]\s*)/)
    .map((part, index) => (index % 2 === 1 ? part : localizeMemoryFolderTitle(part, t)))
    .join('');
}

export interface MemoryRootRef {
  /** 记忆根文件夹 ID（来自 memory_get_config） */
  id?: string | null;
  /** 记忆根文件夹标题（来自 memory_get_config；缺省回退默认标题） */
  title?: string | null;
}

function rootTitleOf(root: MemoryRootRef | null | undefined): string {
  return root?.title?.trim() || MEMORY_ROOT_DEFAULT_TITLE;
}

/**
 * 根据完整层级路径（DstuNode 文件夹 path，如 `/记忆/经历`）判断是否位于记忆根目录内。
 * 仅在拿不到祖先 ID 链时使用：要求首段等于记忆根标题。
 */
export function isPathInMemoryRoot(path: string | null | undefined, root?: MemoryRootRef | null): boolean {
  if (!path) return false;
  const first = path.split('/').map((segment) => segment.trim()).find(Boolean);
  return first === rootTitleOf(root);
}

/**
 * 判断文件夹是否是记忆根目录：优先按 ID；拿不到配置或文件夹无 ID 时，
 * 仅对顶层文件夹按记忆根标题回退。
 */
export function isMemoryRootFolder(
  folder: { id?: string | null; title: string },
  root?: MemoryRootRef | null,
  options?: { topLevel?: boolean },
): boolean {
  // 合成（按路径聚合、无 VFS id）的文件夹无法按 ID 比对，回退标题判定
  if (root?.id && folder.id) return folder.id === root.id;
  return options?.topLevel !== false && folder.title.trim() === rootTitleOf(root);
}

/**
 * 本地化面包屑：从记忆根目录（含）开始的各段若为系统名则翻译。
 * 记忆根 ID 未知时，回退为"首段标题等于记忆根标题"。
 */
export function localizeMemoryBreadcrumbs<T extends { id: string; name: string }>(
  crumbs: readonly T[],
  root: MemoryRootRef | null | undefined,
  t: TFunction,
): T[] {
  let inMemory = false;
  let changed = false;
  const next = crumbs.map((crumb, index) => {
    if (!inMemory) {
      inMemory = root?.id
        ? crumb.id === root.id
        : index === 0 && crumb.name.trim() === rootTitleOf(root);
    }
    if (!inMemory) return crumb;
    const name = localizeMemoryFolderTitle(crumb.name, t);
    if (name === crumb.name) return crumb;
    changed = true;
    return { ...crumb, name };
  });
  return changed ? next : (crumbs as T[]);
}
