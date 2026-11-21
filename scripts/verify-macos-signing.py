#!/usr/bin/env python3
"""Verify packager signatures, then start the packaged app in an isolated launchd job.

Run with `python3 -I scripts/verify-macos-signing.py <app-or-dmg> --receipt <receipt.json>`;
add `--previous-receipt <older.json>` to require unchanged designated requirements across two
differing builds. The launchd job gets its own user-data folder, data folder and port, runs in
server mode on an empty catalogue, and is booted out afterwards. Nothing of the owner's is read.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

BUNDLE_ID = 'com.terranash.mediastudiokh'
APP_NAME = 'Business Studio KH'
HELPERS = ['', ' (GPU)', ' (Plugin)', ' (Renderer)']


def designated_requirement(output):
    lines = [line.strip() for line in output.splitlines() if line.strip().startswith('designated =>')]
    if len(lines) != 1 or 'cdhash ' in lines[0] or not re.search(r'\b(certificate|anchor)\b', lines[0]):
        raise ValueError('A certificate-based designated requirement is required')
    return lines[0]


def compare_builds(previous, current):
    if previous['version'] == current['version'] and previous['hashes'] == current['hashes']:
        raise ValueError('Compare two differing builds')
    if previous['requirements'] != current['requirements']:
        raise ValueError('Designated requirements changed across builds')
    if previous['hashes'] == current['hashes']:
        raise ValueError('The comparison must include changed bytes')


def run(command, timeout=60):
    return subprocess.run(command, check=True, text=True, capture_output=True, timeout=timeout)


def signed_identity(app, expected_authority):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info['CFBundleIdentifier'] != BUNDLE_ID:
        raise ValueError('Unexpected packaged application identifier')
    run(['codesign', '--verify', '--deep', '--strict', str(app)], timeout=300)
    result = {'version': info['CFBundleShortVersionString'], 'requirements': {}, 'hashes': {}}
    code = ['.', 'Contents/MacOS/' + APP_NAME]
    code += ['Contents/Frameworks/%s Helper%s.app' % (APP_NAME, h) for h in HELPERS]
    for relative in code:
        path = app if relative == '.' else app / relative
        description = run(['codesign', '-d', '-vvv', '-r-', str(path)])
        output = description.stdout + description.stderr
        if 'Authority=' + expected_authority not in output.splitlines():
            raise ValueError('Not signed by the configured identity: ' + relative)
        result['requirements'][relative] = designated_requirement(output)
    for relative in ['Contents/MacOS/' + APP_NAME, 'Contents/Resources/app.asar']:
        result['hashes'][relative] = hashlib.sha256((app / relative).read_bytes()).hexdigest()
    return result


def launchd_start(app, expected_version, work):
    user_data = work / 'userData'
    data_dir = work / 'data'
    user_data.mkdir(mode=0o700)
    data_dir.mkdir(mode=0o700)
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0))
        port = reserved.getsockname()[1]
    (user_data / 'config.json').write_text(json.dumps({
        'dataDir': str(data_dir), 'firstLaunchHandled': True, 'mode': 'server',
        'serverPort': port, 'serverKeepAwake': False, 'webViewerEnabled': False,
    }))
    label = 'com.terranash.mediastudiokh.signing-test.' + uuid.uuid4().hex
    domain = 'gui/' + str(os.getuid())
    service = domain + '/' + label
    job = work / 'app.plist'
    job.write_bytes(plistlib.dumps({
        'Label': label,
        'ProgramArguments': [str(app / 'Contents/MacOS' / APP_NAME), '--user-data-dir=' + str(user_data)],
        'RunAtLoad': True,
        'StandardOutPath': str(work / 'app.stdout'),
        'StandardErrorPath': str(work / 'app.stderr'),
    }))

    def ping():
        with urllib.request.urlopen('http://127.0.0.1:%d/api/ping' % port, timeout=5) as response:
            return json.load(response)

    try:
        run(['launchctl', 'bootstrap', domain, str(job)])
        deadline = time.monotonic() + 90
        health = None
        while health is None:
            try:
                health = ping()
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Packaged app did not answer /api/ping; see the retained test logs')
                time.sleep(0.5)
        if not health.get('ok') or health.get('app') != 'business-studio-kh' or health.get('version') != expected_version:
            raise ValueError('Packaged app health/version mismatch: %r' % health)
        state = run(['launchctl', 'print', service]).stdout
        pid = re.search(r'\bpid = (\d+)\b', state)
        if not pid:
            raise RuntimeError('launchd job has no running process')
        time.sleep(3)  # startup survival window, then the same process must still answer
        state = run(['launchctl', 'print', service]).stdout
        if not re.search(r'\bpid = ' + pid.group(1) + r'\b', state) or ping() != health:
            raise RuntimeError('Packaged app did not survive launchd startup')
        return {'started': True, 'health': True, 'version': health['version'],
                'survivedStartup': True, 'launchJobPID': int(pid.group(1)), 'port': port, 'bootedOut': True}
    finally:
        found = subprocess.run(['launchctl', 'print', service], capture_output=True)
        if found.returncode == 0:
            run(['launchctl', 'bootout', service])
        # Only this test's processes carry its private user-data folder on the command line.
        deadline = time.monotonic() + 30
        while subprocess.run(['pgrep', '-f', str(user_data)], capture_output=True).returncode == 0:
            if time.monotonic() > deadline:
                raise RuntimeError('Test app processes outlived bootout: ' + str(user_data))
            time.sleep(0.5)


@contextmanager
def packaged_app(package, work):
    if package.suffix.lower() != '.dmg':
        yield package
        return
    mount = work / 'mounted'
    mount.mkdir()
    attached = run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', str(mount), str(package)])
    entities = plistlib.loads(attached.stdout.encode())['system-entities']
    device = next(e['dev-entry'] for e in entities if re.fullmatch(r'/dev/disk\d+', e.get('dev-entry', '')))
    try:
        yield mount / (APP_NAME + '.app')
    finally:
        run(['hdiutil', 'detach', device])


def retain_dist(pins_path, packaged_receipt, receipt_path, result, helper):
    """Only an accepted installed payload may advance the caller's trusted retention pins."""
    packaged = json.loads(packaged_receipt.read_text())
    for key in ('version', 'requirements', 'hashes'):
        if result[key] != packaged[key]:
            raise ValueError('Installed app differs from the packaged receipt: ' + key)
    pins = json.loads(pins_path.read_text())
    if len(pins['apps']) != 1 or pins['apps'][0]['app'] != APP_NAME:
        raise ValueError('Retention pins must name only ' + APP_NAME)
    current = next(r for r in pins['apps'][0]['releases'] if r['version'] == result['version'])
    for key in ('sha256', 'bytes'):
        if current[key] != packaged['artifact'][key]:
            raise ValueError('Retention pin differs from the verified DMG: ' + key)
    if Path(current['evidence']).resolve() != receipt_path.resolve():
        raise ValueError('Current retention pin must cite this installed receipt')
    for release in pins['apps'][0]['releases']:
        if not Path(release['evidence']).is_file():
            raise ValueError('Retention acceptance evidence is missing: ' + release['version'])
    # The shared helper owns pin validation, copying, provenance, locking and retirement.
    subprocess.run(['python3', '-I', str(helper), str(pins_path)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--identity', default='KH Studio Local Signing')
    parser.add_argument('--previous-receipt', type=Path)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--skip-launch', action='store_true', help='signature checks only')
    parser.add_argument('--retain-dist', type=Path, help='trusted shared-helper pins, after installed acceptance only')
    parser.add_argument('--packaged-receipt', type=Path, help='verified DMG receipt for the installed payload')
    args = parser.parse_args()
    if args.retain_dist and (args.skip_launch or not args.packaged_receipt
                            or args.app.resolve() != Path('/Applications/Business Studio KH.app')):
        parser.error('--retain-dist requires the installed /Applications app, launch check and --packaged-receipt')
    work = Path(tempfile.mkdtemp(prefix='media-signing-test-', dir=args.receipt.parent))
    with packaged_app(args.app.resolve(), work) as app:
        result = signed_identity(app, args.identity)
        if args.previous_receipt:
            compare_builds(json.loads(args.previous_receipt.read_text()), result)
            result['requirementsUnchangedAcrossBuilds'] = True
        if not args.skip_launch:
            result['launchd'] = launchd_start(app, result['version'], work)
    result['testWork'] = str(work)
    if args.app.suffix.lower() == '.dmg':
        digest = hashlib.sha256()
        with args.app.open('rb') as artifact:
            for chunk in iter(lambda: artifact.read(1 << 20), b''):
                digest.update(chunk)
        result['artifact'] = {'sha256': digest.hexdigest(), 'bytes': args.app.stat().st_size}
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print('Packager signature, certificate-based requirements' + ('' if args.skip_launch else ' and isolated launchd start') + ': PASS')
    if args.retain_dist:
        retain_dist(args.retain_dist, args.packaged_receipt, args.receipt, result,
                    Path.home() / 'Developer/Shared Tools/portfolio/tools/release-dist.py')
        print('Accepted installer retention: PASS')


if __name__ == '__main__':
    main()
