#!/usr/bin/env python3
"""Night supervisor for the migration pipeline: known control faults only. Runs as dsdev, never root.

Everything it reads is written by dsdev agents and treated as untrusted: files are opened with
O_NOFOLLOW|O_NONBLOCK, must be regular and are read up to a size cap; outputs are created with
O_EXCL in a random name and renamed into place. The only privileged operations are
`sudo -n /usr/bin/systemctl start|restart|reset-failed <ds-* unit>`, granted one by one in
ops/oc-orchestrator/sudoers/ds-night-guard.

Rules (v3):
- A unit that is not running is started unless it is held: ops-night/hold/<unit-name> (e.g. hold/ds-jobs),
  ops-night/maintenance or .oc-runs/maintenance.json. Stopping a unit on purpose means writing a hold file
  first; Result= is not a reliable signal (a stop that times out ends with Result=timeout, a clean exit of a
  Restart=on-failure unit with Result=success).
- Starts back off for 10 minutes; three starts in two hours open a breaker.
- A stale scheduler heartbeat restarts only an active dispatcher, after saving diagnostics; a second
  restart in two hours opens a breaker.
- Each start/restart is written to guard-state.json before systemctl runs, so a hang or kill keeps the
  breaker input. Each section runs under its own try/except; all commands share one time budget that ends
  before the unit's TimeoutStartSec.
- File ownership is reported, never changed (see the README for the one-time manual fix).
- fulltest resume is delegated to `coord.mjs repair apply fulltest-resume` (single audit trail, honours holds).
"""
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time

HOUR = 3600
FULLTEST_SHARDS = 8
UNITS = ['ds-migration.service', 'ds-jobs.service', 'ds-dashboard.service']
ACTIVE_STATES = ('active', 'activating', 'reloading', 'deactivating')
SYSTEMCTL = ['sudo', '-n', '/usr/bin/systemctl']
NODE = '/opt/node26/bin/node'
READ_CAP = 1024 * 1024


class Config:
    def __init__(self, root, wt_root, ops, home, proc='/proc', uid=None, node=NODE, budget=110, hold_alert_hours=None):
        self.root = pathlib.Path(root)
        self.runs = self.root / '.oc-runs'
        self.wt_root = pathlib.Path(wt_root)
        self.ops = pathlib.Path(ops)
        self.home = pathlib.Path(home)
        self.spool = self.home / '.oc-jobs'
        # ~/oc-jobs-tmp is the TMPDIR root since W09 e60501a; ~/.oc-jobs/tmp is the legacy one.
        self.tmp_roots = [self.spool / 'tmp', self.home / 'oc-jobs-tmp']
        self.state = self.ops / 'guard-state.json'
        # DS_HOLD_DIR can point outside the dsdev-writable tree (e.g. /etc/ds-ops/hold) so agents cannot hold units.
        self.hold_dir = pathlib.Path(os.environ.get('DS_HOLD_DIR') or self.ops / 'hold')
        self.proc = pathlib.Path(proc)
        self.uid = os.getuid() if uid is None else uid
        self.node = node
        self.budget = budget
        if hold_alert_hours is None:
            try:
                hold_alert_hours = float(os.environ.get('DS_HOLD_ALERT_HOURS', '6'))
            except ValueError:
                hold_alert_hours = 6.0
        self.hold_alert_hours = hold_alert_hours if hold_alert_hours > 0 else 6.0


def default_config():
    home = pathlib.Path('/home/dsdev')
    return Config(root=home / 'dev/deep-student', wt_root=home / 'dev/ds-mig', ops=home / 'ops-night', home=home)


class BudgetExceeded(Exception):
    pass


# ---------------------------------------------------------------------------
# Untrusted-input I/O
# ---------------------------------------------------------------------------
def _open_regular(path):
    """fd of a regular file at path, or None for links, FIFOs, devices, directories and missing files."""
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0))
    except OSError:
        return None
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            return fd
    except OSError:
        pass
    os.close(fd)
    return None


def safe_read(path, limit=READ_CAP):
    fd = _open_regular(path)
    if fd is None:
        return None
    try:
        return os.read(fd, limit)
    except OSError:
        return None
    finally:
        os.close(fd)


def safe_tail(path, limit=8192):
    fd = _open_regular(path)
    if fd is None:
        return None
    try:
        size = os.fstat(fd).st_size
        os.lseek(fd, max(0, size - limit), os.SEEK_SET)
        return os.read(fd, limit)
    except OSError:
        return None
    finally:
        os.close(fd)


