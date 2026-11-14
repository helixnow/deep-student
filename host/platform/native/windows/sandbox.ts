import koffi from 'koffi';
import { setTimeout } from 'node:timers/promises';
import { windowsFiles } from './files.ts';
import type {
  AppContainerProfile, NativeWindowsSandbox, WindowsAclMutexGuard, WindowsAppContainerLaunch, WindowsFullAccessLaunch,
} from './sandbox-api.ts';

function load() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('AppContainer native operations require Windows x64');
  const kernel = koffi.load('kernel32.dll'), userenv = koffi.load('userenv.dll'), advapi = koffi.load('advapi32.dll');
  const securityBase = koffi.load('kernelbase.dll');
  return {
    createProfile: userenv.func('int32 __stdcall CreateAppContainerProfile(str16 name, str16 display, str16 description, void *capabilities, uint32 count, void *sid)'),
    deleteProfile: userenv.func('int32 __stdcall DeleteAppContainerProfile(str16 name)'),
    derive: securityBase.func('int __stdcall DeriveCapabilitySidsFromName(str16 name, void *groups, void *group_count, void *sids, void *sid_count)'),
    sidLength: advapi.func('uint32 __stdcall GetLengthSid(void *sid)'),
    freeSid: advapi.func('void * __stdcall FreeSid(void *sid)'),
    localFree: kernel.func('void * __stdcall LocalFree(void *memory)'),
    getSecurity: advapi.func('uint32 __stdcall GetNamedSecurityInfoW(str16 path, uint32 type, uint32 info, void *owner, void *group, void *dacl, void *sacl, void *descriptor)'),
    setSecurity: advapi.func('uint32 __stdcall SetNamedSecurityInfoW(str16 path, uint32 type, uint32 info, void *owner, void *group, void *dacl, void *sacl)'),
    createJob: kernel.func('void * __stdcall CreateJobObjectW(void *security, str16 name)'),
    setJob: kernel.func('int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32 length)'),
    assign: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
    terminateJob: kernel.func('int __stdcall TerminateJobObject(void *job, uint32 code)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    initialize: kernel.func('int __stdcall InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, void *size)'),
    update: kernel.func('int __stdcall UpdateProcThreadAttribute(void *list, uint32 flags, uint64 attribute, void *value, uint64 size, void *previous, void *returned)'),
    deleteAttributes: kernel.func('void __stdcall DeleteProcThreadAttributeList(void *list)'),
    createProcess: kernel.func('int __stdcall CreateProcessW(str16 application, void *command, void *process_security, void *thread_security, int inherit, uint32 flags, void *environment, str16 cwd, void *startup, void *process)'),
    terminate: kernel.func('int __stdcall TerminateProcess(void *process, uint32 code)'),
    resume: kernel.func('uint32 __stdcall ResumeThread(void *thread)'),
    wait: kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)'),
    exitCode: kernel.func('int __stdcall GetExitCodeProcess(void *handle, void *code)'),
    std: kernel.func('void * __stdcall GetStdHandle(int32 kind)'),
    error: kernel.func('uint32 __stdcall GetLastError()'),
    createMutex: kernel.func('void * __stdcall CreateMutexW(void *security, int initial_owner, str16 name)'),
    releaseMutex: kernel.func('int __stdcall ReleaseMutex(void *mutex)'),
    directory: kernel.func('uint32 __stdcall GetSystemDirectoryW(void *buffer, uint32 count)'),
  };
}
let binding: ReturnType<typeof load> | undefined;
function api(): ReturnType<typeof load> { return binding ??= load(); }
function lastError(context: string): Error { const code = api().error() as number; return new Error(`${context}: ${windowsFiles.ioError(code)}`); }
function address(pointer: unknown): bigint { return pointer === null ? 0n : koffi.address(pointer); }
function copy(pointer: unknown, size: number): Buffer { return Buffer.from(new Uint8Array(koffi.view(pointer, size))); }
function sid(pointer: unknown): Buffer { return copy(pointer, api().sidLength(pointer) as number); }

