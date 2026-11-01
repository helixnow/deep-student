/**
 * Chat V2 - TauriAdapter 拆分模块 —— available_skills 目录快照的持久化冻结（R4）与换代消费（R5）
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  generateAvailableSkillsPrompt,
  getSessionAvailableSkillsPrompt,
  hydrateSessionAvailableSkillsSnapshot,
} from '../../skills/progressiveDisclosure';
import type { TauriAdapterHost } from './adapterHost';

/**
 * R4 目录原子化 + R5 换代消费：sessionId → available_skills 快照冻结的
 * 持久化确认状态（带代号维度，R4 复核第 3 点：集合升级为 Map）。
 *
 * 模块级（与 progressiveDisclosure 的内存快照 Map 同生命周期）：适配器重建
 * （切换会话再回来）不丢「后端已确认写入」这一事实，避免重复冻结 RPC。
 *
 * - persistedAvailableSkillsSnapshotGenerations：后端已确认持久化的快照及其
 *   代号。来源有二：首次发送时 await 冻结 RPC 成功；或 loadSession 从
 *   session.metadata 回灌（回灌值本身就来自持久化权威，无需再冻结）。
 *   条目内 pendingGeneration 记录 loadSession 见到的**有效**待换代标记
 *   （由 compaction 落盘事务写入，见 r4-catalog-compaction.md）：存在时
 *   下次发送不复用冻结字节，改按 live registry 重新生成目录并再走一次
 *   freeze RPC 兑现换代；不存在时行为与 R4 逐字节一致——已确认即复用，
 *   绝不重复冻结，first-write-wins 普通路径无回退。
 * - inflightAvailableSkillsSnapshotFreezes：冻结 RPC 进行中。并发发送（多变体
 *   重试等）共享同一 Promise，避免同 session 重复 RPC —— 后端 first-write-wins
 *   （换代兑现时为新代内 first-write-wins）本身幂等，共享只是省调用。
 *
 * 两表都缺键 = 从未触发，或上次冻结失败（fail-closed 已中止那次发送）；
 * 下次发送会重试冻结（普通路径用内存快照的同一字节；待换代路径按 live
 * registry 重新生成，重试不丢换代意图——pendingGeneration 只在兑现成功后清除）。
 */
interface AvailableSkillsSnapshotPersistedState {
  /** 已确认持久化的快照所属代号（缺键语义 = 第 0 代，与后端一致） */
  generation: number;
  /**
   * loadSession 带回的有效待换代代号（仅严格大于 generation 时记录，
   * 脏数据按无标记处理，与后端 freeze 原语的 effective_pending 门闩同语义）。
   * 兑现成功后清除（generation := pendingGeneration）。
   */
  pendingGeneration?: number;
}
export const persistedAvailableSkillsSnapshotGenerations = new Map<
  string,
  AvailableSkillsSnapshotPersistedState
>();
const inflightAvailableSkillsSnapshotFreezes = new Map<string, Promise<string>>();

/**
 * session.metadata 中「当前冻结快照所属代号」键（R4-#6 引入；与后端
 * `AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY`（repo.rs）对齐，
 * 后端文档明确前端消费侧对齐字符串字面量即可）。普通首冻不写该键，
 * 缺键 = 第 0 代。
 */
const AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY =
  'availableSkillsSnapshotGeneration';

/**
 * session.metadata 中「待生效代号」键（R4-#6；仅由 compaction 落盘事务
 * 写入，与后端 `AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY`
 * 对齐）。存在且大于当前代号 = 后端声明目录已过期，前端下次构建 system
 * 时按 live registry 重新生成并经 freeze 原语作为新代 first write 兑现。
 */
const AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY =
  'availableSkillsSnapshotPendingGeneration';

