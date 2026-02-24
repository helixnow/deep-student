import { invoke } from '@tauri-apps/api/core';
import type { VendorConfig, ModelProfile, ApiConfig } from '../types';


// 文件管理API
export async function getImageAsBase64(relativePath: string): Promise<string> {
  try {
    // 1) 优先尝试 camelCase 参数
    try {
      const response = await invoke<string>('get_image_as_base64', { relativePath });
      return response;
    } catch (e1) {
      // 2) 回退 snake_case 参数
      try {
        const response = await invoke<string>('get_image_as_base64', { relative_path: relativePath });
        return response;
      } catch (e2) {
        // 3) 最后兜底：前端通过 convertFileSrc + fetch 读取文件
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
        } catch (e3) {
          throw e2; // 抛出原始 Tauri 错误，方便定位命令问题
        }
      }
    }
  } catch (error) {
    console.error('Failed to get image as base64:', error);
    throw new Error(`Failed to get image: ${error}`);
  }
}

export async function saveImageFromBase64(base64Data: string, originalPath: string): Promise<string> {
  try {
    // 从原路径中提取文件名，兼容不同操作系统的路径分隔符
    const pathSeparators = /[\/\\]/;
    const pathParts = originalPath.split(pathSeparators);
    let fileName = pathParts[pathParts.length - 1];
    
    // 如果文件名为空或无效，生成一个新的文件名
    if (!fileName || fileName.trim() === '') {
      const timestamp = new Date().getTime();
      const randomStr = Math.random().toString(36).substring(2, 8);
      fileName = `image_${timestamp}_${randomStr}.png`;
    }
    
    // 验证 base64 数据格式
    if (!base64Data || base64Data.trim() === '') {
      throw new Error('Base64 data is empty');
    }
    
    const response = await invoke<string>('save_image_from_base64_path', { 
      // 双写兼容：后端为 snake_case
      base64_data: base64Data,
      base64Data: base64Data,
      file_name: fileName,
      fileName: fileName
    });
    return response;
  } catch (error) {
    console.error('Failed to save image from base64:', error);
    throw new Error(`Failed to save image: ${error}`);
  }
}

export async function cleanupOrphanedImages(): Promise<string[]> {
  try {
    const response = await invoke<string[]>('cleanup_orphaned_images');
    return response;
  } catch (error) {
    console.error('Failed to cleanup orphaned images:', error);
    throw new Error(`Failed to cleanup orphaned images: ${error}`);
  }
}

// API配置管理API
export async function getApiConfigurations(): Promise<ApiConfig[]> {
  try {
    const response = await invoke<ApiConfig[]>('get_api_configurations');
    return response;
  } catch (error) {
    console.error('Failed to get API configurations:', error);
    throw new Error(`Failed to get API configurations: ${error}`);
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
    throw new Error(`Failed to save API configurations: ${error}`);
  }
}

export async function getVendorConfigs(): Promise<VendorConfig[]> {
  try {
    return await invoke<VendorConfig[]>('get_vendor_configs');
  } catch (error) {
    console.error('Failed to get vendor configs:', error);
    throw new Error(`Failed to get vendor configs: ${error}`);
  }
}

export async function saveVendorConfigs(configs: VendorConfig[]): Promise<void> {
  try {
    await invoke<void>('save_vendor_configs', { configs });
  } catch (error) {
    console.error('Failed to save vendor configs:', error);
    throw new Error(`Failed to save vendor configs: ${error}`);
  }
}

export async function getModelProfiles(): Promise<ModelProfile[]> {
  try {
    return await invoke<ModelProfile[]>('get_model_profiles');
  } catch (error) {
    console.error('Failed to get model profiles:', error);
    throw new Error(`Failed to get model profiles: ${error}`);
  }
}

export async function saveModelProfiles(profiles: ModelProfile[]): Promise<void> {
  try {
    await invoke<void>('save_model_profiles', { profiles });
  } catch (error) {
    console.error('Failed to save model profiles:', error);
    throw new Error(`Failed to save model profiles: ${error}`);
  }
}

export async function getModelAssignments(): Promise<any> {
  try {
    const response = await invoke<any>('get_model_assignments');
    return response;
  } catch (error) {
    console.error('Failed to get model assignments:', error);
    throw new Error(`Failed to get model assignments: ${error}`);
  }
}

export async function saveModelAssignments(assignments: any): Promise<void> {
  try {
    await invoke<void>('save_model_assignments', { assignments });
  } catch (error) {
    console.error('Failed to save model assignments:', error);
    throw new Error(`Failed to save model assignments: ${error}`);
  }
}

// 科目配置管理API已废弃
// ★ 2026-01 清理：批量错题操作 API 已删除

// ★ 文档31清理：ensureMemoryLibraryForSubject 已删除
// ★ 文档31清理：upsertMemoryEntry 已删除

// 用户记忆：从聊天记录提取记忆候选
// ★ 2026-01 清理：移除 mistake_id 参数，统一使用 conversation_id
