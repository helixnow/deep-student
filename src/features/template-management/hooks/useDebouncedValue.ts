import { useEffect, useState } from 'react';

/**
 * 防抖值 hook：value 稳定 delay 毫秒后才更新返回值。
 * 空字符串（清空搜索）立即生效，避免"清空后还残留结果"的滞后感。
 */
export function useDebouncedValue<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (typeof value === 'string' && value === '') {
      setDebounced(value);
      return undefined;
    }
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export default useDebouncedValue;
