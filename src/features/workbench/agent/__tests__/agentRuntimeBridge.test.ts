import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
}));

vi.mock('../bridge', () => ({ emitAcrProgress: vi.fn() }));

vi.mock('../../core/scheduler', async () => {
  const actual = await vi.importActual<typeof import('../../core/scheduler')>(
    '../../core/scheduler',
  );
  return {
    ...actual,
    requestWakePrefetch: vi.fn(),
    reportSchedulerActivity: vi.fn(),
  };
});

import { appRegistry } from '../../core/appRegistry';
import { resetAgentUndoJournalForTests } from '../../core/agentUndoJournal';
import type { AppDefinition } from '../../core/types';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { resetRunLedgerForTests } from '../ledger';
import {
  resetStageManagerForTests,
  setAgentControlForTests,
  stageManager,
} from '../stageManager';
import type { AcrBridgeRequest } from '../types';
import { getAcrCommandAccess } from '../types';

const TYPE_ID = 'acr2-stage-bridge-test';
let count = 0;
let revision = 0;

appRegistry.register({
  typeId: TYPE_ID,
  nameKey: 'workbench:test.acr2-bridge',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  agentManifest: {
    version: '2.0-test',
    capabilities: [
      {
        name: 'inspect',
        description: 'Read current count',
        inputSchema: { type: 'object', additionalProperties: false },
        risk: 'read',
        mutates: false,
        reversible: false,
        idempotent: true,
      },
      {
        name: 'setCount',
        description: 'Set current count',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
          additionalProperties: false,
        },
        risk: 'low',
        mutates: true,
        reversible: true,
        idempotent: true,
        targetKinds: ['counter'],
      },
      {
        name: 'dangerousSet',
        description: 'High-risk count replacement',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
          additionalProperties: false,
        },
        risk: 'high',
        mutates: true,
        reversible: false,
        idempotent: true,
      },
    ],
    observe: () => ({
      revision: `bridge:${revision}`,
      state: { count },
      availableActions: ['inspect', 'setCount', 'dangerousSet'],
      affordances: [{
        ref: 'bridge:counter:main',
        kind: 'counter',
        actions: ['setCount'],
      }],
    }),
    execute: (_ctx, action) => {
      if (action.name === 'inspect') {
        return { handled: true, changed: false, details: { count } };
      }
      if (action.name !== 'setCount' && action.name !== 'dangerousSet') {
        return { handled: false };
      }
      const previous = count;
      count = Number((action.args as { value: number }).value);
      revision += 1;
      return {
        handled: true,
        changed: true,
        ...(action.name === 'setCount'
          ? {
              undo: {
                inverse: {
                  name: 'setCount',
                  args: { value: previous },
                  targetRef: 'bridge:counter:main',
                },
              },
            }
          : {}),
      };
    },
  },
});

function request(
  command: AcrBridgeRequest['command'],
  args: unknown = {},
  suffix = command,
): AcrBridgeRequest {
  return {
    correlationId: `corr-${suffix}`,
    command,
    args,
    timeoutMs: 30_000,
    runId: `run-${suffix}`,
    sessionId: 'sess-acr2',
  };
}

