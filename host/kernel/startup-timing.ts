/**
 * Host 启动计时（STARTUP-PROFILE.md）：阶段标记 + 每个插件模块的导入耗时与 `apply`（含启动校验）耗时。
 *
 * 时间取 `performance.now()`，原点是进程启动（`performance.timeOrigin`），因此 `ready` 的读数包含 Node 自身启动、
 * 加载 main.ts 与等待握手的时间。只记录，不改变装载顺序或语义；HostReady 时由 connection.ts 写一行 info 日志。
 */
export interface StartupPhase {
  name: string;
  /** 距进程启动的毫秒数。 */
  at: number;
}

export interface StartupPluginTiming {
  id: string;
  ms: number;
}

export interface StartupTimings {
  phases: StartupPhase[];
  /** 按导入顺序；先导入的模块承担共享依赖的加载成本（ESM 模块图只求值一次）。 */
  imports: StartupPluginTiming[];
  /** 按安装顺序；`ok: false` 为 apply 失败或未启动（degraded），inactive 条目不安装、不出现在这里。 */
  installs: (StartupPluginTiming & { ok: boolean })[];
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export class StartupTimeline {
  private readonly phases: StartupPhase[] = [];
  private readonly imports: StartupPluginTiming[] = [];
  private readonly installs: (StartupPluginTiming & { ok: boolean })[] = [];

  /** `at` 缺省为现在；运行时创建之前的阶段（握手、契约）由调用方事先取时间。 */
  mark(name: string, at = performance.now()): void {
    this.phases.push({ name, at: round(at) });
  }

  recordImport(id: string, started: number): void {
    this.imports.push({ id, ms: round(performance.now() - started) });
  }

  recordInstall(id: string, started: number, ok: boolean): void {
    this.installs.push({ id, ms: round(performance.now() - started), ok });
  }

  snapshot(): StartupTimings {
    return {
      phases: this.phases.map((phase) => ({ ...phase })),
      imports: this.imports.map((item) => ({ ...item })),
      installs: this.installs.map((item) => ({ ...item })),
    };
  }

  /** 一行摘要：各阶段间隔与最慢的若干个 apply。 */
  summary(top = 10): string {
    const parts: string[] = [];
    for (let i = 1; i < this.phases.length; i++) {
      parts.push(`${this.phases[i]!.name} +${round(this.phases[i]!.at - this.phases[i - 1]!.at)}ms`);
    }
    const ready = this.phases.at(-1);
    const slowest = [...this.installs].sort((a, b) => b.ms - a.ms).slice(0, top).map((item) => `${item.id} ${item.ms}ms`);
    return `startup: ${ready ? `${ready.name} at ${ready.at}ms after process start` : 'no phases'}`
      + (parts.length ? ` (${this.phases[0]!.name} at ${this.phases[0]!.at}ms; ${parts.join(', ')})` : '')
      + (slowest.length ? `; slowest apply: ${slowest.join(', ')}` : '');
  }
}
