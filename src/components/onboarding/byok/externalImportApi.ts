import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { dispatchTypedEvent } from '@/events';
import type { ModelProfile, VendorConfig } from '@/types';
import { isWebUiShell } from '@/utils/platform';
import type {
  ExternalCandidateModelDto,
  ExternalLlmImportResult,
  ExternalLlmScanReport,
  ExternalVendorCandidateDto,
  ExternalVendorImportSelection,
} from '../../../../contracts/ipc/generated/L02-llm-manager';

export type {
  ExternalCandidateModelDto,
  ExternalLlmImportResult,
  ExternalLlmScanReport,
  ExternalVendorCandidateDto,
  ExternalVendorImportSelection,
};

/**
 * 判断剪贴板粘贴内容是否为外部工具结构化配置（如 `ccswitch://` 深链、`.env` 块、JSON 或 TOML），
 * 以便从单密钥快速输入框无缝跳转至外部工具导入预览向导。
 */
export function looksLikeStructuredExternalConfig(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false;
  if (/^ccswitch:\/\//i.test(trimmed)) return true;
  if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`[]?(?:providers|universal_providers)/i.test(trimmed)) {
    return true;
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return true;
  }
  if (/\[model_providers\.[^\]]+\]/i.test(trimmed)) return true;
  if (
    /(?:^|\n|\s)(?:export\s+|set\s+|\$env:)?(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL)\s*=/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

export async function scanExternalLlmConfigs(options?: {
  textInput?: string | null;
  filePath?: string | null;
}): Promise<ExternalLlmScanReport> {
  return invoke<ExternalLlmScanReport>('scan_external_llm_configs', {
    textInput: options?.textInput ?? null,
    filePath: options?.filePath ?? null,
  });
}

export async function probeExternalCandidateModels(
  sessionId: string,
  candidateId: string,
): Promise<ExternalCandidateModelDto[]> {
  return invoke<ExternalCandidateModelDto[]>('probe_external_llm_candidate_models', {
    sessionId,
    candidateId,
  });
}

export async function importExternalLlmConfigs(options: {
  sessionId: string;
  selections: ExternalVendorImportSelection[];
  autoFetchMissingModels?: boolean;
  autoAssignEmptySlots?: boolean;
}): Promise<ExternalLlmImportResult> {
  const result = await invoke<ExternalLlmImportResult>('import_external_llm_configs', {
    sessionId: options.sessionId,
    selections: options.selections,
    autoFetchMissingModels: options.autoFetchMissingModels ?? true,
    autoAssignEmptySlots: options.autoAssignEmptySlots ?? true,
  });

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      const [vendors, modelProfiles] = await Promise.all([
        invoke<VendorConfig[]>('get_vendor_configs'),
        invoke<ModelProfile[]>('get_model_profiles'),
      ]);
      dispatchTypedEvent('api_configurations_changed', { vendors, modelProfiles });
      dispatchTypedEvent('model_assignments_changed');
    } catch {
      // 忽略测试环境或非窗口上下文中的刷新广播异常
    }
  }

  return result;
}

export type PickedExternalConfigInput =
  | { kind: 'path'; filePath: string }
  | { kind: 'text'; text: string }
  | null;

function pickTextFileInBrowser(): Promise<PickedExternalConfigInput> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.jsonc,.sql,.toml,.env,.txt';
    let settled = false;
    const finish = (val: PickedExternalConfigInput) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        const text = await file.text();
        finish({ kind: 'text', text });
      } catch {
        finish(null);
      }
    };
    input.oncancel = () => finish(null);
    input.click();
  });
}

export async function pickExternalConfigSource(dialogTitle: string): Promise<PickedExternalConfigInput> {
  if (isWebUiShell()) {
    return pickTextFileInBrowser();
  }
  const selected = await openFileDialog({
    title: dialogTitle,
    multiple: false,
    directory: false,
    filters: [
      {
        name: dialogTitle,
        extensions: ['db', 'sqlite', 'sqlite3', 'sql', 'json', 'jsonc', 'toml', 'env'],
      },
    ],
  });
  if (typeof selected === 'string' && selected.trim() !== '') {
    return { kind: 'path', filePath: selected.trim() };
  }
  return null;
}
