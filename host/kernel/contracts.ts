/**
 * 契约集合的桌面入口：在可移植的 `ContractSet`（contract-set.ts）上增加 `fromDirectory`，
 * 从磁盘加载 `contracts/ipc/*.json`。移动端等没有文件系统的宿主直接用 contract-set.ts。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractSet as PortableContractSet, parseContractSource, type ContractSource } from './contract-set.ts';

export { ContractError, parseContractSource } from './contract-set.ts';
export type { ArgsCheck, ContractSource } from './contract-set.ts';

/** 仓库内 `contracts/ipc` 的绝对路径。 */
export const REPO_CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'ipc');

/**
 * 已加载契约的集合。实例与 contract-set.ts 的 `ContractSet` 相同（`empty()`、`with()` 返回基类实例，
 * 类型上可互换）；判断实例请用 contract-set.ts 的类做 `instanceof`。
 */
export class ContractSet extends PortableContractSet {
  /** 读取目录下全部 `*.json`（`_shared.json` 只提供 `$defs`）。目录不存在时返回空集合。 */
  static fromDirectory(dir: string = REPO_CONTRACTS_DIR): PortableContractSet {
    if (!existsSync(dir)) return PortableContractSet.empty();
    const sources: ContractSource[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      sources.push(parseContractSource(file, readFileSync(join(dir, file), 'utf8'), join(dir, file)));
    }
    return new PortableContractSet(sources);
  }
}
