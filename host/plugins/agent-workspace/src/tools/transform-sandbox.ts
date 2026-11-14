/** L24 transform policy adapter; native process primitives belong to F7. */
import type {
  TransformSandboxBackend, TransformSandboxEffects, TransformSandboxPolicy,
  TransformSandboxProcess, TransformSandboxSpawnRequest,
} from '../../../chatanki/api.ts';
import type { NativeSandbox, SandboxLaunch } from '../../../../platform/native/sandbox/api.ts';
import {
  createPlatformSandboxBackend, platformSandboxContract, SANDBOX_EXEC,
  type SandboxCommand, type SandboxPolicy,
} from './shell-sandbox.ts';

/** F7's public input/probe contract; preserve L24's nullable pipe return surface. */
export interface TransformSandboxNativePort {
  probe: NativeSandbox['probe'];
  spawn(launch: SandboxLaunch): Promise<TransformSandboxProcess>;
}

/** L24 must await these two operations in its existing setup/error boundaries. */
export interface AsyncTransformSandboxBackend extends Omit<TransformSandboxBackend, 'capability' | 'spawn'> {
  capability(): Promise<{ available: true } | { available: false; reason: string }>;
  spawn(request: TransformSandboxSpawnRequest & { signal?: AbortSignal }): Promise<TransformSandboxProcess>;
}

export function transformSandboxPolicy(policy: TransformSandboxPolicy): SandboxPolicy {
  return {
    readable_roots: [...policy.readableRoots], writable_roots: [...policy.writableRoots],
    protected_read_roots: [...policy.protectedReadRoots], protected_write_roots: [...policy.protectedWriteRoots],
    restrict_read_to_roots: policy.restrictReadToRoots, allow_network: policy.allowNetwork,
  };
}

export function createTransformSandboxBackend(
  getNative: () => TransformSandboxNativePort | undefined,
  platform: NodeJS.Platform = process.platform,
): AsyncTransformSandboxBackend {
  const policyBackend = createPlatformSandboxBackend(platform);
  const contract = platformSandboxContract(platform);
  const native = (): TransformSandboxNativePort => {
    const service = getNative();
    if (!service) throw new Error('Transform sandbox requires nativeSandbox service');
    return service;
  };
  const backendName = (): 'linux_bwrap' | 'macos_seatbelt' => {
    if (platform === 'linux') return 'linux_bwrap';
    if (platform === 'darwin') return 'macos_seatbelt';
    throw new Error('Transform sandbox requires the integrated Windows ACL/helper backend on this platform');
  };
  const cleanup = (command: SandboxCommand): void => policyBackend.cleanupCommandResources?.(command);
  return {
    async capability() {
      try {
        const service = native();
        const backend = backendName();
        // Rust Linux capability only locates bwrap; resource failures belong to business spawn/wait.
        if (backend === 'linux_bwrap') return policyBackend.capability();
        const probe = await service.probe(backend, SANDBOX_EXEC);
        return probe.available ? { available: true } : probe;
      } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    contract: () => ({ backend: contract.backend, shellKind: contract.shell_kind, outputEncoding: contract.output_encoding }),
    effectReport(policy): TransformSandboxEffects {
      const report = policyBackend.effectReport(transformSandboxPolicy(policy));
      return {
        backend: report.backend, shellKind: report.shell_kind, outputEncoding: report.output_encoding,
        enforced: report.enforced, networkEnforced: report.network_enforced,
        processGroupIsolated: report.process_group_isolated, cpuTimeLimitSeconds: report.cpu_time_limit_seconds,
        fileSizeLimitBytes: report.file_size_limit_bytes, activeProcessLimit: report.active_process_limit,
        readableRoots: report.readable_roots, writableRoots: report.writable_roots,
        protectedReadRoots: report.protected_read_roots, protectedWriteRoots: report.protected_write_roots,
      };
    },
    async spawn(request) {
      const service = native();
      const backend = backendName();
      const command = policyBackend.command(request.command, request.cwd, transformSandboxPolicy(request.policy));
      let child: TransformSandboxProcess;
      try {
        child = await service.spawn({ backend, ...command, env: request.env, signal: request.signal });
      } catch (error) {
        cleanup(command);
        throw error;
      }
      return {
        pid: child.pid, stdout: child.stdout, stderr: child.stderr,
        wait: () => child.wait(),
        terminateProcessGroup: () => child.terminateProcessGroup(),
        cleanupFinishedProcessGroup: () => child.cleanupFinishedProcessGroup(),
        async cleanupResources() {
          try { await child.cleanupResources(); } finally { cleanup(command); }
        },
      };
    },
  };
}
