"""Focused release-hook tests; all apps, DMGs and acceptance results are synthetic."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = Path.home() / 'Developer/Shared Tools/portfolio/tools/release-dist.py'
spec = importlib.util.spec_from_file_location('signing', ROOT / 'scripts/verify-macos-signing.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class InstalledRetention(unittest.TestCase):
    def setUp(self):
        # The shared helper validates a pin's retirement_trash with `realpath == path`, so the fixture
        # cannot live under $TMPDIR (/var/folders resolves to /private/var). It sits in the user's cache.
        self.work = Path.home() / 'Library' / 'Caches' / f'business-retention-{uuid.uuid4().hex[:12]}'
        self.work.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.work, True)
        self.project = self.work / 'project'
        self.project.mkdir()
        self.trash = self.work / 'Desktop' / '_trash' / 'business-studio-kh'
        self.trash.mkdir(parents=True)
        self.installed = self.work / 'installed.json'
        self.packaged = self.work / 'packaged.json'
        self.pins = self.work / 'pins.json'
        self.result = {'version': '0.1.104', 'requirements': {'.': 'synthetic requirement'},
                       'hashes': {'main': 'synthetic executable', 'asar': 'synthetic payload'}}
        self.health = {'started': True, 'health': True, 'version': '0.1.104',
                       'survivedStartup': True, 'bootedOut': True}
        releases = []
        for version in ('0.1.102', '0.1.103', '0.1.104'):
            source = self.work / ('Media-' + version + '.dmg')
            source.write_bytes(('synthetic installer ' + version).encode())
            evidence = self.work / (version + '-installed.json')
            evidence.write_text('{}')
            releases.append({'version': version, 'source': str(source),
                             'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                             'bytes': source.stat().st_size, 'evidence': str(evidence)})
        self.current = releases[-1]
        self.current['evidence'] = str(self.installed)
        self.document = {'schema': 1, 'apps': [{'app': signing.APP_NAME,
                         'project': str(self.project), 'retirement_trash': str(self.trash),
                         'releases': releases[:2]}]}
        self.pins.write_text(json.dumps(self.document))
        subprocess.run(['python3', '-I', str(HELPER), str(self.pins)], check=True, capture_output=True)
        self.document['apps'][0]['releases'] = releases[1:]
        self.pins.write_text(json.dumps(self.document))
        package = copy.deepcopy(self.result)
        package['artifact'] = {k: self.current[k] for k in ('sha256', 'bytes')}
        self.packaged.write_text(json.dumps(package))
        self.before = self.snapshot()

    def snapshot(self):
        return {p.relative_to(self.project).as_posix(): p.read_bytes()
                for p in self.project.rglob('*') if p.is_file()}

    def run_acceptance(self, app='/Applications/Business Studio KH.app', extra=(), launch_failure=False):
        args = ['verify', app, '--receipt', str(self.installed),
                '--retain-dist', str(self.pins), '--packaged-receipt', str(self.packaged), *extra]
        with patch.object(sys, 'argv', args), \
             patch.object(signing, 'packaged_app') as mounted, \
             patch.object(signing, 'signed_identity', return_value=copy.deepcopy(self.result)), \
             patch.object(signing, 'launchd_start', return_value=self.health) as launch:
            mounted.return_value.__enter__.return_value = Path(app)
            if launch_failure:
                launch.side_effect = RuntimeError('synthetic launch failure')
            signing.main()

    def test_success_runs_helper_only_after_installed_receipt(self):
        self.run_acceptance()
        self.assertEqual(json.loads(self.installed.read_text())['launchd'], self.health)
        dist = self.project / 'dist'
        self.assertEqual(sorted(p.name for p in dist.glob('*.dmg')),
                         ['Business Studio KH-0.1.103.dmg', 'Business Studio KH-0.1.104.dmg'])
        self.assertTrue((self.trash / 'dist' / 'Business Studio KH-0.1.102.dmg').is_file(),
                        'the retired DMG must land in the pinned Desktop trash')
        self.assertFalse((self.project / '_trash').exists(),
                         'owner 2026-11-18: no _trash inside a checkout')
        self.assertTrue(Path(self.current['source']).is_file(), 'shared helper must preserve source')

    def test_checkout_without_a_pin_is_refused_not_written_locally(self):
        # The class this guards: an unpinned retire used to CREATE `<project>/_trash` inside a checkout.
        (self.project / '.git').mkdir()
        del self.document['apps'][0]['retirement_trash']
        self.pins.write_text(json.dumps(self.document))
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_acceptance()
        # The helper records the newly accepted release before it reaches the retirement step, so the tree
        # is not byte-identical afterwards; the claim this test makes is the one that matters. Two setup
        # runs are pinned (0.1.103 + 0.1.104) over a dist that already holds 0.1.102 from setUp, so this
        # refusal comes from the retirement step and not from pin validation — assert both halves of that.
        self.assertTrue((self.project / 'dist' / 'Business Studio KH-0.1.104.dmg').is_file(),
                        'the copy step ran, so the refusal came from the retirement step')
        self.assertTrue((self.project / 'dist' / 'Business Studio KH-0.1.102.dmg').is_file(),
                        'a refusal is not a rollback: the obsolete DMG stays where it was')
        self.assertFalse((self.project / '_trash').exists(),
                         'a refused retire must not create a _trash inside the checkout')

    def test_failed_launch_preserves_pair_and_receipt(self):
        self.installed.write_text('prior installed evidence')
        with self.assertRaisesRegex(RuntimeError, 'launch failure'):
            self.run_acceptance(launch_failure=True)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.installed.read_text(), 'prior installed evidence')

    def test_package_payload_mismatch_preserves_pair(self):
        self.result['hashes']['asar'] = 'wrong payload'
        with self.assertRaisesRegex(ValueError, 'differs from the packaged receipt'):
            self.run_acceptance()
        self.assertEqual(self.snapshot(), self.before)

    def test_pin_dmg_mismatch_preserves_pair(self):
        self.current['sha256'] = '0' * 64
        self.pins.write_text(json.dumps(self.document))
        with self.assertRaisesRegex(ValueError, 'differs from the verified DMG'):
            self.run_acceptance()
        self.assertEqual(self.snapshot(), self.before)

    def test_missing_previous_acceptance_preserves_pair(self):
        self.document['apps'][0]['releases'][0]['evidence'] = str(self.work / 'missing.json')
        self.pins.write_text(json.dumps(self.document))
        with self.assertRaisesRegex(ValueError, 'acceptance evidence is missing'):
            self.run_acceptance()
        self.assertEqual(self.snapshot(), self.before)

    def test_changed_source_refused_by_shared_helper_preserves_pair(self):
        Path(self.current['source']).write_bytes(b'changed after packaging')
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_acceptance()
        self.assertEqual(self.snapshot(), self.before)

    def test_shared_trash_symlink_refusal_preserves_rollback(self):
        outside = self.work / 'shared-trash'
        outside.mkdir()
        (self.project / '_trash').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_acceptance()
        for version in ('0.1.102', '0.1.103'):
            self.assertEqual((self.project / 'dist' / ('Business Studio KH-' + version + '.dmg')).read_bytes(),
                             self.before['dist/Business Studio KH-' + version + '.dmg'])
        self.assertEqual(list(outside.iterdir()), [])

    def test_packaged_app_and_skip_launch_cannot_trigger_retention(self):
        for app, extra in ((str(self.work / 'candidate.app'), ()),
                           ('/Applications/Business Studio KH.app', ('--skip-launch',))):
            with self.assertRaises(SystemExit):
                self.run_acceptance(app, extra)
            self.assertEqual(self.snapshot(), self.before)

    def test_packaged_receipt_binds_dmg_hash_and_bytes(self):
        source = Path(self.current['source'])
        args = ['verify', str(source), '--receipt', str(self.packaged)]
        with patch.object(sys, 'argv', args), \
             patch.object(signing, 'packaged_app') as mounted, \
             patch.object(signing, 'signed_identity', return_value=copy.deepcopy(self.result)), \
             patch.object(signing, 'launchd_start', return_value=self.health):
            mounted.return_value.__enter__.return_value = self.work / 'packaged.app'
            signing.main()
        self.assertEqual(json.loads(self.packaged.read_text())['artifact'],
                         {k: self.current[k] for k in ('sha256', 'bytes')})
        self.assertEqual(self.snapshot(), self.before)

    def test_build_does_not_prune(self):
        build = (ROOT / 'scripts/build-updater-dmg.sh').read_text()
        self.assertNotIn('npm run dmgs:prune', build)
        self.assertNotIn('release-dist.py', build)


if __name__ == '__main__':
    unittest.main()
