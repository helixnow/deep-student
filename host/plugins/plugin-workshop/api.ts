import type {} from '@deepseek-ai/cordis';

/**
 * `state` is the work's latest step. A proposal moves through draft → generating → pending-confirmation → installed and
 * may end in cancelled / failed / superseded (a newer proposal of the same conversation replaced an un-started draft).
 * What is installed is tracked separately in `installation`: closing a modification proposal never changes it.
 */
export type WorkshopState = 'draft' | 'generating' | 'cancelled' | 'pending-confirmation' | 'installed' | 'failed' | 'revoked' | 'superseded';
/**
 * The installed version, independent of any proposal in progress. `failed`: the installed version was turned off after
 * crashing (or could not start); `revoked`: uninstalled (retained versions stay and can be restored).
 * `previousVersion` is the version installed before `version` (what 「回到上一版」 reinstalls).
 */
export interface WorkshopInstallation {
  state: 'installed' | 'failed' | 'revoked'; version: string; previousVersion?: string | null;
}
export type WorkshopTemplate = 'learning-tool' | 'host-tool';
/**
 * A value the plugin needs from the user before it can work (e.g. the school's calendar .ics address). The card asks
 * for missing values before generation; the Host stores them as the installed plugin's config under `key`.
 * `ics-url`: an https address the Host reads once (public-pinned GET) and requires a VCALENDAR response from;
 * `https-url`: an https address. Both make the Host declare `net:<host>` for the plugin.
 */
/**
 * A value only the user knows, asked for on the card. `secret` (an API key …) is never stored on the card, in the
 * package or an export: the Host saves it in the system secure store under pluginSecretSettingsKey(pluginId, key)
 * (host/plugins/plugin-services/api.ts) and the plugin reads it with `pluginSecrets.get(key)`; the card only
 * remembers that it was saved (`saved`).
 */
export interface WorkshopSetting {
  key: string; title: string; kind: 'ics-url' | 'https-url' | 'text' | 'secret'; value?: string; saved?: boolean;
}
/**
 * What the assistant found out before proposing (shown on the card): `limits` the parts of the request that cannot be
 * done (「做不到的部分」), `alternatives` what it proposes instead (「改成这样」), `builtinDifference` how the work
 * differs from a built-in feature that does something similar (「和内置『X』的区别」).
 */
export interface WorkshopFeasibility {
  limits?: string[]; alternatives?: string[]; builtinDifference?: string;
}
export interface WorkshopBrief extends WorkshopFeasibility {
  sessionId: string; title: string; description: string; template: WorkshopTemplate;
  pluginId?: string; changes: string[]; capabilities: string[]; settings?: WorkshopSetting[];
}
/** A rough time a generation takes, from the recipe and the size of the request (「预计 1–3 分钟」). */
export interface WorkshopEstimate { minMinutes: number; maxMinutes: number }
/**
 * The last generation run: when it started, how long it took and the tokens the generation conversation used
 * (summed from its messages' usage; absent when the provider reported none).
 */
