export function auditLaunchEnvironment(stdout: string, pid: number, nativeVariables: readonly string[], jsVariables: readonly string[]): { ok: boolean; native: string; js: string };