function environmentBlock(env: Readonly<Record<string, string>> | undefined): Buffer | null {
  return env === undefined ? null : Buffer.from(Object.entries(env)
    .sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0', 'utf16le');
}

async function runFullAccess(request: WindowsFullAccessLaunch): Promise<number> {
  const win = api();
  // Anonymous: the Rust helper's `Local\DeepStudentShellJob-{pid}` name is per helper
  // process; in-process a pid name would be shared by concurrent executions.
  const job: unknown = win.createJob(null, null);
  if (job === null) throw lastError('Failed to create the Windows shell Job Object');
  let process: unknown = null, thread: unknown = null;
  try {
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64
    limits.writeUInt32LE(0x2000, 16); // relaxed_job_limit_information: KILL_ON_JOB_CLOSE only
    if (win.setJob(job, 9, limits, limits.length) === 0) throw lastError('Failed to configure the Windows shell Job Object');
    const startup = Buffer.alloc(104); // STARTUPINFOW
    startup.writeUInt32LE(104, 0);
    startup.writeUInt32LE(0x100, 60); // STARTF_USESTDHANDLES
    for (let i = 0; i < 3; i++) startup.writeBigUInt64LE(request.stdio?.[i] ?? address(win.std(-10 - i)), 80 + i * 8);
    const info = Buffer.alloc(24);
    const command = Buffer.from(`${request.commandLine}\0`, 'utf16le');
    const environment = environmentBlock(request.env);
    const created = win.createProcess(request.application, command, null, null, 1,
      0x4 | 0x08000000 | (environment === null ? 0 : 0x400), environment, request.cwd, startup, info);
    if (created === 0) throw lastError('Failed to create the Danger Full Access PowerShell process');
    process = info.readBigUInt64LE(0); thread = info.readBigUInt64LE(8);
    if (win.assign(job, process) === 0) {
      const error = lastError('Failed to assign Danger Full Access PowerShell to its Job Object');
      win.terminate(process, 126);
      throw error;
    }
    if (request.signal?.aborted) return 124; // finally closes the kill-on-close Job before any resume.
    if (win.resume(thread) === 0xffffffff) throw lastError('Failed to resume Danger Full Access PowerShell');
    let cancelled = false;
    for (;;) {
      const status = win.wait(process, 0) as number;
      if (status === 0) break;
      if (status !== 258) {
        throw lastError(cancelled ? 'Failed while waiting for cancelled Danger Full Access PowerShell'
          : 'Failed while waiting for Danger Full Access PowerShell');
      }
      if (!cancelled && request.signal?.aborted) {
        if (win.terminateJob(job, 124) === 0) throw lastError('Failed to terminate the cancelled Danger Full Access Job Object');
        cancelled = true; // Rust then waits INFINITE for the process.
      }
      await setTimeout(100);
    }
    const code = Buffer.alloc(4);
    if (win.exitCode(process, code) === 0) throw lastError('Failed to obtain Danger Full Access PowerShell exit code');
    return code.readInt32LE(0);
  } finally {
    if (thread !== null) win.close(thread);
    if (process !== null) win.close(process);
    win.close(job);
  }
}

// Win32 mutexes are recursive per thread. Rust acquires in a separate helper process per
// execution; here every caller shares the JS thread, so in-process callers queue first.
let aclMutexHeldInProcess = false;

async function acquireAclMutex(signal?: AbortSignal): Promise<WindowsAclMutexGuard | null> {
  const win = api();
  while (aclMutexHeldInProcess) {
    if (signal?.aborted) return null;
    await setTimeout(100);
  }
  aclMutexHeldInProcess = true;
  const mutex: unknown = win.createMutex(null, 0, 'Local\\DeepStudentShellAclMutex-v1');
  if (mutex === null) { aclMutexHeldInProcess = false; throw lastError('Failed to create the Windows shell ACL mutex'); }
  const giveUp = (): void => { win.close(mutex); aclMutexHeldInProcess = false; };
  try {
    for (;;) {
      // Zero-timeout polls keep the event loop free; the 100 ms cadence is Rust's wait timeout.
      const status = win.wait(mutex, 0) as number;
      if (status === 0 || status === 0x80) { // WAIT_OBJECT_0 | WAIT_ABANDONED_0
        let released = false;
        return { release() {
          if (released) return;
          released = true;
          win.releaseMutex(mutex); // AclMutexGuard::drop ignores the result.
          giveUp();
        } };
      }
      if (status !== 258) throw lastError('Failed to acquire the Windows shell ACL mutex');
      if (signal?.aborted) { giveUp(); return null; }
      await setTimeout(100);
    }
  } catch (error) { giveUp(); throw error; }
}

async function run(profile: AppContainerProfile, request: WindowsAppContainerLaunch): Promise<number> {
  const win = api();
  const job: unknown = win.createJob(null, null); // Anonymous Job, never a PID-derived shared name.
  if (job === null) throw lastError('Failed to create the Windows shell Job Object');
  let process: unknown = null, thread: unknown = null;
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64 ABI: 144 bytes.
    const limits = Buffer.alloc(144);
    limits.writeBigInt64LE(130n * 10_000_000n, 0);
    limits.writeUInt32LE(0x2000 | 0x8 | 0x2, 16); // KILL_ON_CLOSE | ACTIVE_PROCESS | PROCESS_TIME
    limits.writeUInt32LE(128, 40);
    if (win.setJob(job, 9, limits, limits.length) === 0) throw lastError('Failed to configure the Windows shell Job Object');
    if (request.signal?.aborted) return 124;
    const size = Buffer.alloc(8);
    win.initialize(null, 1, 0, size);
    if (size.readBigUInt64LE() === 0n) throw lastError('Failed to size the AppContainer process attribute list');
    const attributes = Buffer.alloc(Number(size.readBigUInt64LE()));
    if (win.initialize(attributes, 1, 0, size) === 0) throw lastError('Failed to initialize the AppContainer process attribute list');
    try {
      const sids = request.capabilitySids ?? [];
      const entries = Buffer.alloc(sids.length * 16);
      sids.forEach((item, index) => {
        entries.writeBigUInt64LE(address(item), index * 16);
        entries.writeUInt32LE(4, index * 16 + 8); // SE_GROUP_ENABLED
      });
      const capabilities = Buffer.alloc(24);
      capabilities.writeBigUInt64LE(address(profile.sid), 0);
      capabilities.writeBigUInt64LE(sids.length === 0 ? 0n : address(entries), 8);
      capabilities.writeUInt32LE(sids.length, 16);
      if (win.update(attributes, 0, 0x00020009n, capabilities, 24n, null, null) === 0) {
        throw lastError('Failed to attach AppContainer security capabilities');
      }
      const startup = Buffer.alloc(112); // STARTUPINFOEXW, includes 104-byte STARTUPINFOW
      startup.writeUInt32LE(112, 0);
      startup.writeUInt32LE(0x100, 60);
      for (let i = 0; i < 3; i++) startup.writeBigUInt64LE(request.stdio?.[i] ?? address(win.std(-10 - i)), 80 + i * 8);
      startup.writeBigUInt64LE(address(attributes), 104);
      const info = Buffer.alloc(24);
      const command = Buffer.from(`${request.commandLine}\0`, 'utf16le');
      const environment = environmentBlock(request.env);
      const created = win.createProcess(request.application, command, null, null, 1,
        0x00080000 | 0x4 | 0x08000000 | (environment === null ? 0 : 0x400), environment, request.cwd, startup, info);
      if (created === 0) throw lastError('Failed to create the AppContainer shell process');
      process = info.readBigUInt64LE(0); thread = info.readBigUInt64LE(8);
    } finally { win.deleteAttributes(attributes); }
    if (win.assign(job, process) === 0) {
      const error = lastError('Failed to assign the AppContainer process to its Job Object');
      win.terminate(process, 126);
      throw error;
    }
    if (request.signal?.aborted) return 124; // finally closes the kill-on-close Job before any resume.
    if (win.resume(thread) === 0xffffffff) throw lastError('Failed to resume the AppContainer shell process');
    let cancelled = false;
    for (;;) {
      const status = win.wait(process, 0) as number;
      if (status === 0) break;
      if (status !== 258) {
        throw lastError(cancelled ? 'Failed while waiting for the cancelled AppContainer shell process'
          : 'Failed while waiting for the AppContainer shell process');
      }
      if (!cancelled && request.signal?.aborted) {
        if (win.terminateJob(job, 124) === 0) throw lastError('Failed to terminate the cancelled Windows shell Job Object');
        cancelled = true; // windows.rs:2002 then waits INFINITE; no invented deadline.
      }
      await setTimeout(100);
    }
    const code = Buffer.alloc(4);
    if (win.exitCode(process, code) === 0) throw lastError('Failed to obtain the AppContainer shell exit code');
    return code.readInt32LE(0);
  } finally {
    if (thread !== null) win.close(thread);
    if (process !== null) win.close(process);
    win.close(job); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE applies to the whole tree.
  }
}

