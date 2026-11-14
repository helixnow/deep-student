"""python3 -m unittest ops/oc-orchestrator/night/test_night_guard.py

Every hostile-input case builds the attack in a temp dir (symlinks, FIFOs, forged receipts, pre-linked
paths), runs guard.main() against it with a recording command runner, and asserts nothing outside the
fixture's own tree was read into output, written, chowned or removed.
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('night_guard', pathlib.Path(__file__).with_name('night-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
NOW = 1_800_000_000.0
SECRET = 'SECRET-SHADOW-CONTENT'
SYSTEMCTL = ['sudo', '-n', '/usr/bin/systemctl']


class UnitDecisions(unittest.TestCase):
    def test_not_running_and_not_held_is_started_even_after_a_clean_exit(self):
        # ds-migration has Restart=on-failure; a code-0 exit left it down for good under v2's "Result=success = human stop".
        self.assertEqual(guard.decide_unit({'active': 'inactive', 'result': 'success'}, [], NOW, None)[0], 'start')
        # A stop that hit TimeoutStopSec ends with Result=timeout; only an explicit hold says "on purpose".
        self.assertEqual(guard.decide_unit({'active': 'inactive', 'result': 'timeout'}, [], NOW, 'hold file')[0], 'hold')

    def test_failed_unit_starts_then_backs_off_then_breaks(self):
        failed = {'active': 'failed', 'result': 'exit-code'}
        self.assertEqual(guard.decide_unit(failed, [], NOW, None)[0], 'start')
        self.assertEqual(guard.decide_unit(failed, [NOW - 60], NOW, None)[0], 'backoff')
        self.assertEqual(guard.decide_unit(failed, [NOW - 3000, NOW - 2000, NOW - 900], NOW, None)[0], 'breaker')
        self.assertEqual(guard.decide_unit(failed, [NOW - 3 * 3600], NOW, None)[0], 'start')

    def test_unknown_status_is_never_acted_on(self):
        self.assertEqual(guard.decide_unit({'active': None, 'result': None}, [], NOW, None)[0], 'unknown')


class HeartbeatDecisions(unittest.TestCase):
    def test_stopped_dispatcher_is_not_restarted_for_a_stale_heartbeat(self):
        self.assertEqual(guard.decide_heartbeat(False, 99999, [], NOW, None)[0], 'skip')

    def test_hung_dispatcher_restarts_once_then_opens_breaker(self):
        self.assertEqual(guard.decide_heartbeat(True, 300, [], NOW, None)[0], 'ok')
        self.assertEqual(guard.decide_heartbeat(True, 1200, [], NOW, None)[0], 'restart')
        self.assertEqual(guard.decide_heartbeat(True, 1200, [NOW - 600], NOW, None)[0], 'backoff')
        self.assertEqual(guard.decide_heartbeat(True, 1200, [NOW - 5000, NOW - 2500], NOW, None)[0], 'breaker')
        self.assertEqual(guard.decide_heartbeat(True, 1200, [], NOW, 'maintenance')[0], 'hold')


class FulltestCandidate(unittest.TestCase):
    def test_only_complete_submissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = pathlib.Path(tmp) / 'fulltest' / 'runs' / '2026-11-06T165321717Z-1'
            run.mkdir(parents=True)
            (run / 'source.json').write_text(json.dumps({'head': 'abc'}))
            for i in range(1, 8):
                (run / f'shard-{i}.submitted.json').write_text('{}')
            self.assertIsNone(guard.fulltest_resume_candidate(tmp, False), 'a missing submission would mean resubmitting tests')
            (run / 'shard-8.submitted.json').write_text('{}')
            self.assertIsNone(guard.fulltest_resume_candidate(tmp, True), 'live controller')
            self.assertEqual(guard.fulltest_resume_candidate(tmp, False), run.name)
            (run / 'verdict.json').write_text(json.dumps({'complete': True}))
            self.assertIsNone(guard.fulltest_resume_candidate(tmp, False))


class SafeIO(unittest.TestCase):
    def test_safe_read_refuses_links_fifos_and_caps_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            t = pathlib.Path(tmp)
            (t / 'secret').write_text(SECRET)
            os.symlink(t / 'secret', t / 'link')
            os.mkfifo(t / 'fifo')
            (t / 'big').write_bytes(b'x' * 5000)
            self.assertIsNone(guard.safe_read(t / 'link', 100))
            self.assertIsNone(guard.safe_read(t / 'fifo', 100))
            self.assertEqual(len(guard.safe_read(t / 'big', 100)), 100)
            self.assertIsNone(guard.safe_read('/dev/zero', 100), 'character devices are not regular files')


class Fixture(unittest.TestCase):
    """A dsdev home with the production layout under a temp dir, plus an 'outside' tree the attacks target."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.outside = base / 'outside'
        (self.outside / 'fakeroot' / 'usr' / 'bin').mkdir(parents=True)
        (self.outside / 'fakeroot' / 'usr' / 'bin' / 'ls').write_text('binary')
        (self.outside / 'shadow').write_text(SECRET)
        (self.outside / 'authorized_keys').write_text('ORIGINAL')
        self.home = base / 'home'
        self.root = self.home / 'dev' / 'deep-student'
        self.runs = self.root / '.oc-runs'
        self.wt_root = self.home / 'dev' / 'ds-mig'
        self.ops = self.home / 'ops-night'
        for d in (self.runs, self.root / '.git' / 'worktrees' / 'X7' / 'logs', self.wt_root / 'X7', self.ops,
                  self.home / '.oc-jobs' / 'done', self.home / '.oc-jobs' / 'running', self.home / '.oc-jobs' / 'tmp'):
            d.mkdir(parents=True, exist_ok=True)
        (self.root / '.git' / 'packed-refs').write_text('')
        self.cfg = guard.Config(root=self.root, wt_root=self.wt_root, ops=self.ops, home=self.home,
                                proc=base / 'proc', uid=os.getuid())
        self.units = {u: {'ActiveState': 'active', 'Result': 'success', 'MainPID': '0'} for u in guard.UNITS}
        self.calls = []
        self.fail = {}
        self.chowns = []
        patches = [mock.patch.object(os, name, side_effect=lambda *a, **k: self.chowns.append(a)) for name in ('chown', 'lchown', 'fchown')]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(AssertionError('guard hung')))
        signal.alarm(20)
        self.addCleanup(signal.alarm, 0)

    def tearDown(self):
        self.tmp.cleanup()

    def runner(self, args, timeout, input=None):
        self.calls.append(list(args))
        for prefix, effect in self.fail.items():
            if ' '.join(args).startswith(prefix):
                if isinstance(effect, BaseException) or (isinstance(effect, type) and issubclass(effect, BaseException)):
                    raise effect
                effect(args)
        if args[:2] == ['systemctl', 'show']:
            props = self.units[args[2]]
            return 0, ''.join(f'{k}={v}\n' for k, v in props.items())
        return 0, ''

    def main(self, now=NOW):
        return guard.main(self.cfg, run=self.runner, now=now, sleep=lambda s: None)

    def sudo_calls(self):
        return [c[3:] for c in self.calls if c[:3] == SYSTEMCTL]

    def progress(self):
        return (self.runs / 'night-progress.json').read_text()

    def state(self):
        return json.loads((self.ops / 'guard-state.json').read_text())

    def assert_outside_untouched(self):
        self.assertEqual((self.outside / 'shadow').read_text(), SECRET)
        self.assertEqual((self.outside / 'authorized_keys').read_text(), 'ORIGINAL')
        self.assertEqual((self.outside / 'fakeroot' / 'usr' / 'bin' / 'ls').read_text(), 'binary')
        self.assertEqual(self.chowns, [], 'the guard never changes ownership')


