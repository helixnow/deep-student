from hashlib import file_digest
import json
from pathlib import Path
import subprocess
import sys

repo = 'helixnow/deep-student'
tag = 'v0.20.4'
version_sha = '81c7b46d31ebb99beccfc71170934dc0cfd64b17'
apk = 'Deep.Student_0.20.4_arm64.apk'
apk_digest = 'sha256:7a24cb7682ac65b75cfcd82f58a0291dbc38ae96df8a9b8f879ab66be7ce428a'
folder = Path(sys.argv[1])
notes = Path(sys.argv[2])
rows = json.loads((folder / 'verified-manifest.json').read_text())
assert len(rows) == 8
expected = {row['name']: row for row in rows}
assert len(expected) == 8 and apk not in expected
for row in rows:
    assert Path(row['name']).name == row['name']
    p = folder / 'verified-release-assets' / row['name']
    assert p.is_file() and not p.is_symlink() and p.stat().st_size == row['size']
    with p.open('rb') as f:
        assert file_digest(f, 'sha256').hexdigest() == row['sha256']

def run(*args):
    return subprocess.run(['gh', *args], check=True, text=True, capture_output=True).stdout

def api(path):
    return json.loads(run('api', f'repos/{repo}/{path}'))

def assets_on_release():
    release = api(f'releases/tags/{tag}')
    assert release['id'] == 447001365 and release['prerelease'] and not release['draft']
    found = {asset['name']: asset for asset in release['assets']}
    assert found[apk]['digest'] == apk_digest and found[apk]['size'] == 36930137
    for name in expected.keys() & found.keys():
        row = expected[name]
        assert found[name]['state'] == 'uploaded' and found[name]['size'] == row['size']
        assert found[name]['digest'] == 'sha256:' + row['sha256'], f'refusing to replace {name}'
    return release, found

source = api(f'git/ref/tags/{tag}')['object']
assert source['sha'] == version_sha and source['type'] == 'commit'
release, found = assets_on_release()
title = 'v0.20.4 · 实验预发布'
if release['body'].strip() != notes.read_text().strip() or release['name'] != title:
    print(run('release', 'edit', tag, '--repo', repo, '--title', title, '--notes-file', str(notes)), end='', flush=True)
missing = sorted(expected.keys() - found.keys())
if missing:
    subprocess.run(['gh', 'release', 'upload', tag, '--repo', repo,
                    *(str(folder / 'verified-release-assets' / name) for name in missing)], check=True)
release, found = assets_on_release()
assert expected.keys() <= found.keys()
assert '未使用平台发行证书签名' in release['body']
print(json.dumps({
    'url': release['html_url'],
    'prerelease': release['prerelease'],
    'androidDigestUnchanged': found[apk]['digest'] == apk_digest,
    'desktopAssets': [{"name": name, "sha256": found[name]['digest'], "url": found[name]['browser_download_url']} for name in sorted(expected)],
}, ensure_ascii=False))
