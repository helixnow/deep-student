#!/usr/bin/env python3
"""Compact disaster recovery: current migrated code + lane diffs + WIP + board."""
import json
import pathlib
import subprocess
import tarfile
import tempfile
import time

root = pathlib.Path('/home/dsdev/dev/deep-student')
dest = pathlib.Path('/var/backups/ds-migration/quick')
dest.mkdir(parents=True, exist_ok=True, mode=0o700)
stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
work = pathlib.Path(tempfile.mkdtemp(prefix=stamp + '-', dir=dest))


def git(*args, cwd=root):
    return subprocess.check_output(['git', '-c', 'safe.directory=*', '-C', str(cwd), *args])


head = git('rev-parse', 'main').decode().strip()
with (work / 'main-code.tar').open('wb') as out:
    subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(root), 'archive', head,
                    'host', 'electron', 'contracts', 'scripts/electron-migration',
                    'migration', 'docs/dev/electron-migration', 'src-tauri/src',
                    'src-tauri/crates'], stdout=out, check=True)
refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').decode()
(work / 'refs.txt').write_text(refs)
lanes = work / 'lanes'
lanes.mkdir()
for line in refs.splitlines():
    ref, sha = line.split()
    if ref == 'refs/heads/main':
        continue
    patch = git('diff', '--binary', head, sha)
    if patch:
        (lanes / (ref.removeprefix('refs/heads/').replace('/', '__') + '.patch')).write_bytes(patch)
with (work / 'state.tar').open('wb') as out:
    names = ['.oc-runs/board', '.oc-runs/sessions.json', '.oc-runs/incidents.jsonl',
             '.oc-runs/integrate.holds.json', '.oc-runs/maintenance-night.md']
    subprocess.run(['tar', '-C', str(root), '-cf', '-', *[n for n in names if (root / n).exists()]], stdout=out, check=False)
wips = work / 'wip'
wips.mkdir()
for tree in (root.parent / 'ds-mig').iterdir():
    if not (tree / '.git').exists():
        continue
    (wips / (tree.name + '.patch')).write_bytes(git('diff', '--binary', 'HEAD', cwd=tree))
    # Preserve untracked source files from their actual worktree, not the caller's cwd.
    untracked = git('ls-files', '--others', '--exclude-standard', '-z', cwd=tree).split(b'\0')
    for name in filter(None, untracked):
        relative = pathlib.Path(name.decode())
        source = tree / relative
        if source.is_file() and source.stat().st_size <= 8 * 1024**2:
            target = wips / 'untracked' / tree.name / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
(work / 'README.json').write_text(json.dumps({'main': head, 'capturedAt': stamp,
    'scope': 'migration code snapshot, all branch diffs, WIP and board; full Git history and OpenCode DB in regular snapshots',
    'restore': 'extract main-code.tar; apply the chosen lane patch, then that worktree WIP patch; full bundle restores original history'}, indent=2))
archive = dest / (stamp + '.tar.zst')
subprocess.run(['tar', '-I', 'zstd -T1 -6', '-C', str(work), '-cf', str(archive), '.'], check=True)
print(archive)
