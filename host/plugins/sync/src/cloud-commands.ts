/** `commands_sync.rs` 中依赖云传输的命令（逐条移植；未移植的命令不注册）。 */
import type { SyncContext } from './dependencies.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CloudStorageConfig } from '../../../../contracts/ipc/generated/_shared.ts';
import type { RepoCheckReport } from '../../../../contracts/ipc/generated/L20-sync.ts';
import { runRepoCheck } from '../../sync-providers/api.ts';
import { cloudErrorMessage, assertNotInMaintenance, createCloudStorage } from './cloud-runtime.ts';

/** `data_governance_repo_check`（commands_sync.rs:5151）。 */
export async function repoCheck(ctx: SyncContext, config: CloudStorageConfig): Promise<RepoCheckReport> {
  assertNotInMaintenance(ctx);
  let storage;
  try {
    storage = await createCloudStorage(ctx, config);
  } catch (error) {
    throw new CommandError(`创建云存储失败: ${cloudErrorMessage(error)}`);
  }
  try {
    return await runRepoCheck(storage);
  } catch (error) {
    throw new CommandError(`云端仓库巡检失败: ${cloudErrorMessage(error)}`);
  }
}
