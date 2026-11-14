/// <reference types="vite/client" />
/**
 * Worker 中的 IPC 契约：构建期把 `contracts/ipc/*.json` 原文打进包，握手时按桌面
 * `ContractSet.fromDirectory()` 的方式（文件名排序、同一解析与校验）构造可移植的 `ContractSet`。
 */
import { ContractSet, parseContractSource } from '../../../host/kernel/contract-set.ts';

const CONTRACT_FILES = import.meta.glob<string>('../../../contracts/ipc/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export function bundledContracts(files: Readonly<Record<string, string>> = CONTRACT_FILES): ContractSet {
  const byName = new Map(Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]));
  return new ContractSet([...byName.keys()].sort().map(file => parseContractSource(file, byName.get(file)!)));
}
