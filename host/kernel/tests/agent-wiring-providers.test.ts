/**
 * `src/agent_wiring/tests/legacy_tests.rs` 中只依赖注册表构建器的两个用例。
 *
 * Rust 的 `production_registry()` 需要 app 域全部执行器（L03/L04 尚未发布），但这两条断言
 * 测的是 F1 自己的 `ToolRegistryBuilder`：重复工具名报 `DuplicateToolName`、第二个
 * catch-all provider 报 `MultipleCatchAllProviders`（先于重复 provider id 检查）。
 * 测试替身与 Rust 的 `ConflictingProvider` 相同，只提供输入，不替被测逻辑。
 */
import { expect, it } from 'vitest';
import { ToolDescriptor, ToolRegistryBuilder, ToolRegistryError, type ToolProvider } from '../agent-api.ts';

/** `chat_v2/tools/legacy_tool_provider.rs:37` 的 `LEGACY_PROVIDER_ID`。 */
const LEGACY_PROVIDER_ID = 'chat_v2.legacy';

interface NamedExecutor {
  name: string;
}

function executor(name: string): NamedExecutor {
  return { name };
}

/** 只声明 `note_read` 的领域 provider，对应 Rust `ConflictingProvider`。 */
function conflictingProvider(): ToolProvider<NamedExecutor> {
  const note = executor('note_read');
  const descriptor = new ToolDescriptor('note_read');
  return {
    id: 'test.conflict',
    descriptors: () => [descriptor],
    executor: name => (name === 'note_read' ? note : undefined),
    executors: () => [note],
  };
}

/** `LegacyToolProvider` 的 catch-all 形状：按名分发 `note_read`，其余交给兜底执行器。 */
function legacyProvider(): ToolProvider<NamedExecutor> {
  const note = executor('note_read');
  const general = executor('GeneralToolExecutor');
  const descriptor = new ToolDescriptor('note_read');
  return {
    id: LEGACY_PROVIDER_ID,
    descriptors: () => [descriptor],
    executor: name => (name === 'note_read' ? note : general),
    executors: () => [note, general],
    isCatchAll: () => true,
  };
}

function buildError(...providers: ToolProvider<NamedExecutor>[]): ToolRegistryError {
  const builder = new ToolRegistryBuilder<NamedExecutor>();
  for (const provider of providers) builder.register(provider);
  try {
    builder.build();
  } catch (error) {
    if (error instanceof ToolRegistryError) return error;
    throw error;
  }
  throw new Error('expected registry error');
}

it('conflicting_domain_provider_is_rejected', () => {
  const error = buildError(conflictingProvider(), legacyProvider());
  expect(error).toMatchObject({
    code: 'DuplicateToolName',
    fields: { name: 'note_read', first: 'test.conflict', second: LEGACY_PROVIDER_ID },
  });
});

it('second_catch_all_provider_is_rejected', () => {
  // Rust 传入两个 `LegacyToolProvider`（同一个 provider id）；catch-all 检查先于重复 id 检查。
  const error = buildError(legacyProvider(), legacyProvider());
  expect(error.code).toBe('MultipleCatchAllProviders');
});
