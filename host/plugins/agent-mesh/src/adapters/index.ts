// Barrel and registry factory for all External Coding CLI Protocol Adapters.

import type {
  ApprovalDecisionKind,
  ApprovalResponseInput,
  CustomCliTemplate,
  DetectedCliAgent,
  ExternalAgentDriverKind,
  ExternalCodingAdapter,
  ExternalTurnStartInput,
  NormalizedRuntimeEvent,
  SteerResult,
} from '../adapter-types.ts';
import { CliAgentProber, type CliProberOptions } from '../probe.ts';
import { ProcessTreeSupervisor, type ProcessTreeSupervisorOptions } from '../process-tree.ts';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './claude-adapter.ts';
import { CodexAdapter, type CodexAdapterOptions } from './codex-adapter.ts';
import {
  BUILT_IN_GENERIC_TEMPLATES,
  GenericCliAdapter,
  type GenericCliAdapterOptions,
} from './generic-cli-adapter.ts';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode-adapter.ts';
import { PiAdapter, type PiAdapterOptions } from './pi-adapter.ts';

export {
  AsyncEventQueue,
  LineStreamSplitter,
  attachLineReader,
  extractApprovalMetadata,
  isTerminalRuntimeEvent,
  tryParseJsonObject,
  writeEphemeralJsonFile,
} from './base.ts';
export { ClaudeAdapter, type ClaudeAdapterOptions } from './claude-adapter.ts';
export { CodexAdapter, type CodexAdapterOptions } from './codex-adapter.ts';
export { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode-adapter.ts';
export { PiAdapter, type PiAdapterOptions } from './pi-adapter.ts';
export {
  BUILT_IN_GENERIC_TEMPLATES,
  GenericCliAdapter,
  type GenericCliAdapterOptions,
  type GenericDriverKind,
} from './generic-cli-adapter.ts';

export interface CreateExternalAdapterOptions {
  readonly driver: ExternalAgentDriverKind;
  readonly command?: string;
  readonly template?: CustomCliTemplate;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly safetyIdleTimeoutMs?: number;
  readonly claude?: ClaudeAdapterOptions;
  readonly codex?: CodexAdapterOptions;
  readonly opencode?: OpenCodeAdapterOptions;
  readonly pi?: PiAdapterOptions;
  readonly generic?: GenericCliAdapterOptions & { readonly command?: string };
}

export function createExternalCodingAdapter(
  options: CreateExternalAdapterOptions,
): ExternalCodingAdapter {
  const sharedSupervisor = options.processSupervisor;
  const safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;

  switch (options.driver) {
    case 'claude':
      return new ClaudeAdapter({
        ...(options.command ? { command: options.command } : {}),
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.claude,
      });
    case 'codex':
      return new CodexAdapter({
        ...(options.command ? { command: options.command } : {}),
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.codex,
      });
    case 'opencode':
      return new OpenCodeAdapter({
        ...(options.command ? { command: options.command } : {}),
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.opencode,
      });
    case 'pi':
      return new PiAdapter({
        ...(options.command ? { command: options.command } : {}),
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.pi,
      });
    case 'agy':
    case 'dsh': {
      const baseTemplate =
        options.template ?? options.generic?.template ?? BUILT_IN_GENERIC_TEMPLATES[options.driver];
      const cmdOverride = options.generic?.command ?? options.command;
      const effectiveTemplate =
        cmdOverride && baseTemplate.command !== cmdOverride
          ? { ...baseTemplate, command: cmdOverride }
          : baseTemplate;
      return new GenericCliAdapter({
        ...options.generic,
        driver: options.driver,
        template: effectiveTemplate,
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
      });
    }
    case 'custom': {
      const baseTpl = options.template ?? options.generic?.template;
      if (!baseTpl) {
        throw new Error('Custom CLI driver requires a CustomCliTemplate');
      }
      const cmdOverride = options.generic?.command ?? options.command;
      const tpl =
        cmdOverride && baseTpl.command !== cmdOverride
          ? { ...baseTpl, command: cmdOverride }
          : baseTpl;
      return new GenericCliAdapter({
        ...options.generic,
        driver: 'custom',
        template: tpl,
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
      });
    }
  }
}

export interface ExternalAdapterRegistryOptions {
  readonly proberOptions?: CliProberOptions;
  readonly supervisorOptions?: ProcessTreeSupervisorOptions;
  readonly safetyIdleTimeoutMs?: number;
}

export class ExternalAdapterRegistry {
  readonly prober: CliAgentProber;
  readonly supervisor: ProcessTreeSupervisor;

  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly adapters = new Map<string, ExternalCodingAdapter>();
  private readonly adapterResolvedCommands = new Map<string, string | undefined>();
  private readonly templates = new Map<string, CustomCliTemplate>();
  private readonly activeThreadToAdapter = new Map<string, ExternalCodingAdapter>();

  constructor(options: ExternalAdapterRegistryOptions = {}) {
    this.supervisor = new ProcessTreeSupervisor(options.supervisorOptions);
    this.prober = new CliAgentProber(options.proberOptions);
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
  }

  registerCustomTemplate(template: CustomCliTemplate): void {
    const key = `custom:${template.id}`;
    this.templates.set(template.id, template);
    this.adapters.delete(key);
    this.adapterResolvedCommands.delete(key);
    this.prober.invalidateCache();
  }

  removeCustomTemplate(templateId: string): void {
    this.templates.delete(templateId);
    const key = `custom:${templateId}`;
    const existing = this.adapters.get(key);
    if (existing) {
      this.adapters.delete(key);
      this.adapterResolvedCommands.delete(key);
      void existing.dispose();
    }
    this.prober.invalidateCache();
  }

  async probeAgents(forceRefresh = false): Promise<DetectedCliAgent[]> {
    return this.prober.probeAll({
      forceRefresh,
      customTemplates: [...this.templates.values()],
    });
  }

  getAdapter(agentIdOrDriver: string): ExternalCodingAdapter {
    const cachedProbed = this.prober.getCachedAgent(agentIdOrDriver);
    const resolvedCmd = cachedProbed?.resolvedPath || undefined;

    const existing = this.adapters.get(agentIdOrDriver);
    if (existing) {
      const prevCmd = this.adapterResolvedCommands.get(agentIdOrDriver);
      const shouldRecreate = resolvedCmd !== undefined && prevCmd !== resolvedCmd;
      const inUse = [...this.activeThreadToAdapter.values()].includes(existing);
      if (!shouldRecreate || inUse) {
        return existing;
      }
      this.adapters.delete(agentIdOrDriver);
      this.adapterResolvedCommands.delete(agentIdOrDriver);
      void existing.dispose();
    }

    if (agentIdOrDriver.startsWith('custom:')) {
      const templateId = agentIdOrDriver.slice('custom:'.length);
      const baseTemplate = this.templates.get(templateId);
      if (!baseTemplate) {
        throw new Error(`Unknown custom CLI template: ${templateId}`);
      }
      const template =
        resolvedCmd && baseTemplate.command !== resolvedCmd
          ? { ...baseTemplate, command: resolvedCmd }
          : baseTemplate;
      const adapter = createExternalCodingAdapter({
        driver: 'custom',
        command: resolvedCmd,
        template,
        processSupervisor: this.supervisor,
        safetyIdleTimeoutMs: this.safetyIdleTimeoutMs,
        generic: {
          driver: 'custom',
          template,
          ...(resolvedCmd ? { command: resolvedCmd } : {}),
        },
      });
      this.adapters.set(agentIdOrDriver, adapter);
      this.adapterResolvedCommands.set(agentIdOrDriver, resolvedCmd);
      return adapter;
    }

    const driver = agentIdOrDriver as ExternalAgentDriverKind;
    const genericBase =
      driver === 'agy' || driver === 'dsh' ? BUILT_IN_GENERIC_TEMPLATES[driver] : undefined;
    const genericTemplate =
      genericBase && resolvedCmd ? { ...genericBase, command: resolvedCmd } : genericBase;

    const adapter = createExternalCodingAdapter({
      driver,
      command: resolvedCmd,
      template: genericTemplate,
      processSupervisor: this.supervisor,
      safetyIdleTimeoutMs: this.safetyIdleTimeoutMs,
      claude: { ...(resolvedCmd ? { command: resolvedCmd } : {}) },
      codex: { ...(resolvedCmd ? { command: resolvedCmd } : {}) },
      opencode: { ...(resolvedCmd ? { command: resolvedCmd } : {}) },
      pi: { ...(resolvedCmd ? { command: resolvedCmd } : {}) },
      ...(driver === 'agy' || driver === 'dsh'
        ? {
            generic: {
              driver,
              template: genericTemplate,
              ...(resolvedCmd ? { command: resolvedCmd } : {}),
            },
          }
        : {}),
    });
    this.adapters.set(agentIdOrDriver, adapter);
    this.adapterResolvedCommands.set(agentIdOrDriver, resolvedCmd);
    return adapter;
  }

  startTurn(
    agentIdOrDriver: string,
    input: ExternalTurnStartInput,
  ): AsyncIterable<NormalizedRuntimeEvent> {
    const adapter = this.getAdapter(agentIdOrDriver);
    this.activeThreadToAdapter.set(input.threadId, adapter);
    const inner = adapter.startOrResumeTurn(input);
    const activeMap = this.activeThreadToAdapter;

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
        try {
          for await (const event of inner) {
            yield event;
          }
        } finally {
          if (activeMap.get(input.threadId) === adapter) {
            activeMap.delete(input.threadId);
          }
        }
      },
    };
  }

  async steer(threadId: string, message: string): Promise<SteerResult> {
    const adapter = this.activeThreadToAdapter.get(threadId);
    if (!adapter) {
      return { accepted: false, mode: 'not_running', reason: 'Unknown or inactive threadId' };
    }
    return adapter.steer(threadId, message);
  }

  async interrupt(threadId: string): Promise<void> {
    const adapter = this.activeThreadToAdapter.get(threadId);
    if (!adapter) return;
    await adapter.interrupt(threadId);
    this.activeThreadToAdapter.delete(threadId);
  }

  async respondApproval(
    threadId: string,
    requestId: string,
    response: ApprovalResponseInput | ApprovalDecisionKind,
  ): Promise<boolean> {
    const adapter = this.activeThreadToAdapter.get(threadId);
    if (!adapter) return false;
    return adapter.respondApproval(threadId, requestId, response);
  }

  async dispose(): Promise<void> {
    this.activeThreadToAdapter.clear();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()));
    this.adapters.clear();
    this.adapterResolvedCommands.clear();
    await this.supervisor.dispose();
  }
}
