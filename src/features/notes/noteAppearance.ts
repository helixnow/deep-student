import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  Atom,
  Bell,
  Bookmark,
  BookOpen,
  Books,
  Brain,
  Calculator,
  Calendar,
  Camera,
  Campfire,
  Cards,
  ChartBar,
  CheckSquare,
  ClipboardText,
  Clock,
  Cloud,
  Code,
  Coffee,
  Compass,
  Cpu,
  Cube,
  Dna,
  Drop,
  Exam,
  Feather,
  FileText,
  Fire,
  Flag,
  Flame,
  Flask,
  Flower,
  Folder,
  Function as FunctionIcon,
  Globe,
  GraduationCap,
  Graph,
  Headphones,
  Heart,
  Key,
  Leaf,
  Lightbulb,
  Lightning,
  Link,
  ListChecks,
  LockSimple,
  Microscope,
  Moon,
  Mountains,
  MusicNote,
  Notebook,
  Palette,
  Paperclip,
  PencilSimple,
  Planet,
  Plant,
  PushPin,
  PuzzlePiece,
  Question,
  RocketLaunch,
  Scales,
  ShieldCheck,
  Stack,
  Star,
  Sun,
  Tag,
  Target,
  Translate,
  Trophy,
  type IconProps,
} from '@phosphor-icons/react';
import { NotesAPI } from '@/utils/notesApi';

export const NOTE_APPEARANCE_PRESETS = ['standard', 'compact', 'wide'] as const;
export type NoteAppearancePreset = typeof NOTE_APPEARANCE_PRESETS[number];

/** 单色 Phosphor 图标注册表（key 为持久化 ID，继承 currentColor） */
export const NOTE_ICON_COMPONENTS: Readonly<Record<string, React.ComponentType<IconProps>>> = {
  'file-text': FileText,
  'book-open': BookOpen,
  lightbulb: Lightbulb,
  flask: Flask,
  'pencil-simple': PencilSimple,
  calculator: Calculator,
  atom: Atom,
  dna: Dna,
  microscope: Microscope,
  globe: Globe,
  compass: Compass,
  scales: Scales,
  code: Code,
  cpu: Cpu,
  brain: Brain,
  palette: Palette,
  'music-note': MusicNote,
  translate: Translate,
  'chart-bar': ChartBar,
  function: FunctionIcon,
  graph: Graph,
  notebook: Notebook,
  books: Books,
  bookmark: Bookmark,
  folder: Folder,
  'clipboard-text': ClipboardText,
  'check-square': CheckSquare,
  calendar: Calendar,
  clock: Clock,
  target: Target,
  trophy: Trophy,
  'graduation-cap': GraduationCap,
  'push-pin': PushPin,
  paperclip: Paperclip,
  question: Question,
  cards: Cards,
  exam: Exam,
  star: Star,
  lightning: Lightning,
  flame: Flame,
  flag: Flag,
  tag: Tag,
  key: Key,
  'puzzle-piece': PuzzlePiece,
  link: Link,
  'lock-simple': LockSimple,
  'shield-check': ShieldCheck,
  heart: Heart,
  bell: Bell,
  cube: Cube,
  stack: Stack,
  'list-checks': ListChecks,
  leaf: Leaf,
  plant: Plant,
  flower: Flower,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  drop: Drop,
  mountains: Mountains,
  coffee: Coffee,
  camera: Camera,
  headphones: Headphones,
  'rocket-launch': RocketLaunch,
  planet: Planet,
  feather: Feather,
  fire: Fire,
  campfire: Campfire,
};

/** 有名字的常用图标（选择器首组；'' 表示无图标） */
export const NOTE_APPEARANCE_ICONS = ['', 'file-text', 'book-open', 'lightbulb', 'flask', 'pencil-simple'] as const;

