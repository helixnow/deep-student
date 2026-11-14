/** Read-only execution metadata for the single S108 phase diagnostic. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vitest } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

export default class S108Reporter implements Reporter {
  onInit(vitest: Vitest): void {
    const config = vitest.config;
    const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
    console.info('[L23-S108-executor]', JSON.stringify({
      cwd: process.cwd(), head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
      dirty: git('status', '--short'), node: process.version, pid: process.pid,
      config: {
        configFile: config.config, pool: config.pool, poolOptions: config.poolOptions,
        minWorkers: config.minWorkers, maxWorkers: config.maxWorkers,
        fileParallelism: config.fileParallelism, maxConcurrency: config.maxConcurrency,
        testTimeout: config.testTimeout, hookTimeout: config.hookTimeout,
        testNamePattern: config.testNamePattern?.source,
      },
      env: { maxForks: process.env.VITEST_MAX_FORKS, maxThreads: process.env.VITEST_MAX_THREADS },
    }));
    this.queueSnapshot('start');
  }

  onTestRunEnd(): void {
    this.queueSnapshot('end');
  }

  private queueSnapshot(point: string): void {
    const jobs = process.env.OC_JOBS_DIR ?? join(homedir(), '.oc-jobs');
    const readMetadata = (file: string): unknown => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        // Jobs can finish between readdir and read; report that race, not a fake snapshot.
        return { file, readError: error instanceof Error ? error.stack : String(error) };
      }
    };
    console.info('[L23-S108-queue]', JSON.stringify({
      point,
      status: readMetadata(join(jobs, 'status.json')),
      running: readdirSync(join(jobs, 'running')).filter(file => file.endsWith('.json'))
        .map(file => readMetadata(join(jobs, 'running', file))),
    }));
  }
}