class GuardMain(Fixture):
    def test_refuses_to_run_as_root(self):
        with mock.patch.object(guard.os, 'geteuid', return_value=0):
            with self.assertRaises(SystemExit):
                self.main()
        self.assertEqual(self.calls, [])

    def test_failed_unit_is_reset_and_started_through_the_exact_sudo_rule(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        self.main()
        self.assertEqual(self.sudo_calls(), [['reset-failed', 'ds-jobs.service'], ['start', 'ds-jobs.service']])
        audit = [json.loads(line) for line in (self.runs / 'repairs.jsonl').read_text().splitlines()]
        self.assertEqual([a['action'] for a in audit], ['unit-start'])
        self.assertEqual(json.loads(self.progress())['ds-jobs.service'], 'failed/exit-code')
        self.assert_outside_untouched()

    def test_hold_file_and_maintenance_marker_stop_all_starts(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'inactive', 'Result': 'timeout', 'MainPID': '0'}
        (self.ops / 'hold').mkdir()
        (self.ops / 'hold' / 'ds-jobs').write_text('manual stop for investigation')
        self.main()
        self.assertEqual(self.sudo_calls(), [])
        self.units['ds-dashboard.service'] = {'ActiveState': 'failed', 'Result': 'signal', 'MainPID': '0'}
        (self.runs / 'maintenance.json').write_text('{"by":"deploy"}')
        self.main(NOW + 900)
        self.assertEqual(self.sudo_calls(), [])

    def test_long_lived_holds_are_alerted_with_age_and_reason(self):
        (self.ops / 'hold').mkdir()
        old = self.ops / 'hold' / 'ds-jobs'
        old.write_text('X7: keep jobs down while bisecting')
        os.utime(old, (NOW - 7 * 3600, NOW - 7 * 3600))
        young = self.ops / 'hold' / 'ds-dashboard'
        young.write_text('restyling')
        os.utime(young, (NOW - 3600, NOW - 3600))
        marker = self.runs / 'maintenance.json'
        marker.write_text(json.dumps({'by': 'C2-platform', 'reason': 'disk'}))
        os.utime(marker, (NOW - 30 * 3600, NOW - 30 * 3600))
        os.symlink(self.outside / 'shadow', self.ops / 'hold' / 'ds-fulltest')
        os.utime(self.ops / 'hold' / 'ds-fulltest', (NOW - 9 * 3600, NOW - 9 * 3600), follow_symlinks=False)
        snapshot = self.main()
        alerts = {a['name']: a for a in snapshot['holdAlerts']}
        self.assertEqual(sorted(alerts), ['hold/ds-fulltest', 'hold/ds-jobs', 'maintenance.json'])
        self.assertIn('bisecting', alerts['hold/ds-jobs']['reason'])
        self.assertEqual(alerts['maintenance.json']['by'], 'C2-platform')
        self.assertEqual(round(alerts['maintenance.json']['ageHours']), 30)
        self.assertTrue(alerts['hold/ds-jobs']['since'].startswith('20'))
        self.assertNotIn(SECRET, self.progress())
        self.cfg.hold_alert_hours = 8
        self.assertEqual(sorted(a['name'] for a in self.main(NOW + 60)['holdAlerts']), ['hold/ds-fulltest', 'maintenance.json'])

    def test_hold_dir_can_live_outside_the_dsdev_tree(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        (self.ops / 'hold').mkdir()
        (self.ops / 'hold' / 'ds-jobs').write_text('agent-made')
        root_only = self.outside / 'hold'
        root_only.mkdir()
        self.cfg.hold_dir = root_only
        self.main()
        self.assertEqual(self.sudo_calls(), [['reset-failed', 'ds-jobs.service'], ['start', 'ds-jobs.service']], 'agent-made hold ignored')
        (root_only / 'ds-jobs').write_text('operator')
        self.main(NOW + 3 * 3600)
        self.assertEqual(len(self.sudo_calls()), 2)

    def test_symlinked_maintenance_marker_holds_without_leaking_its_target(self):
        os.symlink(self.outside / 'shadow', self.runs / 'maintenance.json')
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        self.main()
        self.assertEqual(self.sudo_calls(), [], 'a marker of any type still holds')
        self.assertNotIn(SECRET, self.progress())
        self.assertNotIn(SECRET, (self.ops / 'guard-state.json').read_text())
        self.assert_outside_untouched()

    def test_fifo_marker_and_fifo_watch_log_do_not_hang(self):
        os.mkfifo(self.ops / 'maintenance')
        os.mkfifo(self.runs / 'watch.log')
        self.main()
        self.assertIn('maintenance', json.loads(self.progress())['maintenanceHold'])

    def stale_dispatcher(self):
        self.units['ds-migration.service'] = {'ActiveState': 'active', 'Result': 'success', 'MainPID': '4242'}
        hb = self.runs / 'scheduler-heartbeat.json'
        hb.write_text('{}')
        os.utime(hb, (NOW - 3600, NOW - 3600))

    def test_stale_heartbeat_restart_is_recorded_before_systemctl_runs(self):
        self.stale_dispatcher()
        seen = []
        self.fail['sudo -n /usr/bin/systemctl restart'] = lambda args: seen.append(self.state().get('watchdog-restarts'))
        self.main()
        self.assertEqual(self.sudo_calls(), [['restart', 'ds-migration.service']])
        self.assertEqual(seen, [[NOW]], 'breaker input is durable before the action that could hang')
        diags = list((self.ops / 'diag').iterdir())
        self.assertEqual(len(diags), 1)
        self.assertEqual(stat.S_IMODE(diags[0].stat().st_mode), 0o600)

    def test_diag_capture_never_writes_through_prelinked_paths_or_reads_huge_logs(self):
        self.stale_dispatcher()
        (self.ops / 'diag').mkdir()
        old_name = self.ops / 'diag' / (guard.time.strftime('%Y%m%dT%H%M%SZ', guard.time.gmtime(NOW)) + '-dispatcher.txt')
        os.symlink(self.outside / 'authorized_keys', old_name)
        with open(self.runs / 'watch.log', 'wb') as f:
            f.truncate(3 * 1024 ** 3)
            f.seek(0, os.SEEK_END)
            f.write(b'\nLAST-LINE\n')
        self.main()
        diags = [p for p in (self.ops / 'diag').iterdir() if not p.is_symlink()]
        self.assertEqual(len(diags), 1)
        text = diags[0].read_text()
        self.assertIn('LAST-LINE', text)
        self.assertLess(len(text), 64 * 1024)
        self.assert_outside_untouched()

    def test_symlinked_diag_dir_is_refused(self):
        self.stale_dispatcher()
        os.symlink(self.outside, self.ops / 'diag')
        before = sorted(os.listdir(self.outside))
        self.main()
        self.assertEqual(sorted(os.listdir(self.outside)), before)
        self.assertEqual(self.sudo_calls(), [['restart', 'ds-migration.service']], 'diag failure does not block the restart')

    def test_symlinked_audit_progress_and_state_files_are_replaced_not_followed(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        os.symlink(self.outside / 'authorized_keys', self.runs / 'repairs.jsonl')
        os.symlink(self.outside / 'authorized_keys', self.runs / 'night-progress.json')
        os.symlink(self.outside / 'authorized_keys', self.runs / 'night-progress.tmp')
        os.symlink(self.outside / 'authorized_keys', self.ops / 'guard-state.json')
        snapshot = self.main()
        self.assert_outside_untouched()
        self.assertFalse((self.runs / 'night-progress.json').is_symlink())
        self.assertFalse((self.ops / 'guard-state.json').is_symlink())
        self.assertTrue(any('audit' in e for e in snapshot['errors']))

    def test_state_survives_a_start_that_times_out(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        self.fail['sudo -n /usr/bin/systemctl start'] = subprocess.TimeoutExpired('systemctl', 30)
        for i in range(4):
            self.main(NOW + i * 700)
        starts = [c for c in self.sudo_calls() if c[0] == 'start']
        self.assertEqual(len(starts), 3, 'the fourth run hits the breaker although every start timed out')
        self.assertEqual(len(self.state()['starts-ds-jobs.service']), 3)

    def test_state_survives_a_crash_in_a_later_section(self):
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        self.fail['git'] = RuntimeError('boom')
        with mock.patch.object(guard, 'scan_foreign', side_effect=RuntimeError('scan exploded')):
            snapshot = self.main()
        self.assertEqual(len(self.state()['starts-ds-jobs.service']), 1)
        self.assertTrue(any('scan exploded' in e for e in snapshot['errors']))
        self.assertIn('ds-jobs.service', json.loads(self.progress()))

    def test_command_budget_keeps_the_run_inside_the_unit_timeout(self):
        clock = [0.0]
        self.cfg.budget = 100

        def slow(args):
            clock[0] += 60
        self.fail['systemctl show'] = slow
        with mock.patch.object(guard.time, 'monotonic', side_effect=lambda: clock[0]):
            snapshot = self.main()
        self.assertLessEqual(sum(1 for c in self.calls if c[:2] == ['systemctl', 'show']), 2)
        self.assertTrue(any('budget' in e for e in snapshot['errors']))

    def test_corrupt_state_holds_actions_instead_of_resetting_breakers(self):
        (self.ops / 'guard-state.json').write_text('{"starts-ds-jobs.service": [1, 2')
        self.units['ds-jobs.service'] = {'ActiveState': 'failed', 'Result': 'exit-code', 'MainPID': '0'}
        snapshot = self.main()
        self.assertEqual(self.sudo_calls(), [])
        self.assertTrue(any('state' in e for e in snapshot['errors']))

    def test_done_directory_and_request_files_are_ignored(self):
        req = self.runs / 'repair' / 'requests'
        (req / 'git-ownership-x.done').mkdir(parents=True)
        (req / 'git-ownership-x.json').write_text('{}')
        self.main()
        self.assertTrue((req / 'git-ownership-x.json').exists())

    def test_fulltest_resume_is_delegated_and_respects_hold(self):
        run = self.runs / 'fulltest' / 'runs' / '2026-11-06T165321717Z-1'
        run.mkdir(parents=True)
        (run / 'source.json').write_text('{}')
        for i in range(1, 9):
            (run / f'shard-{i}.submitted.json').write_text('{}')
        (self.ops / 'hold').mkdir()
        (self.ops / 'hold' / 'ds-fulltest').write_text('stopped on purpose')
        self.main()
        self.assertFalse(any('fulltest-resume' in c for c in self.calls))
        (self.ops / 'hold' / 'ds-fulltest').unlink()
        self.main(NOW + 600)
        resume = [c for c in self.calls if 'fulltest-resume' in c]
        self.assertEqual(len(resume), 1)
        self.assertEqual(resume[0][1:], [str(self.root / 'scripts/electron-migration/coord.mjs'), 'repair', 'apply', 'fulltest-resume', '--from', 'night-guard'])


class Ownership(Fixture):
    def test_detects_but_never_chowns(self):
        self.cfg.uid = os.getuid() + 12345
        snapshot = self.main()
        self.assertGreater(snapshot['foreignOwned'], 0)
        self.assertIn('chown -R -P --from=root', json.dumps(snapshot, ensure_ascii=False))
        self.assert_outside_untouched()

    def test_symlinked_worktree_root_and_git_dir_are_refused(self):
        self.cfg.uid = os.getuid() + 12345
        os.rename(self.wt_root, self.wt_root.with_name('ds-mig-real'))
        os.symlink(self.outside, self.wt_root)
        os.rename(self.root / '.git', self.root / '.git-real')
        os.symlink(self.outside / 'fakeroot', self.root / '.git')
        found = guard.scan_foreign(self.root, self.wt_root, self.cfg.uid)
        self.assertFalse(any(str(self.outside) in p for p in found['paths']), found)
        self.assertEqual(sorted(found['refused']), sorted([str(self.root / '.git'), str(self.wt_root)]))

    def test_loose_object_dirs_are_checked_but_not_walked(self):
        (self.root / '.git' / 'objects' / 'ab').mkdir(parents=True)
        (self.root / '.git' / 'objects' / 'ab' / 'cd').write_text('')
        rel = {os.path.relpath(p, str(self.root)) for p in guard.scan_foreign(self.root, self.wt_root, os.getuid() + 1)['paths']}
        self.assertIn('.git/objects/ab', rel)
        self.assertIn('.git/worktrees/X7/logs', rel)
        self.assertNotIn('.git/objects/ab/cd', rel)
        self.assertEqual(guard.scan_foreign(self.root, self.wt_root, os.getuid())['paths'], [])

    def test_symlink_inside_worktree_is_not_followed(self):
        os.symlink(self.outside, self.wt_root / 'X7' / 'escape')
        found = guard.scan_foreign(self.root, self.wt_root, os.getuid() + 12345)
        self.assertFalse(any(p.startswith(str(self.wt_root / 'X7' / 'escape') + os.sep) for p in found['paths']))


class TmpCleanup(Fixture):
    def receipt(self, name, tmpdir):
        (self.home / '.oc-jobs' / 'done' / f'{name}.json').write_text(json.dumps({'tmpdir': str(tmpdir)}))

    def age(self, path):
        os.utime(path, (NOW - 3 * 86400, NOW - 3 * 86400), follow_symlinks=False)

    def test_reviewer_poc_symlinked_tmp_root_with_forged_receipt(self):
        os.symlink(self.outside / 'fakeroot', self.home / 'oc-jobs-tmp')
        self.receipt('usr', self.home / 'oc-jobs-tmp' / 'usr')
        self.age(self.outside / 'fakeroot' / 'usr')
        snapshot = self.main()
        self.assertTrue((self.outside / 'fakeroot' / 'usr' / 'bin' / 'ls').exists())
        self.assertTrue(any('oc-jobs-tmp' in e for e in snapshot['errors'] + snapshot.get('notes', [])))

    def test_removes_only_finished_job_dirs_without_following_links(self):
        tmp_root = self.home / '.oc-jobs' / 'tmp'
        done = tmp_root / 'job-a'
        (done / 'nested').mkdir(parents=True)
        (done / 'nested' / 'f').write_text('x')
        os.symlink(self.outside / 'fakeroot', done / 'escape')
        os.symlink(self.outside / 'fakeroot' / 'usr' / 'bin' / 'ls', done / 'nested' / 'file-link')
        self.age(done)
        self.receipt('job-a', done)
        os.symlink(self.outside / 'fakeroot', tmp_root / 'job-b')
        self.age(tmp_root / 'job-b')
        self.receipt('job-b', tmp_root / 'job-b')
        running = tmp_root / 'job-c'
        running.mkdir()
        self.age(running)
        self.receipt('job-c', running)
        (self.home / '.oc-jobs' / 'running' / 'job-c.json').write_text('{}')
        self.main()
        self.assertFalse(done.exists())
        self.assertTrue(running.exists())
        self.assert_outside_untouched()
        self.assertTrue((self.outside / 'fakeroot' / 'usr').is_dir())


OPS_DIR = pathlib.Path(__file__).resolve().parent.parent


class RootSideArtifacts(unittest.TestCase):
    def test_ds_backup_runs_every_repo_reading_program_as_dsdev(self):
        offenders = []
        for n, line in enumerate((OPS_DIR / 'sbin' / 'ds-backup').read_text().splitlines(), 1):
            code = line.split('#', 1)[0] if not line.lstrip().startswith('#') else ''
            for prog in ('git', 'sqlite3', 'tar', 'zstd'):
                for m in re.finditer(rf'(?<![\w/.-]){prog}(?= )', code):
                    prefix = code[:m.start()].rstrip()
                    if not (prefix.endswith('$AS') or prefix.endswith('env HOME=/home/dsdev')):
                        offenders.append(f'{n}: {line.strip()}')
        self.assertEqual(offenders, [])

    def test_historical_deploy_script_refuses_before_loading_repo_code(self):
        src = (OPS_DIR / 'night' / 'deploy-night.mjs').read_text()
        self.assertNotRegex(src, r"(?m)^import .* from '/home/")
        node = shutil.which('node')
        if node:
            result = subprocess.run([node, str(OPS_DIR / 'night' / 'deploy-night.mjs')], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 2, result.stderr)

    def test_ds_backup_output_cap_kills_an_oversized_writer(self):
        script = (OPS_DIR / 'sbin' / 'ds-backup').read_text()
        capped = re.search(r'(?m)^capped\(\) \{.*\}$', script).group(0)
        for name in ('MAX_OUTPUT_KB', 'MAX_PATCH_KB'):
            self.assertRegex(script, rf'capped \${name} ')
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / 'out'
            big = subprocess.run(['bash', '-c', capped + f'\ncapped 8 {sys.executable} -c "import sys; sys.stdout.write(\'x\' * 100000)" > {out}'],
                                 capture_output=True, timeout=30)
            self.assertNotEqual(big.returncode, 0, 'writer past the cap must fail so set -e aborts the snapshot')
            self.assertLessEqual(out.stat().st_size, 8 * 1024)
            small = subprocess.run(['bash', '-c', capped + f'\ncapped 8 echo ok > {out}'], timeout=30)
            self.assertEqual(small.returncode, 0)

    def test_guard_unit_runs_as_dsdev_inside_budget(self):
        unit = (OPS_DIR / 'night' / 'systemd' / 'ds-night-guard.service').read_text()
        self.assertIn('User=dsdev', unit)
        timeout = int(re.search(r'TimeoutStartSec=(\d+)', unit).group(1))
        self.assertGreater(timeout, guard.Config('/r', '/w', '/o', '/h').budget + 20)

    def test_sudoers_grants_exactly_the_commands_the_guard_issues(self):
        text = (OPS_DIR / 'sudoers' / 'ds-night-guard').read_text()
        body = re.sub(r'\\\n', ' ', '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('#')))
        alias = re.search(r'Cmnd_Alias\s+DS_NIGHT_GUARD\s*=\s*(.+)', body).group(1)
        granted = {c.strip() for c in alias.split(',')}
        expected = {f'/usr/bin/systemctl {verb} {u}' for u in guard.UNITS for verb in ('start', 'reset-failed')}
        expected.add('/usr/bin/systemctl restart ds-migration.service')
        self.assertEqual(granted, expected)
        self.assertNotIn('*', alias)
        self.assertRegex(body, r'(?m)^dsdev\s+ALL\s*=\s*\(root\)\s*NOPASSWD:\s*DS_NIGHT_GUARD\s*$')
        issued = re.findall(r"SYSTEMCTL \+ \['([\w-]+)', ([\w'.-]+)\]", (OPS_DIR / 'night' / 'night-guard.py').read_text())
        self.assertEqual({v for v, _ in issued}, {'start', 'reset-failed', 'restart'})


if __name__ == '__main__':
    unittest.main()
