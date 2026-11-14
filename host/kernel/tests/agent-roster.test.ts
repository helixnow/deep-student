import { describe, expect, it } from 'vitest';
import {
  APP_EXECUTOR_ROSTER,
  MissingExecutorError,
  PIPELINE_EXECUTOR_TAIL,
  WORKSPACE_COORDINATOR_GROUP,
  composeAppExecutorRoster,
  composePipelineExecutorRoster,
  type NamedExecutor,
} from '../agent-roster.ts';

/**
 * Oracle copied from `src/agent_wiring/tests/descriptor_tests.rs::EXPECTED_ROSTER` —
 * deliberately a second source of truth, so a production order change must update both.
 */
const EXPECTED_ROSTER = [
  'AttemptCompletionExecutor',
  'CanvasToolExecutor',
  'ChatAnkiToolExecutor',
  'BuiltinRetrievalExecutor',
  'InsightRecallExecutor',
  'BuiltinResourceExecutor',
  'ConnectorToolExecutor',
  'TaskAuditExecutor',
  'DstuToolExecutor',
  'AttachmentToolExecutor',
  'FetchExecutor',
  'BrowserToolExecutor',
  'MediaToolExecutor',
  'OfficeFidelityExecutor',
  'McpProposeExecutor',
  'McpManageExecutor',
  'AutomationExecutor',
  'AcademicSearchExecutor',
  'PaperSaveExecutor',
  'KnowledgeExecutor',
  'TodoListExecutor',
  'GoalExecutor',
  'QBankExecutor',
  'TranslationToolExecutor',
  'SettingsModelsToolExecutor',
  'LlmUsageToolExecutor',
  'LearningOverviewExecutor',
  'FsrsSettingsExecutor',
  'DataGovernanceToolExecutor',
  'MemoryToolExecutor',
  'UserTodoExecutor',
  'SkillsExecutor',
  'TemplateDesignerExecutor',
  'TextbookPdfToolExecutor',
  'IndexWebpageToolExecutor',
  'AskUserExecutor',
  'SessionToolExecutor',
  'DocxToolExecutor',
  'PptxToolExecutor',
  'XlsxToolExecutor',
  'ImageGenerationExecutor',
  'GenerativeUiExecutor',
  'WorkspaceFsExecutor',
  'LspNavigationExecutor',
  'CodeNavigationExecutor',
  'FileManagerExecutor',
  'AttachmentStageExecutor',
  'NotesImportExecutor',
  'SkillInstallExecutor',
  'SkillMarketReadToolExecutor',
  'SkillMarketInstallToolExecutor',
  'SkillWorkshopExecutor',
  'SkillLifecycleExecutor',
  'LocalShellPreflightExecutor',
  'GitToolExecutor',
  'SelfInspectExecutor',
  'RolePackExecutor',
  'RuntimeRootRequestExecutor',
  'LocalShellExecuteExecutor',
  'EssayGradingExecutor',
  'ReviewToolExecutor',
  'DocumentProcessingExecutor',
  'WorkbenchToolExecutor',
  'WorkspaceToolExecutor',
  'SubagentExecutor',
  'SuperSessionExecutor',
  'CustomAgentExecutor',
  'CoordinatorSleepExecutor',
  'ToolPackExecutor',
  'PtcExecutor',
  'GeneralToolExecutor',
] as const;

class RosterDouble implements NamedExecutor {
  readonly executorName: string;

  constructor(executorName: string) {
    this.executorName = executorName;
  }
  name(): string { return this.executorName; }
}

function catalog(executors: readonly NamedExecutor[]): Map<string, NamedExecutor> {
  return new Map(executors.map(executor => [executor.name(), executor]));
}

function doubles(names: readonly string[]): RosterDouble[] {
  return names.map(name => new RosterDouble(name));
}

describe('src/agent_wiring/roster.rs composition', () => {
  it('app_executor_roster_matches_expected_roster', () => {
    const workspace = true;
    const all = [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP, ...PIPELINE_EXECUTOR_TAIL];
    const registry = composePipelineExecutorRoster(catalog(doubles(all)), { workspace });
    expect(registry.map(executor => executor.name())).toEqual(EXPECTED_ROSTER);
  });

  it('app_executor_roster_without_workspace_omits_only_coordinator_group', () => {
    const all = [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP];
    const registry = composeAppExecutorRoster(catalog(doubles(all)), { workspace: false });
    const expected = EXPECTED_ROSTER.filter(name =>
      !(WORKSPACE_COORDINATOR_GROUP as readonly string[]).includes(name)
      && !(PIPELINE_EXECUTOR_TAIL as readonly string[]).includes(name));
    expect(registry.map(executor => executor.name())).toEqual(expected);
  });

  it('missing executors are reported once, in roster order, instead of silently skipped', () => {
    const all = [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP];
    const incomplete = catalog(doubles(all).filter(executor => executor.name() !== 'QBankExecutor' && executor.name() !== 'SubagentExecutor'));
    expect(() => composeAppExecutorRoster(incomplete, { workspace: true })).toThrow(MissingExecutorError);
    try {
      composeAppExecutorRoster(incomplete, { workspace: true });
    } catch (error) {
      expect((error as MissingExecutorError).names).toEqual(['QBankExecutor', 'SubagentExecutor']);
    }
  });
});
