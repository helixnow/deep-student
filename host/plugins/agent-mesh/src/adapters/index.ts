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
  readonly template?: CustomCliTemplate;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly safetyIdleTimeoutMs?: number;
  readonly claude?: ClaudeAdapterOptions;
  readonly codex?: CodexAdapterOptions;
  readonly opencode?: OpenCodeAdapterOptions;
  readonly pi?: PiAdapterOptions;
  readonly generic?: GenericCliAdapterOptions;
}

export function createExternalCodingAdapter(
  options: CreateExternalAdapterOptions,
): ExternalCodingAdapter {
  const sharedSupervisor = options.processSupervisor;
  const safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;

  switch (options.driver) {
    case 'claude':
      return new ClaudeAdapter({
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.claude,
      });
    case 'codex':
      return new CodexAdapter({
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.codex,
      });
    case 'opencode':
      return new OpenCodeAdapter({
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.opencode,
      });
    case 'pi':
      return new PiAdapter({
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.pi,
      });
    case 'agy':
    case 'dsh':
      return new GenericCliAdapter({
        driver: options.driver,
        template: options.template,
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.generic,
      });
    case 'custom': {
      const tpl = options.template ?? options.generic?.template;
      if (!tpl) {
        throw new Error('Custom CLI driver requires a CustomCliTemplate');
      }
      return new GenericCliAdapter({
        driver: 'custom',
        template: tpl,
        processSupervisor: sharedSupervisor,
        safetyIdleTimeoutMs,
        ...options.generic,
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
  private readonly templates = new Map<string, CustomCliTemplate>();
  private readonly activeThreadToAdapter = new Map<string, ExternalCodingAdapter>();

  constructor(options: ExternalAdapterRegistryOptions = {}) {
    this.supervisor = new ProcessTreeSupervisor(options.supervisorOptions);
    this.prober = new CliAgentProber(options.proberOptions);
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
  }

  registerCustomTemplate(template: CustomCliTemplate): void {
    this.templates.set(template.id, template);
    this.adapters.delete(`custom:${template.id}`);
    this.prober.invalidateCache();
  }

  removeCustomTemplate(templateId: string): void {
    this.templates.delete(templateId);
    const key = `custom:${templateId}`;
    const existing = this.adapters.get(key);
    if (existing) {
      this.adapters.delete(key);
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
    const cached = this.adapters.get(agentIdOrDriver);
    if (cached) return cached;

    if (agentIdOrDriver.startsWith('custom:')) {
      const templateId = agentIdOrDriver.slice('custom:'.length);
      const template = this.templates.get(templateId);
      if (!template) {
        throw new Error(`Unknown custom CLI template: ${templateId}`);
      }
      const adapter = createExternalCodingAdapter({
        driver: 'custom',
        template,
        processSupervisor: this.supervisor,
        safetyIdleTimeoutMs: this.safetyIdleTimeoutMs,
      });
      this.adapters.set(agentIdOrDriver, adapter);
      return adapter;
    }

    const driver = agentIdOrDriver as ExternalAgentDriverKind;
    const adapter = createExternalCodingAdapter({
      driver,
      processSupervisor: this.supervisor,
      safetyIdleTimeoutMs: this.safetyIdleTimeoutMs,
    });
    this.adapters.set(agentIdOrDriver, adapter);
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
    await this.supervisor.dispose();
  }
}
