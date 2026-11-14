import type { SettingsStore } from '../../../platform/settings/api.ts';
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import type { FailoverPolicy } from '../api.ts';
import { decodeFailoverPolicyExact, defaultFailoverPolicyExact, projectFailoverPolicy, type FailoverPolicyExact } from './policy.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

/** llm_manager/mod.rs:4788-4800,5458-5546 and routing.rs:549-574. */
export class LlmControl {
  readonly _settings: Pick<SettingsStore, 'get' | 'save'>;
  readonly _cancelRegistry = new Set<string>();
  readonly _cancelChannels = new Map<string, AbortController>();
  constructor(settings: Pick<SettingsStore, 'get' | 'save'>) { this._settings = settings; }

  async subscribeCancelStream(streamEvent: string): Promise<AbortSignal> {
    const channel = new AbortController();
    this._cancelChannels.set(streamEvent, channel);
    return channel.signal;
  }
  async requestCancelStream(streamEvent: string): Promise<void> {
    logInfo(`[LLM Manager] request_cancel_stream 开始处理: ${streamEvent}`);
    logDebug('[LLM Manager] 检查 cancel_channels...');
    const channel = this._cancelChannels.get(streamEvent);
    if (channel !== undefined) {
      logDebug('[LLM Manager] 找到 cancel_channel，发送取消信号...');
      channel.abort();
      logInfo(`[LLM Manager] 取消信号已成功发送到 channel: ${streamEvent}`);
    } else logDebug(`[LLM Manager] 未找到对应的 cancel_channel: ${streamEvent}`);
    logDebug('[LLM Manager] 写入 cancel_registry 作为备用...');
    this._cancelRegistry.add(streamEvent);
    logDebug(`[LLM Manager] 已将取消标记写入 registry: ${streamEvent}`);
    logDebug('[LLM Manager] request_cancel_stream 完成');
  }
  async consumePendingCancel(streamEvent: string): Promise<boolean> {
    const removed = this._cancelRegistry.delete(streamEvent);
    if (removed) logDebug(`[Cancel] Acknowledged and cleared cancel flag for stream: ${streamEvent}`);
    return removed;
  }
  async clearCancelStream(streamEvent: string): Promise<void> { this._cancelChannels.delete(streamEvent); }
  async clearCancelArtifacts(streamEvent: string): Promise<void> {
    this._cancelChannels.delete(streamEvent);
    this._cancelRegistry.delete(streamEvent);
  }
  async cancelStreamsByPrefix(prefix: string): Promise<void> {
    for (const key of [...this._cancelChannels.keys()]) {
      if (key.startsWith(prefix)) await this.requestCancelStream(key);
    }
  }
  async getFailoverPolicy(): Promise<FailoverPolicy> {
    return projectFailoverPolicy(await this.getFailoverPolicyExact());
  }
  /** routing.rs:550-565 with u64 fields still exact (for consumers that clamp, e.g. rag_extension.rs:1229). */
  async getFailoverPolicyExact(): Promise<FailoverPolicyExact> {
    let raw: string | null;
    try { raw = this._settings.get('llm_failover_policy'); }
    catch (error) { throw new CommandError(AppError.database(`读取 Failover 策略失败: ${error instanceof Error ? error.message : String(error)}`)); }
    if (raw === null || rustTrim(raw) === '') return defaultFailoverPolicyExact();
    try { return decodeFailoverPolicyExact(raw); }
    catch (error) {
      logWarn(`[Failover] 策略配置解析失败，回落默认值: ${error instanceof Error ? error.message : String(error)}`);
      return defaultFailoverPolicyExact();
    }
  }
  async saveFailoverPolicy(policy: FailoverPolicy): Promise<void> {
    let raw: string;
    try { raw = JSON.stringify(policy); }
    catch (error) { throw new CommandError(AppError.configuration(`序列化 Failover 策略失败: ${error instanceof Error ? error.message : String(error)}`)); }
    try { this._settings.save('llm_failover_policy', raw); }
    catch (error) { throw new CommandError(AppError.database(`保存 Failover 策略失败: ${error instanceof Error ? error.message : String(error)}`)); }
  }
}