CORRUPT = object()


def safe_json(path, default=None, limit=READ_CAP):
    """Parsed JSON, default when absent/unreadable, CORRUPT when present as a regular file but unparsable."""
    data = safe_read(path, limit)
    if data is None:
        return default
    try:
        return json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return CORRUPT


def lexists(path):
    try:
        os.lstat(str(path))
        return True
    except OSError:
        return False


def is_real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(str(path)).st_mode)
    except OSError:
        return False


def write_atomic(path, text, mode=0o644):
    """Write via a random O_EXCL temp file in the same directory, then rename over path (a link at path is replaced, not followed)."""
    path = pathlib.Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_line(path, line):
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0), 0o644)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(f'{path} is not a regular file')
        os.write(fd, line.encode('utf-8'))
    finally:
        os.close(fd)


def printable(data, limit=200):
    text = data.decode('utf-8', 'replace') if isinstance(data, bytes) else str(data)
    return re.sub(r'[\x00-\x1f\x7f]', ' ', text).strip()[:limit]


# ---------------------------------------------------------------------------
# Decisions (pure)
# ---------------------------------------------------------------------------
def recent(history, now, window):
    return [t for t in history or [] if isinstance(t, (int, float)) and now - t < window]


def decide_unit(status, starts, now, hold):
    """status: {'active': ActiveState, 'result': Result}. Returns (action, why)."""
    active, result = status.get('active'), status.get('result')
    if active in ACTIVE_STATES:
        return 'ok', active
    if hold:
        return 'hold', hold
    if not active:
        return 'unknown', 'systemctl show gave no ActiveState'
    last2h = recent(starts, now, 2 * HOUR)
    if len(last2h) >= 3:
        return 'breaker', f'{len(last2h)} starts in 2h'
    if last2h and now - last2h[-1] < 600:
        return 'backoff', 'started less than 10 minutes ago'
    return 'start', f'{active}/{result}'


def decide_heartbeat(unit_active, age, restarts, now, hold):
    if not unit_active:
        return 'skip', 'dispatcher not running; a stale heartbeat is expected'
    if age is None or age <= 900:
        return 'ok', ''
    if hold:
        return 'hold', hold
    last2h = recent(restarts, now, 2 * HOUR)
    if len(last2h) >= 2:
        return 'breaker', 'restarted twice in 2h; another restart would hide the bug'
    if last2h and now - last2h[-1] < 1800:
        return 'backoff', 'restarted less than 30 minutes ago'
    return 'restart', f'heartbeat {int(age)}s old'


def maintenance_hold(cfg):
    for marker in (cfg.ops / 'maintenance', cfg.runs / 'maintenance.json'):
        if lexists(marker):
            data = safe_read(marker, 200)
            reason = printable(data) if data else '(not a regular file)'
            return f'{marker.name}: {reason}'
    return None


def unit_hold(cfg, name):
    path = cfg.hold_dir / name
    if not lexists(path):
        return None
    data = safe_read(path, 200)
    return f'hold/{name}: {printable(data) if data else "(no reason)"}'


def stale_holds(cfg, now):
    """Hold files and maintenance markers older than cfg.hold_alert_hours: any dsdev agent can create them,
    and the guard obeys them forever, so long-lived ones are surfaced with when (mtime), who and why."""
    files = [('maintenance', cfg.ops / 'maintenance'), ('maintenance.json', cfg.runs / 'maintenance.json')]
    hold_dir = cfg.hold_dir
    if is_real_dir(hold_dir):
        files += [(f'hold/{n}', hold_dir / n) for n in sorted(os.listdir(str(hold_dir))) if re.fullmatch(r'[\w.-]+', n)]
    out = []
    for name, path in files:
        try:
            st = os.lstat(str(path))
        except OSError:
            continue
        age = now - st.st_mtime
        if age <= cfg.hold_alert_hours * HOUR:
            continue
        data = safe_read(path, 200)
        by, reason = None, printable(data) if data else '(不是普通文件或为空，未读取)'
        try:
            parsed = json.loads(data.decode('utf-8')) if data else None
            if isinstance(parsed, dict):
                by = printable(parsed['by'], 80) if isinstance(parsed.get('by'), str) else None
                reason = printable(parsed.get('reason', reason))
        except (ValueError, UnicodeDecodeError):
            pass
        out.append({'name': name, 'since': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(st.st_mtime)),
                    'ageHours': round(age / HOUR, 1), 'by': by, 'uid': st.st_uid, 'reason': reason})
    return out


