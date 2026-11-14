/** Public routing metadata for F1/L04. Execution bodies remain tracked in TESTMAP. */
import type { ToolConcurrency, ToolSensitivity } from '../../chat/api.ts';
import { academicSearchCanHandle, academicSearchSensitivity } from './academic-search.ts';
import {
  learningOverviewCanHandle, learningOverviewConcurrency, learningOverviewSensitivity,
} from './learning-overview.ts';
import { isMemoryTool, memoryConcurrency, memorySensitivity } from './memory-executor.ts';

export interface MemoryExecutorMetadata {
  name(): string;
  canHandle(toolName: string): boolean;
  sensitivityLevel(toolName: string): ToolSensitivity;
  concurrencyClass(toolName: string): ToolConcurrency;
}

export interface MemoryToolMetadata {
  readonly memory: MemoryExecutorMetadata;
  readonly academicSearch: MemoryExecutorMetadata;
  readonly learningOverview: MemoryExecutorMetadata;
}

/** The same instances are exposed as a service and contributed to agentTools. */
export function createMemoryToolMetadata(): MemoryToolMetadata {
  return {
    memory: {
      name: () => 'MemoryToolExecutor',
      canHandle: isMemoryTool,
      sensitivityLevel: memorySensitivity,
      concurrencyClass: memoryConcurrency,
    },
    academicSearch: {
      name: () => 'AcademicSearchExecutor',
      canHandle: academicSearchCanHandle,
      sensitivityLevel: academicSearchSensitivity,
      // academic_search_executor.rs:1001-1003: both external searches are read-only.
      concurrencyClass: () => 'read_only',
    },
    learningOverview: {
      name: () => 'LearningOverviewExecutor',
      canHandle: learningOverviewCanHandle,
      sensitivityLevel: learningOverviewSensitivity,
      concurrencyClass: learningOverviewConcurrency,
    },
  };
}
