import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Archive,
  ArrowSquareOut,
  Atom,
  BookOpen,
  BookmarkSimple,
  Brain,
  Calculator,
  CalendarBlank,
  Camera,
  Cards,
  Chat,
  Check,
  CircleNotch,
  ClipboardText,
  Clock,
  Code,
  File as FileIcon,
  FileText,
  Flask,
  Folder,
  FolderOpen,
  FolderSimple,
  Gauge,
  Globe,
  GraduationCap,
  Heart,
  Image as ImageIcon,
  Layout,
  Lightbulb,
  Lightning,
  LinkBreak,
  LinkSimple,
  ListChecks,
  MusicNote,
  Palette,
  Paperclip,
  PenNib,
  Plus,
  Rocket,
  Sparkle,
  Star,
  Target,
  Terminal,
  TextAlignLeft,
  Translate,
  Trophy,
  X,
} from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog } from '@/components/ui/DsDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { dstu } from '@/dstu';
import { LearningHubSidebar } from '@/features/learning-hub';
import { FINDER_HOST_IDS } from '@/features/learning-hub/stores/finderStore';
import type { ResourceListItem } from '@/features/learning-hub/types';
import { SpaceMountPickerDialog } from '@/components/study-space/SpaceMountPickerDialog';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
import {
  STUDY_SPACE_DEFAULTS,
  inferLegacyRootFolderId,
  type StudySpaceMemoryScope,
  type StudySpaceMount,
  type WorkbenchLayoutPreset,
} from '@/shared/study-space/types';
import {
  formatSpaceCountdown,
  stripEmojiText,
} from '@/shared/study-space/spaceCountdown';
import { openSpaceFolderInHub } from '@/components/study-space/studySpaceActions';
import type { AnkiLibraryDeckCount } from '@/types';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { isMobilePlatform } from '@/utils/platform';
import { configureTaskWorkspace } from '../../api/taskWorkspaceApi';
import { getResourceRefsV2 } from '../../context/vfsRefApi';
import type { VfsResourceRef } from '../../context/vfsRefTypes';
import { skillRegistry, subscribeToSkillRegistry } from '../../skills/registry';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../../types/group';

interface RuntimeRootEntry {
  id: string;
  kind: string;
  path: string;
  access: 'read_only' | 'read_write' | string;
  label: string;
  description?: string;
  session_scoped?: boolean;
  configured?: boolean;
}

type EditorTabId = 'general' | 'goals' | 'workspace';

const DAILY_BUDGET_PRESETS = [25, 45, 90, 120] as const;
const RETENTION_PRESETS = ['0.85', '0.90', '0.93', '0.95'] as const;
const EMPTY_MOUNTS: StudySpaceMount[] = [];
const WORKBENCH_LAYOUT_PRESET_IDS: readonly WorkbenchLayoutPreset[] = [
  'chat_focus',
  'split_reader_chat',
  'split_notes_chat',
  'practice_review',
  'freeform_desktop',
] as const;

const RESOURCE_TYPE_ICONS: Readonly<Record<string, React.ElementType>> = {
  note: FileText,
  textbook: BookOpen,
  exam: ClipboardText,
  translation: Translate,
  essay: PenNib,
  image: ImageIcon,
  mindmap: Brain,
  todo: ListChecks,
  file: FileIcon,
  folder: FolderSimple,
};

export function getResourceTypeIcon(type: string): React.ElementType {
  return Object.hasOwn(RESOURCE_TYPE_ICONS, type) ? RESOURCE_TYPE_ICONS[type] : FileIcon;
}

export const PRESET_ICONS = [
  { name: 'folder', Icon: Folder },
  { name: 'folder-open', Icon: FolderOpen },
  { name: 'star', Icon: Star },
  { name: 'heart', Icon: Heart },
  { name: 'book-open', Icon: BookOpen },
  { name: 'graduation-cap', Icon: GraduationCap },
  { name: 'code', Icon: Code },
  { name: 'calculator', Icon: Calculator },
  { name: 'flask', Icon: Flask },
  { name: 'atom', Icon: Atom },
  { name: 'globe', Icon: Globe },
  { name: 'languages', Icon: Translate },
  { name: 'music', Icon: MusicNote },
  { name: 'palette', Icon: Palette },
  { name: 'camera', Icon: Camera },
  { name: 'lightbulb', Icon: Lightbulb },
  { name: 'target', Icon: Target },
  { name: 'trophy', Icon: Trophy },
  { name: 'rocket', Icon: Rocket },
  { name: 'brain', Icon: Brain },
  { name: 'sparkles', Icon: Sparkle },
  { name: 'message-square', Icon: Chat },
  { name: 'file-text', Icon: FileText },
  { name: 'bookmark', Icon: BookmarkSimple },
];

export const PRESET_COLORS = [
  { name: 'slate', value: '#64748b' },
  { name: 'gray', value: '#6b7280' },
  { name: 'red', value: '#ef4444' },
  { name: 'rose', value: '#f43f5e' },
  { name: 'pink', value: '#ec4899' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'green', value: '#22c55e' },
  { name: 'emerald', value: '#10b981' },
  { name: 'teal', value: '#14b8a6' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'indigo', value: '#6366f1' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'purple', value: '#a855f7' },
];

export const groupEditorSubmitRef: React.MutableRefObject<(() => void) | null> = {
  current: null,
};

export interface GroupEditorPanelProps {
  mode: 'create' | 'edit';
  initial?: SessionGroup | null;
  autoFocusField?: 'name' | null;
  onSubmit: (payload: CreateGroupRequest | UpdateGroupRequest) => Promise<SessionGroup | void>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onArchive?: () => void;
  onMobileBrowse?: (
    toggleResource: (sourceId: string) => 'added' | 'removed' | false,
    currentIds: string[],
  ) => void;
  embeddedInDialog?: boolean;
}

