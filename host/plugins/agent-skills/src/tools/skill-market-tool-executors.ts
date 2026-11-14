/** skill_market_client.rs:1490–1840 SkillMarketRead/InstallToolExecutor over the SkillsService market flows. */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { SkillMarket } from '../skill-market.ts';
import { chatV2Display } from './chat-v2-error.ts';
import { stripToolNamespace } from './naming.ts';
import { POST_WRITE_TRUST_NEXT_STEP } from './skill-install-executor.ts';

export const SKILL_MARKET_SEARCH = 'skill_market_search';
export const SKILL_MARKET_SKILL_DETAIL = 'skill_market_skill_detail';
export const SKILL_MARKET_VERIFY = 'skill_market_verify';
export const SKILL_MARKET_DOWNLOAD_AND_SCAN = 'skill_market_download_and_scan';

export interface SkillMarketToolPort {
  marketSearch(...args: Parameters<SkillMarket['search']>): ReturnType<SkillMarket['search']>;
  marketDetail(...args: Parameters<SkillMarket['detail']>): ReturnType<SkillMarket['detail']>;
  marketVerify(...args: Parameters<SkillMarket['verify']>): ReturnType<SkillMarket['verify']>;
  marketDownloadAndScan(...args: Parameters<SkillMarket['downloadAndScan']>): ReturnType<SkillMarket['downloadAndScan']>;
}

export interface SkillMarketToolDeps {
  market(): SkillMarketToolPort;
  warn(message: string): void;
}

type Args = Record<string, unknown>;
const asArgs = (value: unknown): Args => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function trimmedString(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}
const firstDefined = (args: Args, ...keys: string[]) => keys.map(key => args[key]).find(value => value !== undefined);
const optionalBool = (value: unknown) => typeof value === 'boolean' ? value : null;
const u32 = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value >>> 0 : null;

function success(call: ToolCall, ctx: ExecutionContext, output: unknown, durationMs: number): ToolResultInfo {
  ctx.emitToolCallEnd({ result: output, durationMs });
  return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
}
function save(executor: string, deps: SkillMarketToolDeps, ctx: ExecutionContext, result: ToolResultInfo): ToolResultInfo {
  try { ctx.saveToolBlock(result); }
  catch (error) { deps.warn(`[${executor}] Failed to save tool block: ${errorText(error)}`); }
  return result;
}

export class SkillMarketReadToolExecutor implements ToolExecutor {
  private readonly deps: SkillMarketToolDeps;
  constructor(deps: SkillMarketToolDeps) { this.deps = deps; }

  name(): string { return 'SkillMarketReadToolExecutor'; }
  canHandle(toolName: string): boolean {
    const short = stripToolNamespace(toolName);
    return short === SKILL_MARKET_SEARCH || short === SKILL_MARKET_SKILL_DETAIL;
  }
  sensitivityLevel(): 'low' { return 'low'; }
  concurrencyClass(): 'read_only' { return 'read_only'; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    const short = stripToolNamespace(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try { output = await this.run(short, asArgs(call.arguments)); }
    catch (error) { failure = chatV2Display(error); }
    const durationMs = Date.now() - started;
    if (failure === null) return save(this.name(), this.deps, ctx, success(call, ctx, output, durationMs));
    ctx.emitToolCallError(failure);
    return save(this.name(), this.deps, ctx, { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
      input: call.arguments, output: null, success: false, error: failure, durationMs });
  }

  private async run(short: string, args: Args): Promise<unknown> {
    if (short === SKILL_MARKET_SEARCH) {
      const q = firstDefined(args, 'q', 'query');
      const sort = args.sort;
      return this.deps.market().marketSearch(typeof q === 'string' ? q : null, u32(args.limit),
        optionalBool(firstDefined(args, 'nonSuspiciousOnly', 'non_suspicious_only')), typeof sort === 'string' ? sort : null);
    }
    if (short === SKILL_MARKET_SKILL_DETAIL) {
      const slug = trimmedString(args, 'slug');
      if (slug === null) throw new Error('slug is required');
      return this.deps.market().marketDetail(slug);
    }
    throw new Error(`Unsupported community marketplace read tool: ${short}`);
  }
}

const DOWNLOAD_SCAN_NEXT_STEP = 'Review scan.risk_level/risk_signals and show the summary to the user, then call this tool with install=true, expectedPackageSha256=scan.package_sha256, tempZipPath=temp_zip_path, and declaredRiskLevel=scan.risk_level. The platform approval card is the confirmation boundary; do not use shell or ask for a duplicate text confirmation.';
const TERMINAL_NEXT_STEP = "Stop this candidate skill's workflow and report the error truthfully. Do not retry the same call, substitute shell/web tools, or claim installation success.";

export class SkillMarketInstallToolExecutor implements ToolExecutor {
  private readonly deps: SkillMarketToolDeps;
  constructor(deps: SkillMarketToolDeps) { this.deps = deps; }