export interface WorkshopGenerationStats { startedAt: string; durationMs?: number; tokens?: number; attempts?: number }
export interface WorkshopCheck {
  ok: boolean; manifest: 'passed' | 'failed'; compile: 'passed' | 'failed';
  lifecycle: 'passed' | 'failed' | 'not-run'; visual: 'not-verified'; errors: string[];
}
export interface WorkshopCard extends WorkshopFeasibility {
  kind: 'dstu-plugin-workshop'; id: string; pluginId: string; sessionId: string;
  title: string; description: string; template: WorkshopTemplate; state: WorkshopState;
  revision: number; version: string | null; capabilities: string[]; changes: string[];
  /**
   * Capability lines the Host derived from the validated candidate (agent tools, network hosts, services).
   * Absent until a build passed. `capabilities` is the Agent's own wording and is shown after these.
   */
  declared?: string[];
  trust: 'full'; source: 'workshop'; risk: string; check: WorkshopCheck | null;
  error: string | null; previousVersion: string | null; createdAt: string; updatedAt: string;
  rollback?: 'not-needed' | 'restored' | 'failed';
  /** Last version observed running in the real application, not merely self-checked/installed. */
  usableVersion?: string | null;
  /** Immutable managed package last observed running; failed candidates never replace it. */
  lastGoodPackageDir?: string | null;
  buildAttempt?: number;
  /** What the background job is doing within the current attempt; progress only, never part of consent. */
  buildStage?: 'making' | 'checking' | null;
  /**
   * Finer progress within the stage: files the model has written so far in this attempt (`making`), or which part
   * of the self-check runs (`link`: reading the user's address, `compile`, `load`: test load/unload). Progress only.
   */
  buildFiles?: string[] | null;
  buildStep?: 'link' | 'compile' | 'load' | null;
  /** Values the plugin needs from the user (see WorkshopSetting); entered on the card before generation. */
  settings?: WorkshopSetting[];
  /**
   * The user pressed 开始做 for this proposal: approval to have code generated and test-loaded in the Host. Agent
   * source edits (write_source / validate) are only accepted after it; a new proposal resets it.
   */
  generationApproved?: boolean;
  /** Set (to the time) while the Agent edits approved source itself, write_source until validate: the card says so. */
  agentEditing?: string | null;
  lastFault?: string | null;
  /**
   * Conversations the user bound to this work before (`sessionId` is the current one). Any of them may keep
   * editing it; a conversation the user never bound still cannot touch it.
   */
  boundSessions?: string[];
  /** Where the user finds the work once installed, detected by the Host from the validated candidate. */
  places?: WorkshopPlace[];
  /** Where it will probably be, inferred from the proposal with the recipe rules before anything is built. */
  expectedPlaces?: WorkshopPlace[];
  /** The installed version (see WorkshopInstallation); null/absent when never installed. */
  installation?: WorkshopInstallation | null;
  /** The record revision at which the current proposal was made: tells a chat card whether it shows this proposal. */
  proposalRevision?: number;
  /** Rough generation time, shown on the proposal card before 开始做. */
  estimate?: WorkshopEstimate;
  /** The last generation run (time and tokens), shown once it finished. */
  generation?: WorkshopGenerationStats | null;
}
export type WorkshopPlace =
  | { kind: 'app'; title: string }
  | { kind: 'selectionButton' }
  | { kind: 'agentTool'; title: string };
/** `fileName`: readable `<标题>-v<version>.dstuplugin`, the name a save dialog should suggest. */
export interface WorkshopExport { id: string; version: string; path: string; fileName: string; }
export interface PluginWorkshopService {
  developmentSkill(includeContent?: boolean): Promise<{ id: string; markdown: string; schemaToolIds: string[] }>;
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard>;
  propose(brief: WorkshopBrief): Promise<WorkshopCard>;
  list(): Promise<WorkshopCard[]>;
  status(id: string): Promise<WorkshopCard>;
  /** 开始做. `settings` fills the values the card asked for (keys of `card.settings`). */
  create(id: string, revision: number, settings?: Record<string, string>): Promise<WorkshopCard>;
  cancel(id: string, revision: number): Promise<WorkshopCard>;
  validate(id: string): Promise<WorkshopCheck>;
  install(id: string, revision: number): Promise<WorkshopCard>;
  revoke(id: string, revision: number): Promise<WorkshopCard>;
  restore(id: string, revision: number): Promise<WorkshopCard>;
  /** Packs the approved installed version (never a rebuild of the editable source). */
  export(id: string): Promise<WorkshopExport>;
  /** Delete a never-installed work and its sources; installed works are removed with revoke. */
  discard(id: string, revision: number): Promise<{ id: string; discarded: true }>;
  /** 「按新版重做」: a new modification proposal with the work's original description, for the current app version. */
  redo(id: string, revision: number): Promise<WorkshopCard>;
  /** 「把需求砍成最小版再试」 after repeated failures: a new proposal that keeps only the core of the request. */
  reduce(id: string, revision: number): Promise<WorkshopCard>;
  reportFault(id: string, error: string): Promise<WorkshopCard>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { pluginWorkshop: PluginWorkshopService; }
}