const PropertyRow: React.FC<{
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
  mobileStacked?: boolean;
}> = ({ icon: Icon, label, children, className, mobileStacked }) => (
  <div
    className={cn(
      'group grid items-start py-2',
      mobileStacked
        ? 'grid-cols-1 md:grid-cols-[150px_1fr]'
        : 'grid-cols-[110px_1fr] md:grid-cols-[150px_1fr]',
      className,
    )}
  >
    <div
      className={cn(
        'flex items-center gap-2 text-sm text-muted-foreground/85',
        mobileStacked ? 'mb-2 md:mb-0 min-h-[auto] md:min-h-[36px]' : 'min-h-[36px]',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span>{label}</span>
    </div>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

function sanitizeIconToken(rawIcon: string | undefined): string {
  if (!rawIcon) return '';
  const trimmed = rawIcon.trim();
  return PRESET_ICONS.some((item) => item.name === trimmed) ? trimmed : '';
}

export const GroupEditorPanel: React.FC<GroupEditorPanelProps> = ({
  mode,
  initial,
  autoFocusField = null,
  onSubmit,
  onClose,
  onDirtyChange,
  onArchive,
  onMobileBrowse,
  embeddedInDialog = false,
}) => {
  const { t } = useTranslation(['chatV2', 'common', 'skills']);
  const [activeTab, setActiveTab] = useState<EditorTabId>('general');

  // General & Prompt state
  const [name, setName] = useState('');
  // 只在用户碰过名称输入框之后才提示必填，避免打开对话框就红一片
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSkillIds, setDefaultSkillIds] = useState<string[]>([]);
  const [pinnedResourceIds, setPinnedResourceIds] = useState<string[]>([]);
  const [resolvedPinnedRefs, setResolvedPinnedRefs] = useState<VfsResourceRef[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [defaultRuntimeRootId, setDefaultRuntimeRootId] = useState('');
  const [preferredProjectRootPath, setPreferredProjectRootPath] = useState('');
  const [runtimeRoots, setRuntimeRoots] = useState<RuntimeRootEntry[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [isAuthorizingRoot, setIsAuthorizingRoot] = useState(false);
  const [rootFolderItemCount, setRootFolderItemCount] = useState<number | null>(null);

  // Study Space Goals & Workspace state
  const [examDate, setExamDate] = useState<string | null>(null);
  const [dailyBudgetMinutes, setDailyBudgetMinutes] = useState<number>(
    STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
  );
  const [targetRetention, setTargetRetention] = useState<number>(
    STUDY_SPACE_DEFAULTS.targetRetention,
  );
  const [defaultDeckId, setDefaultDeckId] = useState<string | null>(null);
  const [availableDecks, setAvailableDecks] = useState<AnkiLibraryDeckCount[]>([]);
  const [memoryScope, setMemoryScope] = useState<StudySpaceMemoryScope>(
    STUDY_SPACE_DEFAULTS.memoryScope,
  );
  const [workbenchLayoutPreset, setWorkbenchLayoutPreset] = useState<WorkbenchLayoutPreset>(
    STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
  );
  const [mountPickerOpen, setMountPickerOpen] = useState(false);
  const [mountTitlesById, setMountTitlesById] = useState<Record<string, string>>({});

  // Baseline snapshot for accurate dirty tracking across all 3 tabs
  const [loadedProfileBaseline, setLoadedProfileBaseline] = useState<{
    examDate: string | null;
    dailyBudgetMinutes: number;
    targetRetention: number;
    defaultDeckId: string | null;
    memoryScope: StudySpaceMemoryScope;
    workbenchLayoutPreset: WorkbenchLayoutPreset;
  }>({
    examDate: null,
    dailyBudgetMinutes: STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
    targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
    defaultDeckId: null,
    memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
    workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
  });

  const storeProfile = useStudySpaceStore((s) =>
    initial?.id ? s.profilesBySpaceId[initial.id] : undefined,
  );
  const storeMounts = useStudySpaceStore((s) =>
    initial?.id ? s.mountsBySpaceId[initial.id] ?? EMPTY_MOUNTS : EMPTY_MOUNTS,
  );
  const unmountItemFromSpace = useStudySpaceStore((s) => s.unmountItemFromSpace);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const touchedProfileFieldsRef = useRef<Set<string>>(new Set());

  const updateExamDate = useCallback((val: string | null) => {
    touchedProfileFieldsRef.current.add('examDate');
    setExamDate(val);
  }, []);

  const updateDailyBudgetMinutes = useCallback((val: number) => {
    touchedProfileFieldsRef.current.add('dailyBudgetMinutes');
    setDailyBudgetMinutes(val);
  }, []);

  const updateTargetRetention = useCallback((val: number) => {
    touchedProfileFieldsRef.current.add('targetRetention');
    setTargetRetention(val);
  }, []);

  const updateDefaultDeckId = useCallback((val: string | null) => {
    touchedProfileFieldsRef.current.add('defaultDeckId');
    setDefaultDeckId(val);
  }, []);

  const updateMemoryScope = useCallback((val: StudySpaceMemoryScope) => {
    touchedProfileFieldsRef.current.add('memoryScope');
    setMemoryScope(val);
  }, []);

  const updateWorkbenchLayoutPreset = useCallback((val: WorkbenchLayoutPreset) => {
    touchedProfileFieldsRef.current.add('workbenchLayoutPreset');
    setWorkbenchLayoutPreset(val);
  }, []);

  const resolvedRootFolderId = useMemo(() => {
    if (mode !== 'edit' || !initial) return '';
    return (
      storeProfile?.rootFolderId?.trim() ||
      inferLegacyRootFolderId(initial) ||
      ''
    );
  }, [initial, mode, storeProfile?.rootFolderId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [systemPrompt, activeTab]);

  useEffect(() => {
    if (autoFocusField !== 'name') return;
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusField, initial?.id, mode]);

  useEffect(() => {
    touchedProfileFieldsRef.current.clear();
    setActiveTab('general');
    if (mode === 'edit' && initial) {
      setName(stripEmojiText(initial.name) || initial.name);
      setDescription(initial.description ?? '');
      setIcon(sanitizeIconToken(initial.icon));
      setColor(initial.color ?? '');
      setSystemPrompt(initial.systemPrompt ?? '');
      setDefaultSkillIds(initial.defaultSkillIds ?? []);
      setPinnedResourceIds(initial.pinnedResourceIds ?? []);
      setDefaultRuntimeRootId(initial.defaultRuntimeRootId ?? '');
      setPreferredProjectRootPath(initial.preferredProjectRootPath ?? '');

      const cachedProfile = useStudySpaceStore.getState().profilesBySpaceId[initial.id];
      const nextBaseline = {
        examDate: cachedProfile?.examDate ?? null,
        dailyBudgetMinutes:
          cachedProfile?.dailyBudgetMinutes ?? STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
        targetRetention:
          cachedProfile?.targetRetention ?? STUDY_SPACE_DEFAULTS.targetRetention,
        defaultDeckId: cachedProfile?.defaultDeckId ?? null,
        memoryScope: cachedProfile?.memoryScope ?? STUDY_SPACE_DEFAULTS.memoryScope,
        workbenchLayoutPreset:
          cachedProfile?.workbenchLayoutPreset ??
          STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
      };
      setExamDate(nextBaseline.examDate);
      setDailyBudgetMinutes(nextBaseline.dailyBudgetMinutes);
      setTargetRetention(nextBaseline.targetRetention);
      setDefaultDeckId(nextBaseline.defaultDeckId);
      setMemoryScope(nextBaseline.memoryScope);
      setWorkbenchLayoutPreset(nextBaseline.workbenchLayoutPreset);
      setLoadedProfileBaseline(nextBaseline);

      let cancelled = false;
      useStudySpaceStore.getState().refreshStudySpace(initial.id, initial)
        .then((freshProfile) => {
          if (cancelled) return;
          if (freshProfile) {
            const synced = {
              examDate: freshProfile.examDate,
              dailyBudgetMinutes: freshProfile.dailyBudgetMinutes,
              targetRetention: freshProfile.targetRetention,
              defaultDeckId: freshProfile.defaultDeckId,
              memoryScope: freshProfile.memoryScope,
              workbenchLayoutPreset: freshProfile.workbenchLayoutPreset,
            };
            const touched = touchedProfileFieldsRef.current;
            if (!touched.has('examDate')) setExamDate(synced.examDate);
            if (!touched.has('dailyBudgetMinutes')) {
              setDailyBudgetMinutes(synced.dailyBudgetMinutes);
            }
            if (!touched.has('targetRetention')) {
              setTargetRetention(synced.targetRetention);
            }
            if (!touched.has('defaultDeckId')) setDefaultDeckId(synced.defaultDeckId);
            if (!touched.has('memoryScope')) setMemoryScope(synced.memoryScope);
            if (!touched.has('workbenchLayoutPreset')) {
              setWorkbenchLayoutPreset(synced.workbenchLayoutPreset);
            }
            setLoadedProfileBaseline(synced);
          }
        })
        .catch(() => undefined);

      return () => {
        cancelled = true;
      };
    }

    setName('');
    setDescription('');
    setIcon('');
    setColor('');
    setSystemPrompt('');
    setDefaultSkillIds([]);
    setPinnedResourceIds([]);
    setResolvedPinnedRefs([]);
    setDefaultRuntimeRootId('');
    setPreferredProjectRootPath('');
    const defaultBaseline = {
      examDate: null,
      dailyBudgetMinutes: STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
      targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
      defaultDeckId: null,
      memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
      workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
    };
    setExamDate(defaultBaseline.examDate);
    setDailyBudgetMinutes(defaultBaseline.dailyBudgetMinutes);
    setTargetRetention(defaultBaseline.targetRetention);
    setDefaultDeckId(defaultBaseline.defaultDeckId);
    setMemoryScope(defaultBaseline.memoryScope);
    setWorkbenchLayoutPreset(defaultBaseline.workbenchLayoutPreset);
    setLoadedProfileBaseline(defaultBaseline);
    return undefined;
  }, [initial, mode]);

  // Load VFS root folder item count in edit mode
  useEffect(() => {
    if (!resolvedRootFolderId) {
      setRootFolderItemCount(null);
      return;
    }
    let cancelled = false;
    dstu
      .list(`/${resolvedRootFolderId}`)
      .then((res) => {
        if (!cancelled && res && res.ok) {
          setRootFolderItemCount(res.value.length);
        }
      })
      .catch(() => {
        if (!cancelled) setRootFolderItemCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedRootFolderId, storeMounts.length]);

  // Load Anki/FSRS decks when goals tab is opened (or eagerly in background)
  useEffect(() => {
    let cancelled = false;
    listAnkiLibraryCards({ page: 1, page_size: 1, include_decks: true })
      .then((res) => {
        if (!cancelled && Array.isArray(res?.decks)) {
          setAvailableDecks(res.decks.filter((deckItem) => Boolean(deckItem.name)));
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableDecks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve titles for mounted resources
  useEffect(() => {
    if (storeMounts.length === 0) {
      setMountTitlesById({});
      return;
    }
    let cancelled = false;
    const ids = storeMounts.map((m) => m.itemId);
    getResourceRefsV2(ids)
      .then((res) => {
        if (cancelled || !res.ok) return;
        const map: Record<string, string> = {};
        for (const ref of res.value.refs) {
          if (ref.name) map[ref.sourceId] = stripEmojiText(ref.name) || ref.name;
        }
        setMountTitlesById(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storeMounts]);

  const loadRuntimeRoots = useCallback(async () => {
    setRootsLoading(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_list_runtime_roots');
      setRuntimeRoots((roots ?? []).filter((root) => !root.session_scoped));
    } catch {
      setRuntimeRoots([]);
    } finally {
      setRootsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntimeRoots();
  }, [loadRuntimeRoots]);

  useEffect(() => {
    if (pinnedResourceIds.length === 0) {
      setResolvedPinnedRefs([]);
      return;
    }
    let cancelled = false;
    setPinnedLoading(true);
    getResourceRefsV2(pinnedResourceIds)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setResolvedPinnedRefs(result.value.refs);
        } else {
          setResolvedPinnedRefs(
            pinnedResourceIds.map((id) => ({
              sourceId: id,
              resourceHash: '',
              type: 'file' as const,
              name: id,
            })),
          );
        }
        setPinnedLoading(false);
      })
      .catch(() => {
        if (!cancelled) setPinnedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pinnedResourceIds]);

  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const skillList = useMemo(() => {
    void registryVersion;
    return skillRegistry.getAll().sort((a, b) => a.name.localeCompare(b.name));
  }, [registryVersion]);

  const pinnedHighlightSet = useMemo(() => new Set(pinnedResourceIds), [pinnedResourceIds]);

  const togglePinnedResource = useCallback(
    (sourceId: string): 'added' | 'removed' | false => {
      const trimmed = sourceId.trim();
      if (!trimmed) return false;
      const box = { result: 'added' as 'added' | 'removed' };
      setPinnedResourceIds((prev) => {
        if (prev.includes(trimmed)) {
          box.result = 'removed';
          return prev.filter((id) => id !== trimmed);
        }
        return [...prev, trimmed];
      });
      if (box.result === 'removed') {
        setResolvedPinnedRefs((prev) => prev.filter((r) => r.sourceId !== trimmed));
      }
      return box.result;
    },
    [],
  );

  const removePinnedResource = useCallback((sourceId: string) => {
    setPinnedResourceIds((prev) => prev.filter((id) => id !== sourceId));
    setResolvedPinnedRefs((prev) => prev.filter((r) => r.sourceId !== sourceId));
  }, []);

  const toggleSkill = useCallback((skillId: string) => {
    setDefaultSkillIds((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId],
    );
  }, []);

  const bindRuntimeRoot = useCallback((root: RuntimeRootEntry) => {
    setDefaultRuntimeRootId(root.id);
    setPreferredProjectRootPath(root.path);
  }, []);

  const clearRuntimeRoot = useCallback(() => {
    setDefaultRuntimeRootId('');
    setPreferredProjectRootPath('');
  }, []);

  const handleSelectRuntimeRoot = useCallback(
    (rootId: string) => {
      if (!rootId) {
        clearRuntimeRoot();
        return;
      }
      const root = runtimeRoots.find((entry) => entry.id === rootId);
      if (root) {
        bindRuntimeRoot(root);
        return;
      }
      setDefaultRuntimeRootId(rootId);
    },
    [bindRuntimeRoot, clearRuntimeRoot, runtimeRoots],
  );

  const handleBrowseAndAuthorizeRoot = useCallback(async () => {
    if (isAuthorizingRoot) return;
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: t('page.groupDefaultRuntimeRootBrowseTitle'),
      });
      if (typeof selected !== 'string' || !selected.trim()) return;

      setIsAuthorizingRoot(true);
      const roots = await configureTaskWorkspace(selected.trim());
      const nextRoots = (roots ?? []).filter((root) => !root.session_scoped);
      setRuntimeRoots(nextRoots);
      const matched = nextRoots.find(
        (root) => root.id === 'workspace' && root.access === 'read_write',
      );
      if (matched) {
        bindRuntimeRoot(matched);
      }
    } catch (err: unknown) {
      console.error('[GroupEditorPanel] Authorize runtime root failed:', getErrorMessage(err));
      showGlobalNotification('error', t('page.groupDefaultRuntimeRootAuthorizeFailed'));
    } finally {
      setIsAuthorizingRoot(false);
    }
  }, [bindRuntimeRoot, isAuthorizingRoot, t]);

  const selectedRuntimeRootPath = useMemo(() => {
    if (preferredProjectRootPath.trim()) return preferredProjectRootPath.trim();
    const matched = runtimeRoots.find((root) => root.id === defaultRuntimeRootId);
    return matched?.path ?? '';
  }, [defaultRuntimeRootId, preferredProjectRootPath, runtimeRoots]);

  const isDirty = useMemo(() => {
    const baseline =
      mode === 'edit' && initial
        ? {
            name: stripEmojiText(initial.name) || initial.name,
            description: initial.description ?? '',
            icon: sanitizeIconToken(initial.icon),
            color: initial.color ?? '',
            systemPrompt: initial.systemPrompt ?? '',
            defaultSkillIds: initial.defaultSkillIds ?? [],
            pinnedResourceIds: initial.pinnedResourceIds ?? [],
            defaultRuntimeRootId: initial.defaultRuntimeRootId ?? '',
            preferredProjectRootPath: initial.preferredProjectRootPath ?? '',
          }
        : {
            name: '',
            description: '',
            icon: '',
            color: '',
            systemPrompt: '',
            defaultSkillIds: [] as string[],
            pinnedResourceIds: [] as string[],
            defaultRuntimeRootId: '',
            preferredProjectRootPath: '',
          };

    const sameIds = (left: string[], right: string[]) => {
      if (left.length !== right.length) return false;
      const sortedLeft = [...left].sort();
      const sortedRight = [...right].sort();
      return sortedLeft.every((value, index) => value === sortedRight[index]);
    };

    const profileDirty =
      examDate !== loadedProfileBaseline.examDate ||
      dailyBudgetMinutes !== loadedProfileBaseline.dailyBudgetMinutes ||
      Math.abs(targetRetention - loadedProfileBaseline.targetRetention) > 0.001 ||
      defaultDeckId !== loadedProfileBaseline.defaultDeckId ||
      memoryScope !== loadedProfileBaseline.memoryScope ||
      workbenchLayoutPreset !== loadedProfileBaseline.workbenchLayoutPreset;

    return (
      profileDirty ||
      name !== baseline.name ||
      description !== baseline.description ||
      icon !== baseline.icon ||
      color !== baseline.color ||
      systemPrompt !== baseline.systemPrompt ||
      !sameIds(defaultSkillIds, baseline.defaultSkillIds) ||
      !sameIds(pinnedResourceIds, baseline.pinnedResourceIds) ||
      defaultRuntimeRootId !== baseline.defaultRuntimeRootId ||
      preferredProjectRootPath !== baseline.preferredProjectRootPath
    );
  }, [
    color,
    dailyBudgetMinutes,
    defaultDeckId,
    defaultRuntimeRootId,
    defaultSkillIds,
    description,
    examDate,
    icon,
    initial,
    loadedProfileBaseline,
    memoryScope,
    mode,
    name,
    pinnedResourceIds,
    preferredProjectRootPath,
    systemPrompt,
    targetRetention,
    workbenchLayoutPreset,
  ]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  const handleSubmit = useCallback(async () => {
    const cleanName = stripEmojiText(name) || name.trim();
    if (!cleanName) return;
    setIsSaving(true);
    const spaceDraft = {
      examDate: examDate && examDate.trim() ? examDate.trim() : null,
      dailyBudgetMinutes,
      targetRetention,
      workbenchLayoutPreset,
      defaultDeckId: defaultDeckId && defaultDeckId.trim() ? defaultDeckId.trim() : null,
      memoryScope,
    };

    try {
      if (mode === 'create') {
        useStudySpaceStore.getState().stageCreateProfileDraft(spaceDraft);
        const payload: CreateGroupRequest = {
          name: cleanName,
          description: description.trim() || undefined,
          icon: sanitizeIconToken(icon) || undefined,
          color: color.trim() || undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          defaultSkillIds,
          pinnedResourceIds,
          defaultRuntimeRootId: defaultRuntimeRootId.trim() || undefined,
          preferredProjectRootPath: preferredProjectRootPath.trim() || undefined,
        };
        const created = await onSubmit(payload);
        const remainingDraft = useStudySpaceStore.getState().consumeStagedCreateProfileDraft();
        if (
          remainingDraft &&
          created &&
          typeof created === 'object' &&
          'id' in created &&
          typeof created.id === 'string'
        ) {
          const rootFolderId = inferLegacyRootFolderId(created) ?? '';
          await useStudySpaceStore.getState().saveSpaceProfile({
            spaceId: created.id,
            rootFolderId,
            ...remainingDraft,
          });
        }
      } else {
        const payload: UpdateGroupRequest = {
          name: cleanName,
          description: description.trim(),
          icon: sanitizeIconToken(icon),
          color: color.trim(),
          systemPrompt: systemPrompt.trim(),
          defaultSkillIds,
          pinnedResourceIds,
          defaultRuntimeRootId: defaultRuntimeRootId.trim(),
          preferredProjectRootPath: preferredProjectRootPath.trim(),
        };
        const updated = await onSubmit(payload);
        if (initial?.id) {
          const effectiveRoot =
            (updated && typeof updated === 'object' && 'id' in updated
              ? inferLegacyRootFolderId(updated)
              : null) ||
            resolvedRootFolderId ||
            inferLegacyRootFolderId(initial) ||
            '';
          await useStudySpaceStore.getState().saveSpaceProfile({
            spaceId: initial.id,
            rootFolderId: effectiveRoot,
            ...spaceDraft,
          });
        }
      }
    } catch (error: unknown) {
      useStudySpaceStore.getState().stageCreateProfileDraft(null);
      console.error('[GroupEditorPanel] Failed to save group:', getErrorMessage(error));
      showGlobalNotification('error', t('page.groupSaveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [
    color,
    dailyBudgetMinutes,
    defaultDeckId,
    defaultRuntimeRootId,
    defaultSkillIds,
    description,
    examDate,
    icon,
    initial,
    memoryScope,
    mode,
    name,
    onSubmit,
    pinnedResourceIds,
    preferredProjectRootPath,
    resolvedRootFolderId,
    systemPrompt,
    t,
    targetRetention,
    workbenchLayoutPreset,
  ]);

  useEffect(() => {
    groupEditorSubmitRef.current = () => {
      if (isSaving) return;
      if (!name.trim()) {
        setActiveTab('general');
        nameInputRef.current?.focus();
        return;
      }
      void handleSubmit();
    };
    return () => {
      groupEditorSubmitRef.current = null;
    };
  }, [handleSubmit, isSaving, name]);

  const handleUnmountResource = useCallback(
    async (mountId: string) => {
      if (!initial?.id) return;
      try {
        await unmountItemFromSpace(initial.id, { mountId });
      } catch (error: unknown) {
        showGlobalNotification('error', getErrorMessage(error));
      }
    },
    [initial?.id, unmountItemFromSpace],
  );

  const countdownPreview = useMemo(
    () => formatSpaceCountdown(examDate, { t }),
    [examDate, t],
  );

  const selectedIconEntry = useMemo(
    () => PRESET_ICONS.find((entry) => entry.name === icon) ?? null,
    [icon],
  );
  const HeaderIconComp = selectedIconEntry?.Icon ?? FolderSimple;

  const tabOptions = useMemo(
    () => [
      { value: 'general' as const, label: t('studySpace.tabs.general') },
      { value: 'goals' as const, label: t('studySpace.tabs.goals') },
      { value: 'workspace' as const, label: t('studySpace.tabs.workspace') },
    ],
    [t],
  );

  const retentionSegmentValue = useMemo(() => {
    const formatted = targetRetention.toFixed(2);
    return RETENTION_PRESETS.includes(formatted as (typeof RETENTION_PRESETS)[number])
      ? (formatted as (typeof RETENTION_PRESETS)[number])
      : '0.90';
  }, [targetRetention]);

  const retentionOptions = useMemo(
    () =>
      RETENTION_PRESETS.map((val) => ({
        value: val,
        label: (
          <span className="font-mono tabular-nums">
            {Math.round(Number(val) * 100)}%
          </span>
        ),
        ariaLabel: `${Math.round(Number(val) * 100)}%`,
      })),
    [],
  );

  const memoryScopeOptions = useMemo(
    () => [
      {
        value: 'space_and_global' as const,
        label: t('studySpace.memoryScopes.space_and_global'),
      },
      {
        value: 'space_isolated' as const,
        label: t('studySpace.memoryScopes.space_isolated'),
      },
      {
        value: 'global_only' as const,
        label: t('studySpace.memoryScopes.global_only'),
      },
    ],
    [t],
  );

  const targetSpaceSummary = useMemo(() => {
    if (mode !== 'edit' || !initial) return null;
    return {
      spaceId: initial.id,
      name: stripEmojiText(name) || initial.name,
      rootFolderId: resolvedRootFolderId,
      mountedResourceIds: storeMounts.map((m) => m.itemId),
    };
  }, [initial, mode, name, resolvedRootFolderId, storeMounts]);

  return (
    <div
      className={cn(
        'relative flex flex-col bg-background',
        embeddedInDialog ? 'max-h-[82vh]' : 'h-full',
      )}
    >
      {/* Unified Header with 1px border-border/35 divider & Segmented Navigation */}
      <div className="shrink-0 border-b border-border/35 px-5 py-3.5 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-primary)]"
              style={color ? { backgroundColor: color } : undefined}
            />
            <HeaderIconComp
              size={16}
              className="shrink-0 text-muted-foreground"
              style={color ? { color } : undefined}
            />
            <h2 className="truncate text-sm font-semibold text-foreground">
              {mode === 'create'
                ? t('studySpace.createSpace')
                : t('studySpace.editSpace')}
            </h2>
          </div>

          <div
            className={cn(
              'flex shrink-0 items-center gap-2',
              embeddedInDialog && 'pr-8',
              !embeddedInDialog && 'max-md:hidden',
            )}
          >
            <DsButton
              variant="ghost"
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="h-8 [@media(pointer:coarse)]:!h-11 px-3"
            >
              {t('common:cancel')}
            </DsButton>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSaving || !name.trim()}
              className="inline-flex h-8 [@media(pointer:coarse)]:min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-shell-control)] bg-foreground px-3.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {isSaving ? <CircleNotch size={13} className="animate-spin" /> : null}
              <span>{mode === 'create' ? t('common:create') : t('common:save')}</span>
            </button>
          </div>
        </div>

        <div className="mt-3">
          <SegmentedControl
            ariaLabel={t('studySpace.title')}
            value={activeTab}
            onValueChange={(val) => setActiveTab(val as EditorTabId)}
            options={tabOptions}
            size="compact"
            stretch
          />
        </div>
      </div>

      <CustomScrollArea className="min-h-0 flex-1">
        <div
          className={cn(
            'mx-auto w-full space-y-6 px-5 py-6 md:px-6',
            embeddedInDialog ? 'max-w-[560px]' : 'max-w-3xl',
          )}
        >
          {/* ================= TAB 1: GENERAL & PROMPT ================= */}
          {activeTab === 'general' ? (
            <div className="space-y-5">
              <div className="space-y-1">
                <Input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  placeholder={t('page.groupNamePlaceholder')}
                  aria-invalid={nameTouched && name.trim() === ''}
                  aria-required
                  autoFocus={autoFocusField === 'name'}
                  className="w-full rounded-none border-0 border-b border-border/35 bg-transparent py-2.5 text-xl font-semibold placeholder:text-muted-foreground/40 focus-visible:border-foreground focus-visible:ring-0 md:text-2xl"
                />
                {nameTouched && name.trim() === '' ? (
                  <p role="alert" className="text-[11px] text-warning">
                    {t('studySpace.fields.nameRequired')}
                  </p>
                ) : null}
              </div>

              {/* Root VFS Folder Read-only Pill */}
              {mode === 'edit' && resolvedRootFolderId ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-shell-control)] border border-border/35 bg-[var(--surface-elevated)] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <FolderSimple size={15} className="shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {t('studySpace.fields.rootFolder')}:
                    </span>
                    <span className="truncate font-mono tabular-nums text-foreground">
                      {resolvedRootFolderId}
                    </span>
                    {rootFolderItemCount !== null ? (
                      <Badge
                        variant="secondary"
                        className="font-mono text-[11px] tabular-nums"
                      >
                        {rootFolderItemCount}
                      </Badge>
                    ) : null}
                  </div>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() =>
                      void openSpaceFolderInHub(
                        resolvedRootFolderId,
                        stripEmojiText(name) || initial?.name,
                      )
                    }
                    className="!h-7 gap-1 px-2 text-xs"
                  >
                    <ArrowSquareOut size={13} />
                    <span>{t('studySpace.fields.openInHub')}</span>
                  </DsButton>
                </div>
              ) : null}

              <div className="divide-y divide-border/35">
                <PropertyRow icon={Palette} label={t('page.groupColor')} mobileStacked>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {PRESET_COLORS.map(({ name: colorName, value }) => {
                      const selected = color === value;
                      return (
                        <button
                          key={colorName}
                          type="button"
                          onClick={() => setColor(selected ? '' : value)}
                          title={colorName}
                          aria-label={colorName}
                          aria-pressed={selected}
                          className="h-6 w-6 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          style={{
                            backgroundColor: value,
                            boxShadow: selected
                              ? `0 0 0 2px var(--background), 0 0 0 4px ${value}`
                              : undefined,
                          }}
                        />
                      );
                    })}
                    {color ? (
                      <button
                        type="button"
                        onClick={() => setColor('')}
                        title={t('common:clear')}
                        aria-label={t('common:clear')}
                        className="flex h-6 w-6 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </div>
                </PropertyRow>

                <PropertyRow icon={FolderSimple} label={t('page.groupIcon')} mobileStacked>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {PRESET_ICONS.map(({ name: iconName, Icon: IconComponent }) => (
                      <button
                        key={iconName}
                        type="button"
                        onClick={() => setIcon(icon === iconName ? '' : iconName)}
                        aria-label={iconName}
                        aria-pressed={icon === iconName}
                        title={iconName}
                        className={cn(
                          'flex h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 items-center justify-center rounded-md transition-colors',
                          icon === iconName
                            ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
                        )}
                      >
                        <IconComponent size={17} />
                      </button>
                    ))}
                  </div>
                </PropertyRow>

                <PropertyRow icon={TextAlignLeft} label={t('page.groupDescription')}>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('page.groupDescriptionPlaceholder')}
                    className="h-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
                  />
                </PropertyRow>

                <PropertyRow
                  icon={Terminal}
                  label={t('page.groupSystemPrompt')}
                  mobileStacked
                >
                  <Textarea
                    ref={textareaRef}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={4}
                    className="min-h-[108px] resize-none overflow-hidden"
                    placeholder={t('page.groupSystemPromptPlaceholder')}
                  />
                </PropertyRow>

                <PropertyRow
                  icon={FolderOpen}
                  label={t('page.groupDefaultRuntimeRoot')}
                  mobileStacked
                >
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={defaultRuntimeRootId}
                        onChange={(e) => handleSelectRuntimeRoot(e.target.value)}
                        disabled={rootsLoading || isAuthorizingRoot}
                        className="h-9 [@media(pointer:coarse)]:h-11 min-w-[12rem] max-w-full flex-1 rounded-md border border-border/60 bg-background px-2 text-sm [@media(pointer:coarse)]:text-[16px] text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
                      >
                        <option value="">{t('page.groupDefaultRuntimeRootNone')}</option>
                        {defaultRuntimeRootId &&
                          !runtimeRoots.some((root) => root.id === defaultRuntimeRootId) && (
                            <option value={defaultRuntimeRootId}>
                              {selectedRuntimeRootPath || defaultRuntimeRootId}
                            </option>
                          )}
                        {runtimeRoots.map((root) => (
                          <option key={root.id} value={root.id}>
                            {root.label || root.id}
                            {root.access === 'read_only' ? ' (RO)' : ''}
                            {root.path ? ` - ${root.path}` : ''}
                          </option>
                        ))}
                      </select>
                      {!isMobilePlatform() ? (
                        <DsButton
                          variant="ghost"
                          type="button"
                          onClick={() => void handleBrowseAndAuthorizeRoot()}
                          disabled={isAuthorizingRoot}
                          className="h-8 [@media(pointer:coarse)]:!h-11 shrink-0 px-3"
                        >
                          {isAuthorizingRoot ? (
                            <CircleNotch size={14} className="mr-1.5 animate-spin" />
                          ) : (
                            <Folder size={14} className="mr-1.5" />
                          )}
                          {t('page.groupDefaultRuntimeRootBrowse')}
                        </DsButton>
                      ) : null}
                      {defaultRuntimeRootId ? (
                        <DsButton
                          variant="ghost"
                          type="button"
                          onClick={clearRuntimeRoot}
                          disabled={isAuthorizingRoot}
                          className="h-8 [@media(pointer:coarse)]:!h-11 shrink-0 px-3 text-muted-foreground hover:text-destructive"
                          title={t('common:clear')}
                        >
                          <X size={14} className="mr-1.5" />
                          {t('common:clear')}
                        </DsButton>
                      ) : null}
                    </div>
                    {selectedRuntimeRootPath ? (
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={selectedRuntimeRootPath}
                      >
                        {selectedRuntimeRootPath}
                      </div>
                    ) : null}
                    <p className="text-xs leading-relaxed text-muted-foreground/60">
                      {t('page.groupDefaultRuntimeRootHint')}
                    </p>
                  </div>
                </PropertyRow>

                <PropertyRow
                  icon={Lightning}
                  label={t('page.groupDefaultSkills')}
                  mobileStacked
                >
                  <div className="flex flex-wrap gap-2 pt-1">
                    {skillList.length === 0 ? (
                      <div className="text-sm text-muted-foreground/50">
                        {t('page.noSkills')}
                      </div>
                    ) : (
                      skillList.map((skill) => {
                        const checked = defaultSkillIds.includes(skill.id);
                        const displayName =
                          t(`skills:builtinNames.${skill.id}`, { defaultValue: '' }) ||
                          skill.name;
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => toggleSkill(skill.id)}
                            aria-pressed={checked}
                            className={cn(
                              'inline-flex [@media(pointer:coarse)]:min-h-11 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
                              checked
                                ? 'border-primary/30 bg-primary/10 text-primary'
                                : 'border-border/35 bg-background text-muted-foreground hover:bg-[var(--interactive-hover)]',
                            )}
                          >
                            {checked ? <Check size={12} /> : null}
                            <span>{stripEmojiText(displayName) || displayName}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </PropertyRow>
              </div>

              {/* Pinned Resources Section */}
              <div className="space-y-3 border-t border-border/35 pt-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground/85">
                  <Paperclip size={15} />
                  <span>{t('page.groupPinnedResources')}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {pinnedResourceIds.length}
                  </span>
                </div>

                {pinnedLoading ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <CircleNotch size={16} className="animate-spin" />
                    <span>{t('common:loading')}</span>
                  </div>
                ) : resolvedPinnedRefs.length > 0 ? (
                  <div className="space-y-1">
                    {resolvedPinnedRefs.map((ref) => {
                      const TypeIcon = getResourceTypeIcon(ref.type);
                      return (
                        <div
                          key={ref.sourceId}
                          className="group flex items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-1.5 transition-colors hover:bg-[var(--interactive-hover)]"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <TypeIcon
                              size={14}
                              className="shrink-0 text-muted-foreground"
                            />
                            <span className="truncate text-sm">
                              {stripEmojiText(ref.name) || ref.name}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground/60">
                              {ref.type}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => removePinnedResource(ref.sourceId)}
                            className={cn(
                              "relative rounded p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive after:absolute after:-inset-3.5 after:content-['']",
                              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
                            )}
                            aria-label={t('common:remove')}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <button
                  type="button"
                  aria-expanded={!onMobileBrowse ? pickerOpen : undefined}
                  onClick={() => {
                    if (onMobileBrowse) {
                      onMobileBrowse(togglePinnedResource, pinnedResourceIds);
                    } else {
                      setPickerOpen((open) => !open);
                    }
                  }}
                  className={cn(
                    'flex w-full [@media(pointer:coarse)]:min-h-11 items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm transition-colors',
                    !onMobileBrowse && pickerOpen
                      ? 'border-primary/40 bg-primary/5 text-foreground'
                      : 'border-border/35 text-muted-foreground hover:border-border hover:bg-[var(--interactive-hover)] hover:text-foreground',
                  )}
                >
                  {!onMobileBrowse && pickerOpen ? <X size={15} /> : <Plus size={15} />}
                  <span>
                    {!onMobileBrowse && pickerOpen
                      ? t('common:close')
                      : t('page.groupPinnedBrowse')}
                  </span>
                  {!onMobileBrowse && pickerOpen && pinnedResourceIds.length > 0 ? (
                    <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                      {t('page.groupPinnedSelectedCount', {
                        count: pinnedResourceIds.length,
                      })}
                    </span>
                  ) : null}
                </button>

                {!onMobileBrowse ? (
                  <div
                    className={cn(
                      'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--dropdown-ease)] motion-reduce:transition-none',
                      pickerOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                    )}
                  >
                    <div
                      className={cn(
                        'min-h-0 overflow-hidden',
                        !pickerOpen && 'pointer-events-none',
                      )}
                    >
                      <div className="h-[340px] overflow-hidden rounded-[var(--radius-shell-control)] border border-border/35 bg-card">
                        {pickerOpen ? (
                          <LearningHubSidebar
                            mode="canvas"
                            hostId={FINDER_HOST_IDS.groupPicker}
                            sessionActive={pickerOpen}
                            commandsEnabled={false}
                            onClose={() => setPickerOpen(false)}
                            onOpenApp={(item: ResourceListItem) => {
                              togglePinnedResource(item.id);
                            }}
                            className="h-full"
                            highlightedIds={pinnedHighlightSet}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {mode === 'edit' && onArchive ? (
                <div className="border-t border-border/35 pt-4">
                  <DsButton
                    variant="warning"
                    type="button"
                    onClick={onArchive}
                    className="h-8 [@media(pointer:coarse)]:!h-11 px-3"
                  >
                    <Archive size={14} className="mr-1.5" />
                    {t('page.archiveGroup')}
                  </DsButton>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ================= TAB 2: GOALS & FSRS ================= */}
          {activeTab === 'goals' ? (
            <div className="divide-y divide-border/35">
              {/* Target Exam Date */}
              <div className="space-y-2.5 pb-5">
                <label
                  htmlFor="study-space-exam-date"
                  className="flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <CalendarBlank size={16} className="text-muted-foreground" />
                  <span>{t('studySpace.fields.examDate')}</span>
                </label>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    id="study-space-exam-date"
                    aria-label={t('studySpace.fields.examDate')}
                    type="date"
                    value={examDate ?? ''}
                    onChange={(e) => updateExamDate(e.target.value || null)}
                    className="h-9 max-w-[210px] font-mono tabular-nums"
                  />
                  {countdownPreview ? (
                    <span
                      data-testid="exam-countdown-preview"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/35 bg-[var(--surface-elevated)] px-2.5 py-1 font-mono text-xs tabular-nums text-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          countdownPreview.dotColorClass,
                        )}
                      />
                      <span>{countdownPreview.label}</span>
                    </span>
                  ) : null}
                  {examDate ? (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => updateExamDate(null)}
                      className="!h-8 px-2.5 text-xs text-muted-foreground"
                    >
                      {t('studySpace.fields.examDateClear')}
                    </DsButton>
                  ) : null}
                </div>
              </div>

              {/* Daily Study Budget */}
              <div className="space-y-2.5 py-5">
                <label
                  htmlFor="study-space-daily-budget"
                  className="flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <Clock size={16} className="text-muted-foreground" />
                  <span>{t('studySpace.fields.dailyBudget')}</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {DAILY_BUDGET_PRESETS.map((minutes) => {
                    const selected = dailyBudgetMinutes === minutes;
                    return (
                      <button
                        key={minutes}
                        type="button"
                        onClick={() => updateDailyBudgetMinutes(minutes)}
                        aria-pressed={selected}
                        className={cn(
                          'inline-flex h-8 [@media(pointer:coarse)]:min-h-11 items-center rounded-[var(--radius-shell-control)] border px-2.5 font-mono text-xs tabular-nums transition-colors',
                          selected
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-border/35 bg-background text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
                        )}
                      >
                        {minutes}m
                      </button>
                    );
                  })}
                  <Input
                    id="study-space-daily-budget"
                    aria-label={t('studySpace.fields.dailyBudget')}
                    type="number"
                    min={STUDY_SPACE_DEFAULTS.minDailyBudgetMinutes}
                    max={STUDY_SPACE_DEFAULTS.maxDailyBudgetMinutes}
                    value={dailyBudgetMinutes}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      if (Number.isFinite(parsed)) {
                        updateDailyBudgetMinutes(
                          Math.min(
                            STUDY_SPACE_DEFAULTS.maxDailyBudgetMinutes,
                            Math.max(
                              STUDY_SPACE_DEFAULTS.minDailyBudgetMinutes,
                              Math.round(parsed),
                            ),
                          ),
                        );
                      }
                    }}
                    className="h-8 w-24 font-mono text-xs tabular-nums"
                  />
                </div>
              </div>

              {/* Target Retention */}
              <div className="space-y-2.5 py-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Gauge size={16} className="text-muted-foreground" />
                    <span>{t('studySpace.fields.targetRetention')}</span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {targetRetention.toFixed(2)}
                  </span>
                </div>
                <SegmentedControl
                  ariaLabel={t('studySpace.fields.targetRetention')}
                  value={retentionSegmentValue}
                  onValueChange={(val) => updateTargetRetention(Number(val))}
                  options={retentionOptions}
                  size="compact"
                />
              </div>

              {/* Default Flashcard Deck */}
              <div className="space-y-2.5 pt-5">
                <label
                  htmlFor="study-space-default-deck"
                  className="flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <Cards size={16} className="text-muted-foreground" />
                  <span>{t('studySpace.fields.defaultDeck')}</span>
                </label>
                <select
                  id="study-space-default-deck"
                  aria-label={t('studySpace.fields.defaultDeck')}
                  value={defaultDeckId ?? ''}
                  onChange={(e) => updateDefaultDeckId(e.target.value || null)}
                  className="h-9 [@media(pointer:coarse)]:h-11 w-full rounded-md border border-border/35 bg-background px-3 text-sm text-foreground outline-none focus:border-primary/50"
                >
                  <option value="">{t('studySpace.fields.defaultDeckGlobal')}</option>
                  {defaultDeckId &&
                    !availableDecks.some((d) => d.name === defaultDeckId) && (
                      <option value={defaultDeckId}>{defaultDeckId}</option>
                    )}
                  {availableDecks.map((deckItem) => (
                    <option key={deckItem.name} value={deckItem.name}>
                      {stripEmojiText(deckItem.name) || deckItem.name} ({deckItem.all})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {/* ================= TAB 3: MOUNTS & WORKBENCH ================= */}
          {activeTab === 'workspace' ? (
            <div className="divide-y divide-border/35">
              {/* Memory Scope */}
              <div className="space-y-2.5 pb-5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Brain size={16} className="text-muted-foreground" />
                  <span>{t('studySpace.fields.memoryScope')}</span>
                </div>
                <SegmentedControl
                  ariaLabel={t('studySpace.fields.memoryScope')}
                  value={memoryScope}
                  onValueChange={(val) => updateMemoryScope(val as StudySpaceMemoryScope)}
                  options={memoryScopeOptions}
                  size="compact"
                  stretch
                />
              </div>

              {/* Workbench Layout Preset */}
              <div className="space-y-2.5 py-5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Layout size={16} className="text-muted-foreground" />
                  <span>{t('studySpace.fields.workbenchPreset')}</span>
                </div>
                <div
                  role="radiogroup"
                  aria-label={t('studySpace.fields.workbenchPreset')}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {WORKBENCH_LAYOUT_PRESET_IDS.map((presetId) => {
                    const selected = workbenchLayoutPreset === presetId;
                    return (
                      <button
                        key={presetId}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => updateWorkbenchLayoutPreset(presetId)}
                        className={cn(
                          'flex [@media(pointer:coarse)]:min-h-11 items-center justify-between gap-2 rounded-[var(--radius-shell-control)] border px-3 py-2 text-left text-xs transition-colors',
                          selected
                            ? 'border-foreground bg-[var(--surface-elevated)] font-medium text-foreground'
                            : 'border-border/35 bg-background text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              selected ? 'bg-foreground' : 'bg-muted-foreground/40',
                            )}
                          />
                          <span className="truncate">
                            {t(`studySpace.presets.${presetId}`)}
                          </span>
                        </div>
                        {selected ? <Check size={13} className="shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Cross-Space Zero-Copy Mounts */}
              <div className="space-y-3 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <LinkSimple size={16} className="text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {t('studySpace.mounts.title')}
                    </span>
                    <Badge variant="secondary" className="text-[11px]">
                      {t('studySpace.mounts.zeroCopyBadge')}
                    </Badge>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {storeMounts.length}
                    </span>
                  </div>

                  {mode === 'edit' && targetSpaceSummary && resolvedRootFolderId ? (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => setMountPickerOpen(true)}
                      className="!h-7 gap-1 px-2.5 text-xs"
                    >
                      <Plus size={13} />
                      <span>{t('studySpace.mounts.add')}</span>
                    </DsButton>
                  ) : null}
                </div>

                {storeMounts.length === 0 ? (
                  <p className="rounded-[var(--radius-shell-control)] border border-dashed border-border/35 px-3 py-4 text-center text-xs text-muted-foreground">
                    {t('studySpace.mounts.empty')}
                  </p>
                ) : (
                  <div className="divide-y divide-border/35 rounded-[var(--radius-shell-control)] border border-border/35">
                    {storeMounts.map((mount) => {
                      const MountIcon = getResourceTypeIcon(mount.itemType);
                      const resolvedTitle = mountTitlesById[mount.itemId];
                      // 解析不到标题说明源资源已删除或当前不可访问：显示可读文案，
                      // 绝不把 file_xxx 这种内部 ID 直接摆到界面上。
                      const isMissingSource = !resolvedTitle;
                      const displayTitle =
                        resolvedTitle ?? t('studySpace.mounts.missingSource');
                      return (
                        <div
                          key={mount.id}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <MountIcon
                              size={14}
                              className="shrink-0 text-muted-foreground"
                            />
                            <span
                              className={cn(
                                'truncate font-medium',
                                isMissingSource ? 'text-muted-foreground' : 'text-foreground',
                              )}
                              title={isMissingSource ? undefined : displayTitle}
                            >
                              {displayTitle}
                            </span>
                            {isMissingSource ? (
                              <span className="shrink-0 text-[11px] text-warning">
                                {t('studySpace.mounts.missingHint')}
                              </span>
                            ) : (
                              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                                {mount.itemType}
                              </span>
                            )}
                          </div>
                          <DsButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            type="button"
                            onClick={() => void handleUnmountResource(mount.id)}
                            aria-label={t('studySpace.mounts.remove')}
                            title={t('studySpace.mounts.remove')}
                            className="!h-7 !w-7 [@media(pointer:coarse)]:!min-h-9 [@media(pointer:coarse)]:!min-w-9 text-muted-foreground hover:text-destructive"
                          >
                            <LinkBreak size={14} />
                          </DsButton>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </CustomScrollArea>

      {mountPickerOpen && targetSpaceSummary ? (
        <SpaceMountPickerDialog
          open={mountPickerOpen}
          onOpenChange={setMountPickerOpen}
          targetSpace={targetSpaceSummary}
        />
      ) : null}
    </div>
  );
};

export interface GroupEditorDialogProps extends Omit<GroupEditorPanelProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose?: () => void;
}

export const GroupEditorDialog: React.FC<GroupEditorDialogProps> = ({
  open,
  onOpenChange,
  onClose,
  ...panelProps
}) => {
  const { t } = useTranslation('chatV2');
  const handleClose = useCallback(() => {
    onClose?.();
    onOpenChange(false);
  }, [onClose, onOpenChange]);

  return (
    <DsDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleClose();
        } else {
          onOpenChange(true);
        }
      }}
      maxWidth="max-w-[560px]"
      aria-label={
        panelProps.mode === 'create'
          ? t('studySpace.createSpace')
          : t('studySpace.editSpace')
      }
      className="rounded-[var(--radius-card)] p-0 overflow-hidden"
    >
      <GroupEditorPanel
        {...panelProps}
        onClose={handleClose}
        embeddedInDialog
      />
    </DsDialog>
  );
};

export default GroupEditorDialog;