/** 页面图标选择器的其余分组（单色 Phosphor 图标，按学习场景挑选） */
export const NOTE_ICON_GROUPS: ReadonlyArray<{ key: string; icons: readonly string[] }> = [
  {
    key: 'subjects',
    icons: [
      'calculator', 'atom', 'dna', 'microscope', 'globe', 'compass', 'scales', 'code',
      'cpu', 'brain', 'palette', 'music-note', 'translate', 'chart-bar', 'function', 'graph',
    ],
  },
  {
    key: 'study',
    icons: [
      'notebook', 'books', 'bookmark', 'folder', 'clipboard-text', 'check-square', 'calendar', 'clock',
      'target', 'trophy', 'graduation-cap', 'push-pin', 'paperclip', 'question', 'cards', 'exam',
    ],
  },
  {
    key: 'symbols',
    icons: [
      'star', 'lightning', 'flame', 'flag', 'tag', 'key', 'puzzle-piece', 'link',
      'lock-simple', 'shield-check', 'heart', 'bell', 'cube', 'stack', 'list-checks',
    ],
  },
  {
    key: 'nature',
    icons: [
      'leaf', 'plant', 'flower', 'sun', 'moon', 'cloud', 'drop', 'mountains',
      'coffee', 'camera', 'headphones', 'rocket-launch', 'planet', 'feather', 'fire', 'campfire',
    ],
  },
];

export const ALL_NOTE_ICONS: readonly string[] = [
  ...NOTE_APPEARANCE_ICONS.filter(Boolean),
  ...NOTE_ICON_GROUPS.flatMap((group) => group.icons),
];

const NOTE_ICON_ID_SET = new Set<string>(Object.keys(NOTE_ICON_COMPONENTS));

/** 将页面图标 ID（含历史遗留 emoji 字符串）解析为单色 Phosphor 图标组件 */
export function resolveNoteIconComponent(icon: string): React.ComponentType<IconProps> | null {
  if (!icon) return null;
  return NOTE_ICON_COMPONENTS[icon] ?? FileText;
}

/** 渲染单色页面图标（历史遗留 emoji 值统一降级为 FileText，避免界面出现 emoji） */
export function renderNoteIcon(icon: string, size: number | string = '1em'): React.ReactNode {
  const IconComp = resolveNoteIconComponent(icon);
  if (!IconComp) return null;
  return React.createElement(IconComp, { size, 'aria-hidden': true });
}

/** 页面图标：已注册单色图标 ID、历史遗留单个 emoji（读取兼容）或 ''（无图标） */
export function isValidNoteIcon(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  if (NOTE_ICON_ID_SET.has(value)) return true;
  return value.length <= 16 && /\p{Extended_Pictographic}/u.test(value) && !/\s/.test(value);
}

/** Notion 页面菜单的三种字体风格：默认无衬线 / 衬线 / 等宽 */
export const NOTE_FONT_STYLES = ['default', 'serif', 'mono'] as const;
export type NoteFontStyle = typeof NOTE_FONT_STYLES[number];

export interface NoteAppearance {
  /** 旧版三档互斥预设；保留仅为兼容读取，排版以 smallText/fullWidth 为准 */
  preset: NoteAppearancePreset;
  icon: string;
  /** Notion「小字号」：正文 14px，版心不变 */
  smallText: boolean;
  /** Notion「全宽」：取消 708px 版心上限 */
  fullWidth: boolean;
  font: NoteFontStyle;
}

const DEFAULT_APPEARANCE: NoteAppearance = { preset: 'standard', icon: '', smallText: false, fullWidth: false, font: 'default' };

/** Display preferences, shared by every host of this note; not document metadata. */
export function noteAppearanceKey(noteId: string): string {
  return `note_appearance:${noteId}`;
}

