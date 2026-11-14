import { expect, it } from 'vitest';
import * as api from '../api.ts';
import type {
  ChatAnkiRoute, NormalizedTransformOp, RouteDecision, RoutePlan, ScriptCardPlan,
  TransformCardPlan, TransformFields,
} from '../api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import chatanki from '../index.ts';

type PublishedTypes = [
  ChatAnkiRoute, NormalizedTransformOp, RouteDecision, RoutePlan, ScriptCardPlan,
  TransformCardPlan, TransformFields,
];

/**
 * L16 `anki-ai-native-chatanki-integration.test.ts` imports these 14 runtime
 * functions from this lane. They must stay published through `api.ts` so the
 * consumer does not need a cross-plugin implementation import.
 */
it('publishes the transform/script/route functions L16 imports', () => {
  const runtime = [
    api.ExpectedVersionsMismatch,
    api.InvalidPatternError,
    api.TransformSelectionError,
    api.applyTransformOps,
    api.changedFieldNames,
    api.checkExpectedVersions,
    api.compileTransformOps,
    api.normalizeTransformArgs,
    api.parseTransformArgs,
    api.planTransformOps,
    api.selectTransformCards,
    api.transformFieldsAreValid,
    api.transformFieldsFromCard,
    api.buildScriptInput,
    api.evaluateScriptOutput,
    api.resolveInterpreterInDirs,
    api.textHasValidClozeMarkup,
    api.transformSandboxPolicy,
    api.buildAnalyzeOutput,
    api.parseRoutePlanResponse,
    api.resolveRouteDecision,
    api.routePlanIsConfident,
    api.parseChatAnkiRetemplateStrategy,
  ];
  for (const value of runtime) expect(value).toBeDefined();
});

const _publishedTypes: PublishedTypes | null = null;
void _publishedTypes;

it('publishes the real production executor factory for independent F1 metadata checks', async () => {
  const executors = api.createChatAnkiExecutors();
  // custom_agent_tests.rs:29-36: the readonly four are handled and Low.
  // Profile filtering/order stays in F1's test; no tool business is invoked here.
  for (const tool of [
    'builtin-chatanki_get_cards', 'builtin-chatanki_status',
    'builtin-chatanki_analyze', 'builtin-chatanki_list_templates',
  ]) {
    const executor = executors.find((candidate) => candidate.canHandle(tool));
    expect(executor, tool).toBeDefined();
    expect(executor!.sensitivityLevel(tool), tool).toBe('low');
  }
  const host = await createTestHost({
    plugins: [chatanki], provide: { settings: {}, review: {}, llm: {}, anki: {} },
  });
  try {
    // index.ts uses the factory, with the original handlers and dispatch order.
    expect(host.ctx.chatankiTools.executors.map((executor) => executor.constructor))
      .toEqual(executors.map((executor) => executor.constructor));
  } finally {
    await host.dispose();
  }
});
