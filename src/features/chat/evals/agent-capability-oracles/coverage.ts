import {
  AGENT_CAPABILITY_ORACLES,
  type AgentCapabilityOracle,
  type OracleRisk,
  type OracleStatus,
} from './registry';

export interface CoverageBucket {
  total: number;
  byStatus: Record<OracleStatus, number>;
  byRisk: Record<OracleRisk, number>;
  automated: number;
  manual: number;
}

export interface AgentCapabilityCoverageReport {
  generatedFrom: 'agent-capability-oracles';
  total: number;
  overall: CoverageBucket;
  byFamily: Record<string, CoverageBucket>;
  releaseGate: {
    p0Total: number;
    p0Pass: number;
    p0Partial: number;
    p0Fail: number;
    p0Unverified: number;
    p0MissingMachineCheck: number;
    blocked: boolean;
  };
}

function emptyBucket(): CoverageBucket {
  return {
    total: 0,
    byStatus: { PASS: 0, PARTIAL: 0, FAIL: 0, UNVERIFIED: 0 },
    byRisk: { P0: 0, P1: 0, P2: 0 },
    automated: 0,
    manual: 0,
  };
}

function add(bucket: CoverageBucket, item: AgentCapabilityOracle): void {
  bucket.total += 1;
  bucket.byStatus[item.status] += 1;
  bucket.byRisk[item.risk] += 1;
  bucket[item.machine_check.kind === 'automated_test' ? 'automated' : 'manual'] += 1;
}

export function getAgentCapabilityCoverageReport(
  cases: readonly AgentCapabilityOracle[] = AGENT_CAPABILITY_ORACLES,
): AgentCapabilityCoverageReport {
  const overall = emptyBucket();
  const byFamily: Record<string, CoverageBucket> = {};
  for (const item of cases) {
    add(overall, item);
    const family = byFamily[item.family] ?? (byFamily[item.family] = emptyBucket());
    add(family, item);
  }
  const p0 = cases.filter((item) => item.risk === 'P0');
  const p0Count = (status: OracleStatus) => p0.filter((item) => item.status === status).length;
  const p0MissingMachineCheck = p0.filter((item) => !item.machine_check).length;
  const p0Fail = p0Count('FAIL');
  const p0Unverified = p0Count('UNVERIFIED');
  return {
    generatedFrom: 'agent-capability-oracles',
    total: cases.length,
    overall,
    byFamily,
    releaseGate: {
      p0Total: p0.length,
      p0Pass: p0Count('PASS'),
      p0Partial: p0Count('PARTIAL'),
      p0Fail,
      p0Unverified,
      p0MissingMachineCheck,
      blocked: p0MissingMachineCheck > 0 || p0Fail > 0 || p0Unverified > 0,
    },
  };
}
