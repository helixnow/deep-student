/**
 * App 侧 agent 组装（`src-tauri/src/agent_wiring/`）。
 *
 * 本文件只迁移不依赖具体领域执行器的部分：
 * - `services.rs::build_pipeline_services`：把宿主已创建的服务实例放进 `Services`；
 * - `roster.rs::missing_descriptor_tools` / `verify_roster_coverage`：启动期花名册自检。
 *
 * `roster.rs::AppExecutorRoster` 本身与 `plugins.rs` 的 Canvas/Insight 适配器要实例化
 * 各领域 lane 的执行器与服务；这些实现尚未在 Host 发布，见 `migration/testmap/F1-kernel.md`
 * 的待协调说明。此处不写占位执行器。
 */
import { AgentServices, type ServiceKey, type ToolDescriptor } from './agent-api.ts';

/**
 * 一个可选服务槽：领域 lane 自己声明 `ServiceKey`，宿主传入**同一份**实例。
 * 对应 Rust `Option<Arc<T>>` + `Services::insert`（`services.rs:20-31`）。
 */
export interface OptionalService<T = unknown> {
  readonly key: ServiceKey<T>;
  readonly value: T;
}

/**
 * 由宿主已有的服务实例组装 pipeline 服务容器（`services.rs:20-31`）。
 *
 * - `notesManager`：原 `ChatV2Pipeline::new` 的 `notes_manager` 参数；
 * - `questionBankService`：原 `with_question_bank_service`，仅 `Some` 时插入。
 *
 * 插入顺序与 Rust 相同（notes 先、qbank 后）；未提供的槽保持缺省。
 */
export function buildPipelineServices(
  notesManager?: OptionalService | undefined,
  questionBankService?: OptionalService | undefined,
): AgentServices {
  const services = new AgentServices();
  if (notesManager !== undefined) services.insert(notesManager.key, notesManager.value);
  if (questionBankService !== undefined) services.insert(questionBankService.key, questionBankService.value);
  return services;
}

/**
 * 注册表上自检所需的只读面（`chat_v2::tools::executor_registry::ToolExecutorRegistry`）。
 * 由 L04 在发布 executor registry 时实现；本 lane 只依赖这两个方法。
 */
export interface SpecificExecutorRegistry {
  /** 是否有**特异性** executor（非 General 兜底）受理该工具名。 */
  hasSpecificExecutor(toolName: string): boolean;
  /** 注册的 executor 数量。 */
  len(): number;
}

/**
 * 注册表里没有特异性（非 `GeneralToolExecutor` 兜底）执行器受理的 descriptor 工具名
 * （`roster.rs:158-166`）。返回值保持 `descriptors` 的输入顺序。
 */
export function missingDescriptorTools(
  registry: SpecificExecutorRegistry,
  descriptors: readonly ToolDescriptor[],
): string[] {
  return descriptors
    .filter(descriptor => !registry.hasSpecificExecutor(descriptor.name))
    .map(descriptor => descriptor.name);
}

/** 启动期自检的日志出口（Cordis logger 的子集）。 */
export interface RosterCoverageLogger {
  error(message: string): void;
}

/**
 * 启动期花名册自检（`roster.rs:169-181`）：只记日志、不改变分发。
 * 返回缺失的工具名，供调用方在 debug 构建中断言（对应 Rust `debug_assert!`）。
 */
export function verifyRosterCoverage(
  registry: SpecificExecutorRegistry,
  descriptors: readonly ToolDescriptor[],
  logger: RosterCoverageLogger,
): string[] {
  const missing = missingDescriptorTools(registry, descriptors);
  if (missing.length > 0) {
    // Rust `{:?}` 对 Vec<&str> 的输出：`["a", "b"]`（逗号后带空格）。
    const rendered = `[${missing.map(name => JSON.stringify(name)).join(', ')}]`;
    logger.error(
      `[agent_wiring] ToolExecutorRegistry has ${registry.len()} executors but ${missing.length} descriptor-backed tools have no specific executor (executor roster not injected?): ${rendered}`,
    );
  }
  return missing;
}