export const windowsSandbox: NativeWindowsSandbox = {
  createProfile(name) {
    const output = Buffer.alloc(8);
    const status = api().createProfile(name, name, 'Ephemeral AppContainer for an approved local shell command', null, 0, output) as number;
    if (status < 0) throw new Error(`Failed to create AppContainer profile: HRESULT 0x${(status >>> 0).toString(16)}`);
    const pointer = output.readBigUInt64LE(0);
    let value: Buffer;
    try { value = sid(pointer); } finally { api().freeSid(pointer); }
    let closed = false;
    return { name, sid: value, close() { if (!closed) { api().deleteProfile(name); closed = true; } } };
  },
  deriveCapabilitySids(name) {
    const groups = Buffer.alloc(8), countGroups = Buffer.alloc(4), values = Buffer.alloc(8), countValues = Buffer.alloc(4);
    const win = api();
    const ok = win.derive(name, groups, countGroups, values, countValues);
    const groupPointer = groups.readBigUInt64LE(), valuePointer = values.readBigUInt64LE();
    const release = (pointer: bigint, count: number): void => {
      if (pointer === 0n) return;
      const pointers = copy(pointer, count * 8);
      for (let i = 0; i < count; i++) win.localFree(pointers.readBigUInt64LE(i * 8));
      win.localFree(pointer);
    };
    try {
      if (ok === 0 || countValues.readUInt32LE() === 0) throw lastError('Failed to derive the AppContainer network capability');
      const pointers = copy(valuePointer, countValues.readUInt32LE() * 8);
      return Array.from({ length: countValues.readUInt32LE() }, (_, i) => sid(pointers.readBigUInt64LE(i * 8)));
    } finally { release(groupPointer, countGroups.readUInt32LE()); release(valuePointer, countValues.readUInt32LE()); }
  },
  readDacl(path) {
    const dacl = Buffer.alloc(8), descriptor = Buffer.alloc(8);
    const code = api().getSecurity(path, 1, 4, null, null, dacl, null, descriptor) as number;
    if (code !== 0) throw new Error(windowsFiles.ioError(code));
    try {
      const pointer = dacl.readBigUInt64LE();
      if (pointer === 0n) return null;
      const header = copy(pointer, 8);
      return copy(pointer, header.readUInt16LE(2));
    } finally { api().localFree(descriptor.readBigUInt64LE()); }
  },
  writeDacl(path, dacl, protect) {
    const code = api().setSecurity(path, 1, (4 | (protect ? 0x80000000 : 0x20000000)) >>> 0, null, null, dacl, null) as number;
    if (code !== 0) throw new Error(windowsFiles.ioError(code));
  },
  runAppContainer: run,
  runFullAccessJob: runFullAccess,
  acquireAclMutex,
  systemDirectory() {
    const buffer = Buffer.alloc(32768 * 2), length = api().directory(buffer, 32768) as number;
    if (length === 0) throw lastError('Failed to resolve the trusted Windows system directory');
    if (length >= 32768) throw new Error('The trusted Windows system directory path is too long');
    return buffer.subarray(0, length * 2).toString('utf16le');
  },
};