export function parseNoteAppearance(value: string | null): NoteAppearance {
  if (!value) return DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(value);
    const preset: NoteAppearancePreset = NOTE_APPEARANCE_PRESETS.includes(parsed?.preset) ? parsed.preset : 'standard';
    return {
      preset,
      icon: isValidNoteIcon(parsed?.icon) ? parsed.icon : '',
      // 旧预设迁移：compact → 小字号、wide → 全宽；显式布尔值优先
      smallText: typeof parsed?.smallText === 'boolean' ? parsed.smallText : preset === 'compact',
      fullWidth: typeof parsed?.fullWidth === 'boolean' ? parsed.fullWidth : preset === 'wide',
      font: NOTE_FONT_STYLES.includes(parsed?.font) ? parsed.font : 'default',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

interface AppearanceSnapshot {
  value: NoteAppearance;
  loading: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
}

interface AppearanceEntry {
  snapshot: AppearanceSnapshot;
  listeners: Set<() => void>;
  loaded: boolean;
  pendingLoad?: Promise<void>;
}

const entries = new Map<string, AppearanceEntry>();
const EMPTY_SNAPSHOT: AppearanceSnapshot = {
  value: DEFAULT_APPEARANCE, loading: false, saving: false, error: null,
};

function entryFor(noteId: string): AppearanceEntry {
  let entry = entries.get(noteId);
  if (!entry) {
    entry = {
      snapshot: { ...EMPTY_SNAPSHOT, loading: true },
      listeners: new Set(),
      loaded: false,
    };
    entries.set(noteId, entry);
  }
  return entry;
}

function publish(entry: AppearanceEntry, patch: Partial<AppearanceSnapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach((listener) => listener());
}

async function loadAppearance(noteId: string): Promise<void> {
  const entry = entryFor(noteId);
  if (entry.loaded) return;
  if (entry.pendingLoad) return entry.pendingLoad;
  publish(entry, { loading: true, error: null });
  entry.pendingLoad = (async () => {
    try {
      const value = await NotesAPI.getPref(noteAppearanceKey(noteId));
      entry.loaded = true;
      publish(entry, { value: parseNoteAppearance(value), loading: false });
    } catch {
      publish(entry, { loading: false, error: 'load' });
    } finally {
      entry.pendingLoad = undefined;
    }
  })();
  return entry.pendingLoad;
}

async function saveAppearance(noteId: string, patch: Partial<NoteAppearance>): Promise<void> {
  const entry = entryFor(noteId);
  // All mounted views share this gate: no stale read or out-of-order writes.
  if (!entry.loaded || entry.snapshot.saving) return;
  if (patch.icon !== undefined && !isValidNoteIcon(patch.icon)) return;
  const value = { ...entry.snapshot.value, ...patch };
  publish(entry, { saving: true, error: null });
  try {
    const saved = await NotesAPI.setPref(noteAppearanceKey(noteId), JSON.stringify(value));
    if (!saved) throw new Error('Appearance preference was not saved');
    publish(entry, { value, saving: false });
  } catch {
    publish(entry, { saving: false, error: 'save' });
  }
}

export function useNoteAppearance(noteId: string | undefined) {
  const subscribe = useCallback((listener: () => void) => {
    if (!noteId) return () => {};
    const entry = entryFor(noteId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [noteId]);
  const getSnapshot = useCallback(
    () => noteId ? entryFor(noteId).snapshot : EMPTY_SNAPSHOT,
    [noteId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);
  useEffect(() => {
    if (noteId) void loadAppearance(noteId);
  }, [noteId]);
  return {
    ...snapshot,
    update: (patch: Partial<NoteAppearance>) => noteId ? saveAppearance(noteId, patch) : Promise.resolve(),
    reload: () => noteId ? loadAppearance(noteId) : Promise.resolve(),
  };
}

/**
 * 只读订阅页面图标（标签/侧栏/面包屑等处渲染对应单色 Phosphor 图标）。
 * load=false 时只读已加载的缓存不发请求——供长列表在行进入视口后再置 true。
 */
export function useNoteIcon(noteId: string | undefined, load = true): React.ReactNode {
  const subscribe = useCallback((listener: () => void) => {
    if (!noteId) return () => {};
    const entry = entryFor(noteId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [noteId]);
  const icon = useSyncExternalStore(
    subscribe,
    () => (noteId ? entryFor(noteId).snapshot.value.icon : ''),
    () => '',
  );
  useEffect(() => {
    if (noteId && load) void loadAppearance(noteId);
  }, [noteId, load]);
  return icon ? renderNoteIcon(icon, '1em') : null;
}
