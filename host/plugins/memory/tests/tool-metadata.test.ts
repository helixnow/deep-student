import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import { createMemoryToolMetadata, type MemoryToolMetadata } from '../api.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('F1 memory executor metadata', () => {
  it('registers the executable memory executor and the public academic/learning metadata instances', async () => {
    const registry = new AgentToolExecutorRegistry();
    current = await setupMemoryHost({ agentTools: {
      registerToolExecutors: executors => registry.register(executors),
    } });
    const metadata = current.host.ctx.get('memoryToolMetadata') as MemoryToolMetadata;
    const registered = registry.all();
    expect(registered.map(executor => executor.name())).toEqual([
      'MemoryToolExecutor', 'AcademicSearchExecutor', 'PaperSaveExecutor', 'LearningOverviewExecutor',
      'InsightRecallExecutor', 'KnowledgeExecutor',
    ]);
    const memoryExecutor = registered[0]!;
    expect(typeof memoryExecutor.execute).toBe('function');
    for (const tool of ['memory_search', 'memory_read', 'memory_list']) {
      expect(memoryExecutor.sensitivityLevel?.(tool)).toBe(metadata.memory.sensitivityLevel(tool));
      expect(memoryExecutor.concurrencyClass?.(tool)).toBe(metadata.memory.concurrencyClass(tool));
    }
    // Learning overview is executable and routes exactly like its published metadata.
    const learning = registered[3]!;
    expect(typeof learning.execute).toBe('function');
    for (const tool of ['learning_overview', 'pomodoro_today_stats', 'pomodoro_daily_stats', 'pomodoro_create']) {
      expect(learning.canHandle(tool)).toBe(metadata.learningOverview.canHandle(tool));
      expect(learning.sensitivityLevel?.(tool)).toBe(metadata.learningOverview.sensitivityLevel(tool));
      expect(learning.concurrencyClass?.(tool)).toBe(metadata.learningOverview.concurrencyClass(tool));
    }
    // Academic search is executable and routes exactly like its published metadata.
    const academic = registered[1]!;
    expect(typeof academic.execute).toBe('function');
    for (const tool of ['arxiv_search', 'scholar_search', 'web_search', 'paper_save']) {
      expect(academic.canHandle(tool)).toBe(metadata.academicSearch.canHandle(tool));
      expect(academic.sensitivityLevel?.(tool)).toBe(metadata.academicSearch.sensitivityLevel(tool));
      expect(academic.concurrencyClass?.(tool)).toBe(metadata.academicSearch.concurrencyClass(tool));
    }
  });

  it('phase9_memory_tools_have_explicit_sensitivity_and_concurrency through the public entry', () => {
    const { memory } = createMemoryToolMetadata();
    for (const tool of ['memory_search', 'memory_read', 'memory_list', 'memory_export_all']) {
      expect(memory.canHandle(`builtin-${tool}`)).toBe(true);
      expect(memory.concurrencyClass(`builtin-${tool}`)).toBe('read_only');
    }
    for (const tool of ['memory_write', 'memory_update_by_id', 'memory_delete', 'memory_write_smart',
      'memory_write_batch', 'memory_batch_move', 'memory_add_relation', 'memory_remove_relation',
      'memory_update_tags', 'memory_log_activity', 'learner_profile_get', 'learner_profile_update']) {
      expect(memory.canHandle(`builtin-${tool}`)).toBe(true);
      expect(memory.sensitivityLevel(`builtin-${tool}`)).toBe('medium');
      expect(memory.concurrencyClass(`builtin-${tool}`)).toBe('serial');
    }
    expect(memory.sensitivityLevel('builtin-memory_export_all')).toBe('high');
    expect(memory.sensitivityLevel('builtin-memory_search')).toBe('low');
    expect(memory.canHandle('builtin-rag_search')).toBe(false);
  });

  it('publishes the actual academic and learning routing policies without a second classification table', () => {
    const { academicSearch, learningOverview } = createMemoryToolMetadata();
    for (const tool of ['arxiv_search', 'scholar_search']) {
      expect(academicSearch.canHandle(`builtin-${tool}`)).toBe(true);
      expect(academicSearch.sensitivityLevel(`builtin-${tool}`)).toBe('low');
      expect(academicSearch.concurrencyClass(`builtin-${tool}`)).toBe('read_only');
    }
    expect(academicSearch.canHandle('builtin-web_search')).toBe(false);
    for (const tool of ['learning_overview', 'pomodoro_today_stats', 'pomodoro_daily_stats']) {
      expect(learningOverview.canHandle(`builtin-${tool}`)).toBe(true);
      expect(learningOverview.canHandle(`mcp_${tool}`)).toBe(true);
      expect(learningOverview.sensitivityLevel(`builtin-${tool}`)).toBe('low');
      expect(learningOverview.concurrencyClass(`builtin-${tool}`)).toBe('read_only');
    }
    expect(learningOverview.canHandle('builtin-pomodoro_create')).toBe(false);
  });
});
