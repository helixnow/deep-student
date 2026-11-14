/**
 * Schema tool injector, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/injector.rs`.
 *
 * Rust keeps a process-global `SchemaToolRegistry`; the host passes an explicit
 * registry so the kernel can construct it per application instead of relying on
 * module-level mutable state.
 */
import { utf8ByteLength } from '../../../../platform/util/portable.ts';

export const TOOL_SCHEMA_TOKEN_WARNING_THRESHOLD = 4000;

export interface ToolSchemaRegistry {
  /** `get_schemas`: unknown IDs are skipped in input order. */
  getSchemas(toolIds: readonly string[]): unknown[];
}

/** Minimal ordered registry mirroring `SchemaToolRegistry`. */
export interface ToolInjectorLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export class InMemoryToolSchemaRegistry implements ToolSchemaRegistry {
  private readonly definitions = new Map<string, unknown>();
  private readonly logger: ToolInjectorLogger;

  constructor(logger: ToolInjectorLogger = {}) { this.logger = logger; }

  register(toolId: string, schema: unknown): this {
    this.definitions.set(toolId, schema);
    return this;
  }

  getSchemas(toolIds: readonly string[]): unknown[] {
    const schemas: unknown[] = [];
    for (const id of toolIds) {
      if (this.definitions.has(id)) schemas.push(this.definitions.get(id));
      else this.logger.warn?.(`[SchemaToolRegistry] Tool not found: '${id}', skipping`);
    }
    return schemas;
  }

  get length(): number {
    return this.definitions.size;
  }
}

/**
 * Inject `custom_tools` into the LLM context and return the injected count.
 * `schemaToolIds` null/undefined/empty is a silent no-op (Rust 23–39).
 */
export function injectToolSchemas(
  schemaToolIds: readonly string[] | null | undefined,
  llmContext: Map<string, unknown>,
  registry: ToolSchemaRegistry,
  logger: ToolInjectorLogger = {},
): number {
  if (schemaToolIds === null || schemaToolIds === undefined || schemaToolIds.length === 0) {
    logger.debug?.('[ToolInjector] No schema_tool_ids provided, skipping injection');
    return 0;
  }

  const schemas = registry.getSchemas(schemaToolIds);
  const count = schemas.length;
  if (count === 0) {
    logger.warn?.(`[ToolInjector] No valid schemas found for tool_ids: ${JSON.stringify(schemaToolIds)}`);
    return 0;
  }

  const serialized = JSON.stringify(schemas);
  const serializedBytes = utf8ByteLength(serialized);
  const estimatedTokens = Math.floor(serializedBytes / 4);
  if (estimatedTokens > TOOL_SCHEMA_TOKEN_WARNING_THRESHOLD) {
    logger.warn?.(
      `[ToolInjector] Tool schemas occupy ~${estimatedTokens} tokens (${serializedBytes} chars), `
      + `exceeding warning threshold of ${TOOL_SCHEMA_TOKEN_WARNING_THRESHOLD}. Consider reducing active tools.`,
    );
  }

  llmContext.set('custom_tools', schemas);
  logger.debug?.(
    `[ToolInjector] Injected ${count} tool schemas (~${estimatedTokens} tokens): `
    + JSON.stringify(schemaToolIds),
  );
  return count;
}
