/**
 * 主进程日志文件与 Host 输出尾部缓冲：Host 在日志插件装载前失败时，用户只能从主进程日志里看到原因。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeHostGone, OutputTail } from '../shell/host-output.ts';
import { MainLog, mainLogFile } from '../shell/main-log.ts';

const fixedNow = () => new Date('2026-11-07T03:00:00.000Z');

describe('MainLog', () => {
  it('buffers lines written before the file is known, then appends them with timestamps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dstu-main-log-'));
    const log = new MainLog({ now: fixedNow });
    log.write('early line');
    const file = join(dir, 'nested', 'electron-main.log');
    log.open(file);
    log.write('[host] fatal: boom\n    at stack');
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-11-07T03:00:00.000Z early line\n2026-11-07T03:00:00.000Z [host] fatal: boom\n    at stack\n',
    );
    expect(log.path).toBe(file);
  });

  it('rotates an oversized file to .1 on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dstu-main-log-'));
    const file = join(dir, 'electron-main.log');
    writeFileSync(file, 'x'.repeat(64));
    const log = new MainLog({ now: fixedNow, maxBytes: 32 });
    log.open(file);
    log.write('fresh');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(64));
    expect(readFileSync(file, 'utf8')).toBe('2026-11-07T03:00:00.000Z fresh\n');
  });

  it('keeps only the newest pending lines before open and never throws when the file cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dstu-main-log-'));
    const log = new MainLog({ now: fixedNow, maxPending: 2 });
    log.write('one');
    log.write('two');
    log.write('three');
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    expect(() => log.open(join(blocker, 'electron-main.log'))).not.toThrow();
    expect(() => log.write('after failure')).not.toThrow();
    const file = join(dir, 'ok.log');
    const second = new MainLog({ now: fixedNow, maxPending: 2 });
    for (const line of ['one', 'two', 'three']) second.write(line);
    second.open(file);
    expect(readFileSync(file, 'utf8')).toContain('[main-log] 1 earlier line(s) dropped before the log file was opened');
    expect(readFileSync(file, 'utf8')).toContain('two\n');
    expect(readFileSync(file, 'utf8')).not.toContain(' one\n');
    expect(existsSync(join(blocker, 'electron-main.log'))).toBe(false);
  });
});

describe('mainLogFile', () => {
  it('sits next to the Host log (Rust app_log_dir under the bundle identifier the shell passes as DS_APP_IDENTIFIER)', () => {
    expect(mainLogFile('darwin', { home: '/Users/u', dataLocal: '/Users/u/Library/Application Support' }, 'com.deepstudent.app'))
      .toBe('/Users/u/Library/Logs/com.deepstudent.app/electron-main.log');
    expect(mainLogFile('linux', { home: '/home/u', dataLocal: '/home/u/.local/share' }, 'com.deepstudent.app'))
      .toBe('/home/u/.local/share/com.deepstudent.app/logs/electron-main.log');
    expect(mainLogFile('win32', { home: 'C:\\Users\\u', dataLocal: 'C:\\Users\\u\\AppData\\Local' }, 'com.deepstudent.app'))
      .toBe('C:\\Users\\u\\AppData\\Local\\com.deepstudent.app\\logs\\electron-main.log');
    expect(mainLogFile('linux', { home: '/home/u', dataLocal: null }, 'com.deepstudent.app')).toBeNull();
  });
});

describe('OutputTail', () => {
  it('keeps the last bytes, starting at a line boundary when it had to cut', () => {
    const tail = new OutputTail(16);
    tail.push(Buffer.from('first line\nsecond\n'));
    tail.push('third line\n');
    expect(tail.text()).toBe('third line\n');
    const small = new OutputTail(64);
    small.push('a\n');
    small.push(Buffer.from('b'));
    expect(small.text()).toBe('a\nb');
  });

  it('does not split a multi-byte character when it cuts without a newline', () => {
    const tail = new OutputTail(5);
    tail.push(Buffer.from('ab作文'));
    expect(tail.text()).toBe('作文'.slice(1));
  });
});

describe('describeHostGone', () => {
  it('names the signal for killed/crashed and the exit code otherwise', () => {
    expect(describeHostGone({ reason: 'killed', exitCode: 9 })).toBe('reason killed, signal SIGKILL (9)');
    expect(describeHostGone({ reason: 'crashed', exitCode: 6 })).toBe('reason crashed, signal SIGABRT (6)');
    expect(describeHostGone({ reason: 'abnormal-exit', exitCode: 768 })).toBe('reason abnormal-exit, exit status 768');
    expect(describeHostGone({ reason: 'oom', exitCode: 0 })).toBe('reason oom, exit status 0');
  });
});
