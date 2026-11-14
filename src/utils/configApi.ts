import { invoke } from '@tauri-apps/api/core';
import type { VendorConfig, ModelProfile, ApiConfig } from '../types';
// ★ 2026-07-08（审计 30-P1-2）：错误重抛统一走 getErrorMessage，
// 避免 `${error}` 对对象错误产生 "[object Object]"，且保留结构化 message 可解析性
import { getErrorMessage } from './errorUtils';

// 文件管理API
export async function getImageAsBase64(relativePath: string): Promise<string> {
  try {
    // 契约参数为 camelCase `relativePath`（必填）；snake_case 回退必然被拒绝，只会掩盖真实错误。
    try {
      const response = await invoke<string>('get_image_as_base64', { relativePath });
      return response;
    } catch (commandError) {
      // 兜底：前端通过 convertFileSrc + fetch 读取文件
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const assetUrl = convertFileSrc(relativePath);
        const resp = await fetch(assetUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const arr = await blob.arrayBuffer();
        const bytes = new Uint8Array(arr);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        return base64;
      } catch {
        throw commandError; // 抛出原始命令错误，方便定位命令问题
      }
    }
  } catch (error) {
    console.error('Failed to get image as base64:', error);
    throw new Error(`Failed to get image: ${getErrorMessage(error)}`);
  }
}

// API配置管理API
export async function getApiConfigurations(): Promise<ApiConfig[]> {
  try {
    const response = await invoke<ApiConfig[]>('get_api_configurations');
    return response;
  } catch (error) {
    console.error('Failed to get API configurations:', error);
    throw new Error(`Failed to get API configurations: ${getErrorMessage(error)}`);
  }
}

export async function saveApiConfigurations(configs: ApiConfig[]): Promise<void> {
  try {
    const filtered = (configs || []).filter((cfg: any) => {
      const isBuiltin = cfg?.isBuiltin ?? cfg?.is_builtin ?? false;
      return !isBuiltin;
    });
    await invoke<void>('save_api_configurations', { configs: filtered });
  } catch (error) {
    console.error('Failed to save API configurations:', error);
    throw new Error(`Failed to save API configurations: ${getErrorMessage(error)}`);
  }
}

export async function getVendorConfigs(): Promise<VendorConfig[]> {
  try {
    return await invoke<VendorConfig[]>('get_vendor_configs');
  } catch (error) {
    console.error('Failed to get vendor configs:', error);
    throw new Error(`Failed to get vendor configs: ${getErrorMessage(error)}`);
  }
}

export async function saveVendorConfigs(configs: VendorConfig[]): Promise<void> {
  try {
    await invoke<void>('save_vendor_configs', { configs });
  } catch (error) {
    console.error('Failed to save vendor configs:', error);
    throw new Error(`Failed to save vendor configs: ${getErrorMessage(error)}`);
  }
}

export async function getModelProfiles(): Promise<ModelProfile[]> {
  try {
    return await invoke<ModelProfile[]>('get_model_profiles');
  } catch (error) {
    console.error('Failed to get model profiles:', error);
    throw new Error(`Failed to get model profiles: ${getErrorMessage(error)}`);
  }
}

export async function saveModelProfiles(profiles: ModelProfile[]): Promise<void> {
  try {
    await invoke<void>('save_model_profiles', { profiles });
  } catch (error) {
    console.error('Failed to save model profiles:', error);
    throw new Error(`Failed to save model profiles: ${getErrorMessage(error)}`);
  }
}

export async function getModelAssignments(): Promise<any> {
  try {
    const response = await invoke<any>('get_model_assignments');
    return response;
  } catch (error) {
    console.error('Failed to get model assignments:', error);
    throw new Error(`Failed to get model assignments: ${getErrorMessage(error)}`);
  }
}

export async function saveModelAssignments(assignments: any): Promise<void> {
  try {
    await invoke<void>('save_model_assignments', { assignments });
  } catch (error) {
    console.error('Failed to save model assignments:', error);
    throw new Error(`Failed to save model assignments: ${getErrorMessage(error)}`);
  }
}

// 科目配置管理API已废弃
// ★ 2026-01 清理：批量错题操作 API 已删除

// ★ 文档31清理：ensureMemoryLibraryForSubject 已删除
// ★ 文档31清理：upsertMemoryEntry 已删除

// 用户记忆：从聊天记录提取记忆候选
// ★ 2026-01 清理：移除 mistake_id 参数，统一使用 conversation_id
