export async function loadGraphRagThreshold(defaultValue: number = 0.6): Promise<number> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const val = await invoke<string | null>('get_setting', { key: 'graph_rag.threshold' });
    const num = parseFloat(String(val ?? ''));
    if (!isNaN(num) && num >= 0 && num <= 1) return num;
  } catch {}
  return defaultValue;
}

export async function loadRagThreshold(defaultValue: number = 0.6): Promise<number> {
  // 兼容旧键名：优先读取 graph_rag.threshold
  return await loadGraphRagThreshold(defaultValue);
}

