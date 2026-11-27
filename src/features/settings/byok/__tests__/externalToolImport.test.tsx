import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { QuickByokProvisionerCard } from '@/components/onboarding/byok/QuickByokProvisionerCard';
import { looksLikeStructuredExternalConfig } from '@/components/onboarding/byok/externalImportApi';
import type { ExternalLlmScanReport } from '../../../../contracts/ipc/generated/L02-llm-manager';

const mockInvokeCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
const mockScanReport: ExternalLlmScanReport = {
  sessionId: 'ext_scan_test_1',
  autoScanSupported: true,
  sources: [
    {
      source: 'cc-switch',
      pathLabel: '~/.cc-switch/cc-switch.db',
      candidateCount: 1,
      error: null,
    },
  ],
  candidates: [
    {
      candidateId: 'cand_1',
      name: 'Packy Claude Relay',
      providerType: 'anthropic',
      apiProtocol: 'anthropic_messages',
      supportsOpenaiResponses: false,
      baseUrl: 'https://api.packycode.com',
      websiteUrl: 'https://packycode.com',
      maskedApiKey: 'sk-ant-••••9999',
      extraKeyCount: 1,
      sources: ['cc-switch'],
      appTypes: ['claude'],
      syncStatus: 'new',
      matchedVendorId: null,
      matchedVendorName: null,
      models: [
        {
          id: 'claude-sonnet-5',
          label: 'claude-sonnet-5',
          contextWindow: 200000,
          maxOutputTokens: 16384,
          alreadyExists: false,
          recommended: true,
        },
      ],
    },
  ],
  skippedProxyCount: 1,
  skippedNoKeyCount: 0,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    mockInvokeCalls.push({ cmd, args });
    if (cmd === 'scan_external_llm_configs') {
      return mockScanReport;
    }
    if (cmd === 'probe_external_llm_candidate_models') {
      return [
        ...mockScanReport.candidates[0]!.models,
        {
          id: 'claude-haiku-4-5',
          label: 'claude-haiku-4-5',
          contextWindow: 200000,
          maxOutputTokens: 8192,
          alreadyExists: false,
          recommended: true,
        },
      ];
    }
    if (cmd === 'import_external_llm_configs') {
      return {
        importedVendorCount: 1,
        updatedVendorCount: 0,
        importedModelCount: 2,
        assignedSlotCount: 6,
        warnings: [],
        vendorIds: ['vendor_1'],
      };
    }
    if (cmd === 'get_vendor_configs' || cmd === 'get_model_profiles') {
      return [];
    }
    return null;
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}));

describe('ExternalToolImportPanel & QuickByokProvisionerCard inline integration', () => {
  beforeEach(() => {
    mockInvokeCalls.length = 0;
  });

  it('distinguishes structured external configs from plain API keys', () => {
    expect(looksLikeStructuredExternalConfig('sk-1234567890abcdef1234567890')).toBe(false);
    expect(
      looksLikeStructuredExternalConfig(
        'ccswitch://v1/import?resource=provider&app=claude&name=Test&endpoint=https://api.example.com&apiKey=sk-123',
      ),
    ).toBe(true);
    expect(
      looksLikeStructuredExternalConfig(
        'ANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_AUTH_TOKEN=sk-ant-123',
      ),
    ).toBe(true);
    expect(
      looksLikeStructuredExternalConfig(
        '$env:ANTHROPIC_BASE_URL="https://api.example.com"\n$env:ANTHROPIC_AUTH_TOKEN="sk-ant-123"',
      ),
    ).toBe(true);
    expect(
      looksLikeStructuredExternalConfig(
        'ANTHROPIC_BASE_URL=https://api.example.com ANTHROPIC_AUTH_TOKEN=sk-ant-123 claude',
      ),
    ).toBe(true);
    expect(looksLikeStructuredExternalConfig('{"providers":[{"id":"deepseek","key":"sk-1"}]}')).toBe(
      true,
    );
  });

  it('switches inline to ExternalToolImportPanel when pasting a ccswitch:// link into QuickByokProvisionerCard and completes probe + import without opening any modal', async () => {
    render(<QuickByokProvisionerCard mode="settings" defaultCollapsed={false} />);

    const input = screen.getByTestId('byok-key-input');
    const deepLink =
      'ccswitch://v1/import?resource=provider&app=claude&name=Packy&endpoint=https://api.packycode.com&apiKey=sk-ant-9999';

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => deepLink,
      },
    });

    await waitFor(() => {
      expect(
        mockInvokeCalls.some(
          (c) => c.cmd === 'scan_external_llm_configs' && c.args?.textInput === deepLink,
        ),
      ).toBe(true);
    });

    expect(await screen.findByTestId('external-tool-import-panel')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('external-candidate-cand_1')).toBeInTheDocument();

    // Probe additional models on candidate
    fireEvent.click(screen.getByTestId('external-probe-cand_1'));
    await waitFor(() => {
      expect(mockInvokeCalls.some((c) => c.cmd === 'probe_external_llm_candidate_models')).toBe(
        true,
      );
    });
    expect(await screen.findByText('claude-haiku-4-5')).toBeInTheDocument();

    // Confirm import
    fireEvent.click(screen.getByTestId('external-import-confirm-btn'));
    await waitFor(() => {
      const importCall = mockInvokeCalls.find((c) => c.cmd === 'import_external_llm_configs');
      expect(importCall).toBeDefined();
      expect(importCall?.args?.sessionId).toBe('ext_scan_test_1');
      expect(importCall?.args?.selections).toEqual([
        {
          candidateId: 'cand_1',
          selectedModelIds: ['claude-sonnet-5', 'claude-haiku-4-5'],
        },
      ]);
    });
  });

  it('transitions onboarding card into ready state with Start Learning CTA after inline external import', async () => {
    const onCompleted = vi.fn();
    render(<QuickByokProvisionerCard mode="onboarding" onCompleted={onCompleted} />);

    fireEvent.click(screen.getByRole('radio', { name: /从工具导入|Import Tools/ }));
    expect(await screen.findByTestId('external-candidate-cand_1')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('external-import-confirm-btn'));

    const enterBtn = await screen.findByTestId('byok-external-enter-app-button');
    expect(screen.getByTestId('byok-external-import-summary')).toBeInTheDocument();

    fireEvent.click(enterBtn);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
});
