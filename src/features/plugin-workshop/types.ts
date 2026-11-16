/** UI domain contract. Wire commands belong in the Host adapter, never in components. */
/**
 * `editing`: the Agent is changing the source of a started work itself (no decision until it validates).
 * `superseded`: a newer proposal of the same conversation replaced this one before it was started.
 */
export type WorkshopPhase = 'proposed' | 'ready' | 'generating' | 'editing' | 'validating' | 'installing' | 'installed' | 'disabled' | 'undone' | 'cancelled' | 'failed' | 'superseded';

/** The installed version of a work, apart from any proposal in progress. `failed`: turned off after crashing. */
export interface WorkshopInstalled {
  phase: 'installed' | 'disabled' | 'undone' | 'failed';
  version: string;
  /** What 「回到上一版」 reinstalls. */
  previousVersion?: string;
}

/** Where the user finds a work once installed (Host-detected from the validated candidate). */
export type WorkshopPlace =
  | { kind: 'app'; title: string }
  | { kind: 'selectionButton' }
  | { kind: 'agentTool'; title: string };

/**
 * What the background job is doing: writing (with the files written so far), checking itself (reading the user's
 * address, compiling, test load/unload), or fixing what the check found (attempt ≥ 2).
 */
export type WorkshopProgress =
  | { stage: 'making'; files?: string[] }
  | { stage: 'checking'; step?: 'link' | 'compile' | 'load' }
  | { stage: 'fixing'; attempt: number; files?: string[] };

/** A value the work needs from the user (e.g. a calendar .ics address), asked for on the card before 开始做. */
/** `secret`: typed on the card, kept in the system secure store; only `saved` comes back, never the value. */
export interface WorkshopSetting { key: string; title: string; kind: 'ics-url' | 'https-url' | 'text' | 'secret'; value?: string; saved?: boolean }

export interface WorkshopItem {
  id: string;
  proposalId: string;
  revision?: number;
  name: string;
  /** Empty until a candidate was built. */
  version: string;
  previousVersion?: string;
  description?: string;
  capabilities: string[];
  changes: string[];
  trust: 'full' | 'restricted';
  phase: WorkshopPhase;
  progress?: WorkshopProgress;
  /** Raw Host text; components show it through `describeWorkshopError`, the raw text only under 技术信息. */
  error?: string;
  /** Set only when Host confirms the previous usable version was restored. */
  rollback?: 'restored' | 'failed' | 'not-needed';
  places?: WorkshopPlace[];
  settings?: WorkshopSetting[];
  /** The conversation that currently owns the work (opened by 「让 AI 改」 from the manager). */
  sessionId?: string;
  /** `places` is the recipe's expectation, not what a build showed: said as 「预计」. */
  placesExpected?: boolean;
  /** The installed version, when there is one (also while a modification is proposed or being made). */
  installed?: WorkshopInstalled;
  /** The proposal's own step and the record revision it was made at (chat cards compare it with their own). */
  proposal?: { phase: WorkshopPhase; revision?: number };
  /** On an older chat card: the step of a newer proposal of this work, shown as one line. */
  elsewhere?: WorkshopPhase;
  updatedAt?: string;
}

export interface WorkshopActionResult {
  /** The work after the action; absent when it was deleted (`removed`). */
  item?: WorkshopItem;
  removed?: boolean;
  exportPath?: string;
  /** The readable file name a save dialog suggests. */
  exportName?: string;
}

/**
 * confirm: 开始做 (proposed) / 安装 (ready) / 继续做 or 再试一次 (failed); cancel: 不要了 / 停下; try: open or try it (turns
 * it on first when off); disable: 停用; undo: 卸载; restore: 恢复 (uninstalled) / 回到上一版 (installed or failed);
 * export: 导出; discard: 删除 a never-installed work; redo: 按新版重做 (a new proposal with the original description).
 */
export type WorkshopAction = 'confirm' | 'cancel' | 'try' | 'disable' | 'undo' | 'restore' | 'export' | 'discard' | 'redo';

export interface WorkshopAdapter {
  list(): Promise<WorkshopItem[]>;
  get(proposalId: string): Promise<WorkshopItem>;
  /** Implementations must bind consent to this exact proposal/version. `input`: setting values entered for 开始做. */
  act(action: WorkshopAction, item: WorkshopItem, input?: Record<string, string>): Promise<WorkshopActionResult>;
  subscribe(onChange: () => void): () => void;
  /** 「在文件夹中显示」 for an exported file, where the platform can. */
  readonly reveal?: (path: string) => Promise<void>;
}

export function workshopActions(phase: WorkshopPhase): WorkshopAction[] {
  switch (phase) {
    case 'proposed': return ['confirm', 'cancel'];
    case 'ready': return ['confirm', 'cancel'];
    case 'generating':
    case 'validating': return ['cancel'];
    case 'installed': return ['try', 'disable', 'undo', 'restore', 'export', 'redo'];
    case 'disabled': return ['try', 'undo', 'restore', 'export', 'redo'];
    case 'undone': return ['restore', 'export'];
    // confirm on a failed work = try again (继续做 after an interruption, or with corrected settings).
    case 'failed': return ['restore', 'undo', 'confirm', 'discard', 'redo'];
    case 'cancelled':
    case 'superseded': return ['discard'];
    default: return [];
  }
}

/** The one thing to do with an installed work, by what it adds: open the app, try the button in notes, or say the phrase. */
export function primaryPlace(item: Pick<WorkshopItem, 'places'>): WorkshopPlace | undefined {
  const places = item.places ?? [];
  return places.find(place => place.kind === 'app') ?? places.find(place => place.kind === 'selectionButton') ?? places.find(place => place.kind === 'agentTool');
}