  name(): string { return 'SkillMarketInstallToolExecutor'; }
  canHandle(toolName: string): boolean {
    const short = stripToolNamespace(toolName);
    return short === SKILL_MARKET_VERIFY || short === SKILL_MARKET_DOWNLOAD_AND_SCAN;
  }
  sensitivityLevel(toolName: string): 'low' | 'high' {
    return stripToolNamespace(toolName) === SKILL_MARKET_VERIFY ? 'low' : 'high';
  }
  sensitivityLevelForCall(toolName: string, args: unknown): 'low' | 'medium' | 'high' {
    if (stripToolNamespace(toolName) === SKILL_MARKET_DOWNLOAD_AND_SCAN && asArgs(args).install !== true) return 'medium';
    return this.sensitivityLevel(toolName);
  }
  hasDynamicSensitivity(toolName: string): boolean { return stripToolNamespace(toolName) === SKILL_MARKET_DOWNLOAD_AND_SCAN; }
  concurrencyClass(toolName: string): 'read_only' | 'serial' {
    return stripToolNamespace(toolName) === SKILL_MARKET_VERIFY ? 'read_only' : 'serial';
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = Date.now();
    const short = stripToolNamespace(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: unknown;
    let failure: string | null = null;
    try { output = await this.run(short, asArgs(call.arguments)); }
    catch (error) { failure = errorText(error); }
    const durationMs = Date.now() - started;
    if (failure === null) return save(this.name(), this.deps, ctx, success(call, ctx, output, durationMs));
    ctx.emitToolCallError(failure);
    const args = asArgs(call.arguments);
    return save(this.name(), this.deps, ctx, { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
      output: { status: 'error', slug: args.slug ?? null, install: args.install === undefined ? false : args.install,
        terminal_for_skill_workflow: true, next_step: TERMINAL_NEXT_STEP },
      success: false, error: failure, durationMs });
  }

  private async run(short: string, args: Args): Promise<unknown> {
    if (short !== SKILL_MARKET_VERIFY && short !== SKILL_MARKET_DOWNLOAD_AND_SCAN) {
      throw new Error(`Unsupported community marketplace install tool: ${short}`);
    }
    const slug = trimmedString(args, 'slug');
    if (slug === null) throw new Error('slug is required');
    const version = trimmedString(args, 'version');
    if (short === SKILL_MARKET_VERIFY) return this.deps.market().marketVerify(slug, version);
    const result = await this.deps.market().marketDownloadAndScan(slug, version, optionalBool(args.install),
      optionalBool(args.overwrite), trimmedString(args, 'expectedPackageSha256', 'expected_package_sha256'),
      trimmedString(args, 'tempZipPath', 'temp_zip_path'), trimmedString(args, 'declaredRiskLevel', 'declared_risk_level'));
    const output: Record<string, unknown> = { ...result };
    const skillId = asArgs(output.scan).skill_id;
    if (skillId !== undefined) output.skill_id = skillId;
    output.next_step = result.installed ? POST_WRITE_TRUST_NEXT_STEP : DOWNLOAD_SCAN_NEXT_STEP;
    return output;
  }
}