/** 解析当前快照代号：缺键 / 类型不符视为 0（旧会话兼容，与后端同语义）。 */
export function readAvailableSkillsSnapshotGeneration(
  metadata: Record<string, unknown> | undefined
): number {
  const raw = metadata?.[AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * 解析有效待换代代号：仅严格大于当前代号才有效（pending <= generation 的
 * 脏数据按无标记处理，镜像后端 freeze 原语的覆盖门闩，保证前端不会在
 * 后端会拒绝覆盖的场景下白白重算目录）。
 */
export function readAvailableSkillsSnapshotPendingGeneration(
  metadata: Record<string, unknown> | undefined,
  generation: number
): number | undefined {
  const raw =
    metadata?.[AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY];
  return typeof raw === 'number' && Number.isInteger(raw) && raw > generation
    ? raw
    : undefined;
}

/**
 * R4 发送等待点：返回本会话冻结且已确认持久化的 available_skills 目录。
 *
 * P0 available_skills 快照跨进程：首次无快照（loadSession 未能从 metadata
 * 回灌）时，把内存生成的目录冻结进 session.metadata（后端
 * `chat_v2_freeze_available_skills_snapshot`，first-write-wins），并 await
 * 到后端确认后才放行发送。多窗口竞争时后端返回更早冻结的生效值，回灌
 * 内存并以该值构建 system，保证字节与持久化权威一致。
 *
 * R5 换代消费：loadSession 若见到有效待换代标记
 * （availableSkillsSnapshotPendingGeneration，compaction 落盘事务写入，
 * 见 r4-catalog-compaction.md），本方法不复用冻结的内存/回灌字节，改按
 * live registry 重新生成目录并**再走一次** freeze RPC——后端 freeze 原语
 * 在有效 pending 存在时放行覆盖（generation := pending 并清标记），
 * 该次写入即新代 first write。compaction 已保证下一轮 history 字节必变、
 * 旧前缀缓存已报废，此时换目录的增量损失仅 system+tools 段。多窗口竞争
 * 时输家拿到新代已冻结值回灌，新代内仍是 first-write-wins。
 * 无待换代标记时行为与 R4 逐字节一致：已确认即复用、绝不重复冻结、
 * 绝不按 live 重算——普通 first-write-wins 路径无回退。
 *
 * 失败策略：fail-closed —— 冻结 RPC 失败时抛错中止本次发送，不带未持久化
 * 的目录发 LLM 请求（否则中途重启会让同一会话的 system 从第 0 字节变，
 * 打碎整段 prompt cache）。调用链各 send/retry 路径的既有 catch 负责复位
 * streaming 状态并向用户报错。普通路径内存快照保留原字节，下次发送用
 * 同一字节重试冻结；换代路径 pendingGeneration 仅在兑现成功后清除，
 * 失败重试会重新按 live 生成，换代意图不丢。
 */
export async function ensureAvailableSkillsSnapshotFrozen(host: TauriAdapterHost): Promise<string> {
  const sessionId = host.sessionId;
  const persisted = persistedAvailableSkillsSnapshotGenerations.get(sessionId);
  const pendingGeneration = persisted?.pendingGeneration;
  if (persisted !== undefined && pendingGeneration === undefined) {
    // 已确认某代且无待换代：逐字节复用冻结快照（R4 普通路径，无回退）。
    return getSessionAvailableSkillsPrompt(sessionId);
  }

  // 进入冻结 RPC 的两种情形：
  // - persisted 缺项：普通首冻，冻结首次生成（或 fail-closed 重试保留）的内存字节；
  // - pendingGeneration 有效：换代兑现，跳过冻结字节按 live registry 重新生成。
  const snapshot =
    pendingGeneration !== undefined
      ? generateAvailableSkillsPrompt()
      : getSessionAvailableSkillsPrompt(sessionId);

  let freeze = inflightAvailableSkillsSnapshotFreezes.get(sessionId);
  if (!freeze) {
    freeze = invoke<string>('chat_v2_freeze_available_skills_snapshot', {
      sessionId,
      snapshot,
    });
    inflightAvailableSkillsSnapshotFreezes.set(sessionId, freeze);
    freeze.finally(() => {
      // 成功路径已进 persisted 表；失败路径清掉进行中句柄，
      // 让下次发送重试冻结（fail-closed 后可恢复）。
      inflightAvailableSkillsSnapshotFreezes.delete(sessionId);
    }).catch(() => {
      // 错误由下方 await 处向发送方抛出，这里仅防 unhandled rejection。
    });
  }

  let effective: string;
  try {
    effective = await freeze;
  } catch (error) {
    throw new Error(
      `available_skills catalog freeze failed; message not sent (fail-closed): ${getErrorMessage(error)}`
    );
  }
  // 兑现换代后确认代号推进为 pending（后端 generation := pending 并清标记；
  // 若另一窗口已抢先兑现，后端此刻的 generation 同样是该 pending 值，
  // freeze 退化为新代内 first-write-wins 拒绝，记录值仍一致）。
  // 并发发送共享同一 freeze Promise 时各自 resume 写入相同状态，幂等。
  persistedAvailableSkillsSnapshotGenerations.set(sessionId, {
    generation: pendingGeneration ?? persisted?.generation ?? 0,
  });
  if (pendingGeneration !== undefined) {
    // 换代路径内存快照仍是旧代回灌字节，无条件以生效值覆盖：
    // 赢家 = 刚生成的 live 目录，输家 = 抢先窗口的新代冻结值。
    hydrateSessionAvailableSkillsSnapshot(sessionId, effective);
    return effective;
  }
  if (typeof effective === 'string' && effective !== snapshot) {
    // 多窗口竞争：后端已有更早冻结的快照，first-write-wins 生效值回灌内存。
    hydrateSessionAvailableSkillsSnapshot(sessionId, effective);
    return effective;
  }
  return snapshot;
}
