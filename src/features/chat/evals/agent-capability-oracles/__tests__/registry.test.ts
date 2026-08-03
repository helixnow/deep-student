import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AGENT_CAPABILITY_ORACLES } from '../registry';
import { getAgentCapabilityCoverageReport } from '../coverage';

const EXPECTED_FAMILIES = [
  '附件身份', '附件入口', '附件一致性', '工作区', 'Shell审计',
  '浏览器文件桥', '浏览器可靠性', '浏览器平台', '连接器', 'Word', 'Excel',
  'PowerPoint', 'PDF', 'Office 加密', 'Office 宏', 'Office权限', '自动化',
  '多Agent', '协作', '治理', '对抗安全', '学习闭环',
];

describe('agent capability oracle registry', () => {
  it('contains exactly the 84 unique v4 cases with historical fields and initial status', () => {
    expect(AGENT_CAPABILITY_ORACLES).toHaveLength(84);
    expect(new Set(AGENT_CAPABILITY_ORACLES.map((item) => item.id)).size).toBe(84);
    expect(AGENT_CAPABILITY_ORACLES[0]?.id).toBe('ATT-01');
    expect(AGENT_CAPABILITY_ORACLES.at(-1)?.id).toBe('LRN-06');
    for (const item of AGENT_CAPABILITY_ORACLES) {
      expect(item.family).not.toBe('');
      expect(item.setup).not.toBe('');
      expect(item.action).not.toBe('');
      expect(item.oracle).not.toBe('');
      expect(item.anchor).not.toBe('');
      expect(['PASS', 'PARTIAL', 'FAIL', 'UNVERIFIED']).toContain(item.initial_status);
      expect(['PASS', 'PARTIAL', 'FAIL', 'UNVERIFIED']).toContain(item.status);
      expect(['P0', 'P1', 'P2']).toContain(item.risk);
    }
  });

  it('covers every v4 family/risk and gives every P0 a machine check', () => {
    expect([...new Set(AGENT_CAPABILITY_ORACLES.map((item) => item.family))].sort())
      .toEqual([...EXPECTED_FAMILIES].sort());
    expect(new Set(AGENT_CAPABILITY_ORACLES.map((item) => item.risk))).toEqual(
      new Set(['P0', 'P1', 'P2']),
    );
    for (const item of AGENT_CAPABILITY_ORACLES.filter((item) => item.risk === 'P0')) {
      expect(item.machine_check, item.id).toBeDefined();
      if (item.machine_check.kind === 'manual_e2e') {
        expect(item.machine_check.instructions.length, item.id).toBeGreaterThan(40);
      }
    }
  });

  it('binds every automated/implemented item only to existing test and module paths', () => {
    for (const item of AGENT_CAPABILITY_ORACLES) {
      if (item.machine_check.kind !== 'automated_test') continue;
      expect(item.machine_check.refs.length, item.id).toBeGreaterThan(0);
      expect(item.machine_check.module_refs.length, item.id).toBeGreaterThan(0);
      for (const path of [...item.machine_check.refs, ...item.machine_check.module_refs]) {
        expect(existsSync(resolve(process.cwd(), path)), `${item.id}: ${path}`).toBe(true);
      }
      expect(item.status, `${item.id} must not be marked PASS solely by a new contract test`)
        .not.toBe('UNVERIFIED');
    }
    for (const item of AGENT_CAPABILITY_ORACLES.filter((item) => item.status === 'PASS')) {
      expect(item.machine_check.kind, `${item.id} is implemented and needs an automated anchor`)
        .toBe('automated_test');
    }
    expect(AGENT_CAPABILITY_ORACLES.find((item) => item.id === 'WEB-01')).toMatchObject({
      initial_status: 'FAIL',
      status: 'PARTIAL',
    });
    expect(AGENT_CAPABILITY_ORACLES.find((item) => item.id === 'WEB-02')).toMatchObject({
      initial_status: 'FAIL',
      status: 'PARTIAL',
    });
  });

  it('keeps reconciled PASS claims limited to fully automated oracle coverage', () => {
    const passIds = AGENT_CAPABILITY_ORACLES
      .filter((item) => item.status === 'PASS')
      .map((item) => item.id);
    expect(passIds).toEqual([
      'FS-08', 'FS-11', 'WEB-04', 'WEB-10', 'OFF-11',
      'AUT-02', 'AGT-01', 'SECX-04', 'SECX-07', 'SECX-08',
    ]);

    for (const id of ['ATT-05', 'ATT-06', 'CON-01', 'CON-08', 'OFF-10', 'COL-06', 'COL-08']) {
      expect(AGENT_CAPABILITY_ORACLES.find((item) => item.id === id)?.status, id)
        .toBe('PARTIAL');
    }
    for (const id of ['FS-12', 'OFF-05', 'AUT-07']) {
      expect(AGENT_CAPABILITY_ORACLES.find((item) => item.id === id)?.status, id)
        .toBe('UNVERIFIED');
    }
  });

  it('builds release-gate coverage by family, status, and risk without changing totals', () => {
    const report = getAgentCapabilityCoverageReport();
    expect(report.total).toBe(84);
    expect(report.overall.total).toBe(84);
    expect(Object.values(report.overall.byStatus).reduce((sum, count) => sum + count, 0)).toBe(84);
    expect(Object.values(report.overall.byRisk).reduce((sum, count) => sum + count, 0)).toBe(84);
    expect(Object.values(report.byFamily).reduce((sum, bucket) => sum + bucket.total, 0)).toBe(84);
    expect(report.overall.byStatus).toEqual({
      PASS: 10,
      PARTIAL: 52,
      FAIL: 19,
      UNVERIFIED: 3,
    });
    expect(report.releaseGate.p0MissingMachineCheck).toBe(0);
    expect(report.releaseGate.blocked).toBe(true);
  });
});