describe('ACR 2.0 Stage bridge', () => {
  let windowId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetRunLedgerForTests();
    resetAgentUndoJournalForTests({ clearStorage: true });
    resetWindowStoreForTests({ w: 1200, h: 800 });
    workbenchBus.setEnabled(true);
    count = 0;
    revision = 0;
    windowId = useWindowStore.getState().openWindow({
      typeId: TYPE_ID,
      instanceKey: 'bridge-1',
      title: 'Bridge fixture',
    });
    stageManager.start();
    setAgentControlForTests('background');
  });

  afterEach(() => {
    resetStageManagerForTests();
    resetRunLedgerForTests();
    workbenchBus.setEnabled(false);
  });

  it('routes capability discovery and structured observation', async () => {
    expect(getAcrCommandAccess('get_capabilities')).toBe('read-only');
    expect(getAcrCommandAccess('act')).toBe('dynamic');

    const capabilities = await stageManager.handleBridgeRequest(request(
      'get_capabilities',
      { windowId },
    ));
    expect(capabilities).toMatchObject({
      ok: true,
      data: { apps: [{ typeId: TYPE_ID, manifestVersion: '2.0-test' }] },
    });

    const observed = await stageManager.handleBridgeRequest(request('observe', { windowId }));
    expect(observed).toMatchObject({
      ok: true,
      data: {
        windowId,
        availableActions: ['inspect', 'setCount', 'dangerousSet'],
        state: { count: 0 },
      },
    });
  });

  it('allows read-only act while control is off and rejects stale or under-approved writes', async () => {
    const observed = await stageManager.handleBridgeRequest(request('observe', { windowId }));
    const observationRevision = (observed.data as { revision: string }).revision;
    setAgentControlForTests('off');

    const inspect = await stageManager.handleBridgeRequest(request('act', {
      windowId,
      observationRevision,
      approvalRiskCeiling: 'medium',
      actions: [{ name: 'inspect', args: {} }],
    }, 'inspect-off'));
    expect(inspect).toMatchObject({
      ok: true,
      data: {
        status: 'completed',
        results: [{ verificationSource: 'read-only-observation' }],
      },
    });

    const blockedWrite = await stageManager.handleBridgeRequest(request('act', {
      windowId,
      observationRevision,
      approvalRiskCeiling: 'medium',
      actions: [{
        name: 'setCount',
        args: { value: 4 },
        targetRef: 'bridge:counter:main',
      }],
    }, 'write-off'));
    expect(JSON.parse(blockedWrite.error!)).toMatchObject({
      code: 'WORKBENCH_DISABLED',
    });
    expect(count).toBe(0);

    setAgentControlForTests('background');
    const legacyHighRisk = await stageManager.handleBridgeRequest(request('app_command', {
      typeId: TYPE_ID,
      instanceKey: 'bridge-1',
      action: 'dangerousSet',
      payload: { value: 5 },
    }, 'legacy-high-risk'));
    expect(JSON.parse(legacyHighRisk.error!)).toMatchObject({
      code: 'RISK_APPROVAL_REQUIRED',
    });
    expect(count).toBe(0);

    const underApproved = await stageManager.handleBridgeRequest(request('act', {
      windowId,
      observationRevision,
      approvalRiskCeiling: 'medium',
      actions: [{ name: 'dangerousSet', args: { value: 5 } }],
    }, 'risk'));
    expect(JSON.parse(underApproved.error!)).toMatchObject({
      code: 'RISK_APPROVAL_REQUIRED',
      retryable: false,
    });

    count = 3;
    revision += 1;
    const stale = await stageManager.handleBridgeRequest(request('act', {
      windowId,
      observationRevision,
      approvalRiskCeiling: 'high',
      actions: [{ name: 'dangerousSet', args: { value: 6 } }],
    }, 'stale'));
    expect(JSON.parse(stale.error!)).toMatchObject({
      code: 'STALE_OBSERVATION',
      retryable: true,
    });
  });

  it('returns a persistent token consumable through existing revert_run', async () => {
    const observed = await stageManager.handleBridgeRequest(request('observe', { windowId }));
    const observationRevision = (observed.data as { revision: string }).revision;
    const acted = await stageManager.handleBridgeRequest(request('act', {
      windowId,
      observationRevision,
      approvalRiskCeiling: 'medium',
      actions: [{
        name: 'setCount',
        args: { value: 11 },
        targetRef: 'bridge:counter:main',
      }],
    }, 'set'));
    expect(acted).toMatchObject({
      ok: true,
      data: { status: 'completed', undoDurability: 'persistent' },
    });
    expect(count).toBe(11);
    const undoToken = (acted.data as { undoToken: string }).undoToken;

    resetAgentUndoJournalForTests();
    const reverted = await stageManager.handleBridgeRequest(request(
      'revert_run',
      { undoToken },
      'persistent-revert',
    ));
    expect(reverted).toMatchObject({
      ok: true,
      data: { reverted: true, undoToken, durability: 'persistent' },
    });
    expect(count).toBe(0);
  });
});