# ---------------------------------------------------------------------------
# Ownership (detect only)
# ---------------------------------------------------------------------------
LOOSE_OBJECT_DIR = re.compile(r'(^|/)objects/[0-9a-f]{2}$')


def scan_foreign(root, wt_root, uid, limit=20000):
    """Entries under <root>/.git and <wt_root>/<lane> (two levels) not owned by uid.

    Never follows a symlink: a symlinked top directory is refused, and the walk uses os.fwalk with
    follow_symlinks=False so a directory swapped for a link mid-walk is not entered.
    """
    found, refused = [], []

    def walk(top, max_depth, prune, include_top):
        top = str(top)
        if not lexists(top):
            return
        if not is_real_dir(top):
            refused.append(top)
            return
        if include_top and os.lstat(top).st_uid != uid:
            found.append(top)
        for dirpath, dirnames, filenames, dirfd in os.fwalk(top, follow_symlinks=False):
            rel = os.path.relpath(dirpath, top)
            depth = 0 if rel == '.' else rel.count(os.sep) + 1
            for name in dirnames + filenames:
                if len(found) >= limit:
                    return
                try:
                    if os.stat(name, dir_fd=dirfd, follow_symlinks=False).st_uid != uid:
                        found.append(os.path.join(dirpath, name))
                except OSError:
                    pass
            # Pruned dirs (objects/xx, node_modules) are themselves checked above; their contents are not walked.
            dirnames[:] = [] if depth + 1 >= max_depth else [d for d in dirnames if not prune(os.path.join(dirpath, d))]

    walk(os.path.join(str(root), '.git'), 12, lambda p: bool(LOOSE_OBJECT_DIR.search(p)), True)
    walk(wt_root, 3, lambda p: os.path.basename(p) == 'node_modules', False)
    return {'paths': found, 'refused': refused}


def ownership_fix_command(cfg):
    owner = cfg.home.name
    tops = f'{cfg.root}/.git {cfg.wt_root}'
    return (f'先停服务并确认 pgrep -u {owner} 无输出；sudo find {tops} -xdev -user root -print 核对清单；'
            f'再执行 sudo chown -R -P --from=root {owner}:{owner} {tops}')


# ---------------------------------------------------------------------------
# fulltest / tmp cleanup
# ---------------------------------------------------------------------------
def fulltest_resume_candidate(runs, controller_alive, shards=FULLTEST_SHARDS):
    """Newest fulltest run whose controller died after submitting every shard."""
    root = pathlib.Path(runs) / 'fulltest' / 'runs'
    if controller_alive or not is_real_dir(root):
        return None
    dirs = sorted((d for d in os.listdir(str(root)) if re.fullmatch(r'[\w-]+', d) and is_real_dir(root / d)), reverse=True)
    if not dirs:
        return None
    latest = root / dirs[0]
    verdict = safe_json(latest / 'verdict.json', {})
    submitted = [n for n in os.listdir(str(latest)) if re.fullmatch(r'shard-\d+\.submitted\.json', n)]
    if (isinstance(verdict, dict) and verdict.get('complete')) or len(submitted) != shards or not lexists(latest / 'source.json'):
        return None
    return latest.name


def controller_alive(cfg):
    data = safe_read(cfg.runs / 'fulltest' / 'running.lock', 64)
    try:
        pid = int(data or b'')
    except ValueError:
        return False
    try:
        args = (cfg.proc / str(pid) / 'cmdline').read_bytes()[:4096]
    except OSError:
        return False
    return any(arg.endswith(b'/fulltest.mjs') for arg in args.split(b'\0'))


def remove_tree_at(parent_fd, name):
    """rm -r of parent_fd/name that never leaves the tree: links are unlinked, not followed."""
    for dirpath, dirnames, filenames, dirfd in os.fwalk(name, topdown=False, follow_symlinks=False, dir_fd=parent_fd):
        for entry in filenames:
            os.unlink(entry, dir_fd=dirfd)
        for entry in dirnames:
            if stat.S_ISLNK(os.stat(entry, dir_fd=dirfd, follow_symlinks=False).st_mode):
                os.unlink(entry, dir_fd=dirfd)
            else:
                os.rmdir(entry, dir_fd=dirfd)
    os.rmdir(name, dir_fd=parent_fd)


def clean_job_tmp(cfg, now, notes):
    """Remove per-job TMPDIRs of finished jobs older than a day. Nothing else is eligible."""
    removed = []
    for temp_root in cfg.tmp_roots:
        if not lexists(temp_root):
            continue
        try:
            fd = os.open(str(temp_root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0))
        except OSError as error:
            notes.append(f'tmp cleanup refused {temp_root}: {error.strerror} (symlink or not a directory)')
            continue
        try:
            for name in os.listdir(fd):
                if not re.fullmatch(r'[\w.-]+', name) or name.startswith('.'):
                    continue
                try:
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISDIR(st.st_mode) or now - st.st_mtime <= 86400:
                    continue
                receipt = safe_json(cfg.spool / 'done' / (name + '.json'), {})
                if not isinstance(receipt, dict) or receipt.get('tmpdir') != str(temp_root / name):
                    continue
                if lexists(cfg.spool / 'running' / (name + '.json')):
                    continue
                remove_tree_at(fd, name)
                removed.append(str(temp_root / name))
        finally:
            os.close(fd)
    return removed


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def default_run(args, timeout, input=None):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, input=input)
    return result.returncode, result.stdout


def capture_diag(cfg, pid, now, sleep):
    """Evidence for why the dispatcher event loop stalled, saved before any restart. Returns the file or None."""
    diag = cfg.ops / 'diag'
    if lexists(diag) and not is_real_dir(diag):
        raise OSError(f'{diag} is not a real directory; refusing to write diagnostics')
    diag.mkdir(mode=0o700, exist_ok=True)
    lines = [f'pid {pid} at {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}']
    proc = cfg.proc / str(pid)

    def proc_text(name, limit=16384):
        try:
            return (proc / name).read_bytes()[:limit].decode('utf-8', 'replace')
        except OSError:
            return None

    def cpu():
        text = proc_text('stat')
        try:
            fields = text.rsplit(')', 1)[1].split()
            return int(fields[11]) + int(fields[12])
        except (AttributeError, IndexError, ValueError):
            return None

    for name in ('status', 'wchan', 'stack'):
        text = proc_text(name)
        if text is not None:
            lines.append(f'## {name}\n' + '\n'.join(text.splitlines()[:12]))
    first = cpu()
    sleep(2)
    second = cpu()
    lines.append(f'## cpu ticks over 2s: {None if first is None or second is None else second - first} (0 = blocked, >150 = busy loop)')
    tail = safe_tail(cfg.runs / 'watch.log', 16384)
    if tail is not None:
        lines.append('## watch.log tail\n' + '\n'.join(tail.decode('utf-8', 'replace').splitlines()[-40:]))
    fd, out = tempfile.mkstemp(prefix=time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now)) + '-dispatcher-', suffix='.txt', dir=str(diag))
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(lines)[:60000])
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(cfg=None, run=default_run, now=None, sleep=time.sleep):
    if os.geteuid() == 0:
        sys.exit('night-guard must not run as root (User=dsdev in ds-night-guard.service)')
    cfg = cfg or default_config()
    now = time.time() if now is None else now
    deadline = time.monotonic() + cfg.budget
    at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))
    snapshot = {'at': at, 'actions': [], 'held': [], 'errors': [], 'notes': []}
    cfg.ops.mkdir(parents=True, exist_ok=True)

    loaded = safe_json(cfg.state, {})
    state_ok = isinstance(loaded, dict)
    state = loaded if state_ok else {}
    if not state_ok:
        snapshot['errors'].append('state: guard-state.json unparsable; all start/restart actions held this run (breaker history unknown)')
    hold = maintenance_hold(cfg) or (None if state_ok else 'guard-state.json corrupt')
    snapshot['maintenanceHold'] = hold
    snapshot['holdAlerts'] = []

    def save_state():
        if state_ok:
            write_atomic(cfg.state, json.dumps(state))

    def call(args, timeout=20, input=None):
        remaining = deadline - time.monotonic()
        if remaining < 1:
            raise BudgetExceeded(f'budget of {cfg.budget}s used up before {" ".join(args[:4])}')
        try:
            return run(args, min(timeout, remaining), input=input)
        except subprocess.TimeoutExpired:
            snapshot['errors'].append(f'timeout: {" ".join(args[:5])}')
            return None, ''

    def section(name, fn):
        try:
            fn()
        except BudgetExceeded as error:
            snapshot['errors'].append(f'{name}: budget: {error}')
        except Exception as error:  # noqa: BLE001 - one broken section must not drop the rest
            snapshot['errors'].append(f'{name}: {type(error).__name__}: {printable(str(error), 300)}')

    def audit(action, **rec):
        snapshot['actions'].append(action)
        try:
            append_line(cfg.runs / 'repairs.jsonl', json.dumps({'t': at, 'action': action, 'mode': 'apply', 'by': 'night-guard', **rec}, ensure_ascii=False) + '\n')
        except OSError as error:
            snapshot['errors'].append(f'audit: {error}')

    coord = [cfg.node, str(cfg.root / 'scripts/electron-migration/coord.mjs')]

    def notify(key, lanes, text, every=1800):
        if now - state.get('notify-' + key, 0) < every:
            return
        state['notify-' + key] = now
        save_state()
        for lane in lanes:
            call(coord + ['queue', lane, '-', '--from', 'night-guard'], 30, input=text)

    statuses = {}

    def units():
        for unit in UNITS:
            name = unit.rsplit('.', 1)[0]
            code, out = call(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'Result', '-p', 'MainPID'], 10)
            kv = dict(line.split('=', 1) for line in out.splitlines() if '=' in line) if code == 0 else {}
            status = {'active': kv.get('ActiveState'), 'result': kv.get('Result'), 'pid': int(kv.get('MainPID') or 0)}
            statuses[unit] = status
            snapshot[unit] = f"{status['active']}/{status['result']}"
            unit_held = hold or unit_hold(cfg, name) or (unit == 'ds-jobs.service' and lexists(cfg.ops / 'draining') and 'draining')
            starts = state.get('starts-' + unit, [])
            action, why = decide_unit(status, starts, now, unit_held)
            if action == 'start':
                state['starts-' + unit] = recent(starts, now, 2 * HOUR) + [now]
                save_state()
                if status['active'] == 'failed':
                    call(SYSTEMCTL + ['reset-failed', unit], 15)
                code, _ = call(SYSTEMCTL + ['start', unit], 30)
                audit('unit-start', unit=unit, why=why, rc=code)
            elif action == 'breaker':
                snapshot['held'].append(f'{unit}: breaker ({why})')
                notify('breaker-' + unit, ['S0-architect', 'C0-chief'], f'{unit} 两小时内已被拉起 {why}，night-guard 停止再拉起。请查 journalctl -u {unit} 的根因，修好后删除 guard-state.json 中的 starts-{unit}。')
            elif action != 'ok':
                snapshot['held'].append(f'{unit}: {action} ({why})')

    def heartbeat():
        try:
            age = now - os.lstat(str(cfg.runs / 'scheduler-heartbeat.json')).st_mtime
        except OSError:
            age = None
        dispatcher = statuses.get('ds-migration.service', {})
        restarts = state.get('watchdog-restarts', [])
        held = hold or unit_hold(cfg, 'ds-migration')
        action, why = decide_heartbeat(dispatcher.get('active') == 'active', age, restarts, now, held)
        if action == 'restart':
            diag = None
            if dispatcher.get('pid'):
                try:
                    diag = capture_diag(cfg, dispatcher['pid'], now, sleep)
                except OSError as error:
                    snapshot['errors'].append(f'diag: {error}')
            state['watchdog-restarts'] = recent(restarts, now, 2 * HOUR) + [now]
            save_state()
            code, _ = call(SYSTEMCTL + ['restart', 'ds-migration.service'], 30)
            audit('dispatcher-restart', why=why, diag=diag, rc=code)
            notify('watchdog', ['C0-chief', 'S0-architect'], f'调度心跳停滞（{why}），night-guard 已保存诊断 {diag} 后只重启 dispatcher 主进程，未停执行者/作业。请按诊断定位事件循环阻塞并给出修复。')
        elif action == 'breaker':
            snapshot['held'].append(f'dispatcher heartbeat: breaker ({why})')
            notify('watchdog-breaker', ['S0-architect', 'C0-chief'], f'调度心跳再次停滞，night-guard 不再重启（{why}）。诊断在 {cfg.ops}/diag/，需要根因修复。')
        elif action == 'hold':
            snapshot['held'].append(f'dispatcher heartbeat: hold ({why})')

    def ownership():
        if now - state.get('ownership-at', 0) < 600:
            return
        state['ownership-at'] = now
        result = scan_foreign(cfg.root, cfg.wt_root, cfg.uid)
        snapshot['foreignOwned'] = len(result['paths'])
        if result['refused']:
            snapshot['notes'].append(f'ownership scan refused symlinked tops: {result["refused"]}')
        if result['paths']:
            sample = [os.path.relpath(p, str(cfg.root.parent)) for p in result['paths'][:8]]
            snapshot['ownershipFix'] = ownership_fix_command(cfg)
            notify('ownership', ['S0-architect'], f'发现 {len(result["paths"])} 个 .git/工作树条目不归 dsdev（样本：{sample[:3]}）。night-guard 不改属主；请主 agent 在服务器上人工执行：{snapshot["ownershipFix"]}。根因是有人以 root 在仓库里跑了 git；维护操作请用 sudo -u dsdev git。')

    def fulltest():
        latest = safe_json(cfg.runs / 'fulltest/latest.json', {})
        latest = latest if isinstance(latest, dict) else {}
        snapshot['fulltest'] = {k: latest[k] for k in ('head', 'at', 'runId', 'ok', 'complete', 'numFailedTests', 'numFailedTestSuites', 'rawFailures') if k in latest}
        ft = snapshot['fulltest']
        if ft.get('complete') and ft.get('ok') is False:
            notify('fulltest-' + printable(ft.get('runId', ft.get('head', 'unknown')), 80), ['C2-platform'],
                   '固定树全测待闭合：' + json.dumps(ft, ensure_ascii=False) + '。请分类产品失败/驱动失败/资源失败，派最小修复，不靠零failed断言忽略raw非0。', every=10 ** 9)
        held = hold or unit_hold(cfg, 'ds-fulltest')
        candidate = fulltest_resume_candidate(cfg.runs, controller_alive(cfg))
        if candidate and held:
            snapshot['held'].append(f'fulltest resume {candidate}: {held}')
        elif candidate:
            code, out = call(coord + ['repair', 'apply', 'fulltest-resume', '--from', 'night-guard'], 30)
            snapshot['notes'].append(f'fulltest-resume {candidate}: rc={code} {printable(out, 200)}')

    def resources():
        code, out = call(['git', '-C', str(cfg.root), 'rev-parse', 'main'], 10)
        snapshot['main'] = out.strip() if code == 0 else None
        jobs = safe_json(cfg.spool / 'status.json', {})
        snapshot['jobs'] = jobs if isinstance(jobs, dict) else {}
        vfs = os.statvfs('/tmp')
        snapshot['diskFreeGiB'] = round(vfs.f_bavail * vfs.f_frsize / 1024 ** 3, 1)
        if snapshot['diskFreeGiB'] < 30:
            notify('disk', ['S0-architect', 'C2-platform'], '磁盘可用不足30GiB。只回收已完成作业专用tmp或可重建缓存，禁止按年龄批删/tmp、轨迹、patch或DB；新重任务应已暂停。')
        if snapshot['jobs'].get('paused') and not snapshot['jobs'].get('draining'):
            notify('resource', ['S0-architect', 'C2-platform'], '资源准入暂停：' + json.dumps(snapshot['jobs'].get('reasons', []), ensure_ascii=False)[:500] + '。运行中任务保留；先定位占用，不改断言/NPROC，不重投刷绿。')

    def tmp_cleanup():
        removed = clean_job_tmp(cfg, now, snapshot['notes'])
        if removed:
            audit('job-tmp-cleanup', removed=len(removed), sample=removed[:5])

    def holds():
        snapshot['holdAlerts'] = stale_holds(cfg, now)

    for name, fn in (('holds', holds), ('units', units), ('heartbeat', heartbeat), ('ownership', ownership), ('fulltest', fulltest),
                     ('resources', resources), ('tmp-cleanup', tmp_cleanup)):
        section(name, fn)
    section('state', save_state)
    try:
        write_atomic(cfg.runs / 'night-progress.json', json.dumps(snapshot, ensure_ascii=False, indent=2))
    except OSError as error:
        snapshot['errors'].append(f'progress: {error}')
    return snapshot


if __name__ == '__main__':
    main()
