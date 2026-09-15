import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from scripts.operations import sha,validate_snapshot,backup,restore,fingerprints,TABLES


class SnapshotTests(unittest.TestCase):
    def snapshot(self,root,name='state/files/example',kind=None):
        raw=b'unchanged Aws \xf0\x9f\x98\x83\r\n  '
        (root/'archive.dump').write_bytes(b'synthetic dump')
        original=root/'original';original.write_bytes(raw)
        with tarfile.open(root/'state.tar.gz','w:gz') as tar:
            info=tarfile.TarInfo(name);info.size=len(raw)
            if kind: info.type=kind;info.linkname='/outside';info.size=0
            tar.addfile(info,io.BytesIO(raw) if not kind else None)
        manifest={'version':1,'dump_sha256':sha(root/'archive.dump'),'state_sha256':sha(root/'state.tar.gz'),
                  'files':{'files/example':{'sha256':sha(original),'size':len(raw)}}}
        (root/'manifest.json').write_text(json.dumps(manifest));return manifest

    def test_exact_snapshot_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.snapshot(root)
            self.assertEqual(validate_snapshot(root),manifest)
            (root/'archive.dump').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError,'checksum'): validate_snapshot(root)

    def test_reject_traversal_and_links_even_with_matching_container_hash(self):
        for name,kind in [('state/../../outside',None),('state/files/example',tarfile.SYMTYPE),('/state/files/example',None)]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.snapshot(root,name,kind)
                with self.assertRaisesRegex(ValueError,'Unsafe'): validate_snapshot(root)

    def test_reject_missing_manifest_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.snapshot(root)
            manifest['files']['files/missing']={'sha256':'0'*64,'size':0}
            (root/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'Incomplete'): validate_snapshot(root)

    def test_backup_preserves_import_approval_and_native_review_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state';state.mkdir();(state/'.env').write_text('TELEGRAM_ENABLED=false\n')
            for name in ('files','spool','hermes','admin/jobs/fixture'):(state/name).mkdir(parents=True,exist_ok=True)
            job=state/'admin/jobs/fixture/job.json';job.write_text('{"review_approved":true,"state":"cancelled"}')
            receipt=state/'hermes/review-receipt';receipt.write_text('ambiguous')
            cache=state/'hermes/profiles/fixture/.cache/uv';cache.mkdir(parents=True)
            (cache/'wheel-link').symlink_to('/not-read-by-backup')
            def run(command,**kwargs):
                if 'pg_dump' in command:kwargs['stdout'].write(b'synthetic database dump')
            with patch('scripts.operations.compose',return_value=['fixture']),patch('scripts.operations.environment',return_value={}),\
                 patch('scripts.operations.subprocess.check_output',side_effect=['','fixture-revision']),\
                 patch('scripts.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('scripts.operations.subprocess.run',side_effect=run),\
                 patch('scripts.workflow_worker.running',return_value=True),\
                 patch('scripts.workflow_worker.stop') as stop_host,patch('scripts.workflow_worker.start') as start_host:
                backup(state,root/'backup')
                stop_host.assert_called_once_with(state,wait=True);start_host.assert_called_once_with(state)
            manifest=validate_snapshot(root/'backup')
            self.assertEqual(manifest['version'],3)
            self.assertEqual(manifest['files']['admin/jobs/fixture/job.json']['sha256'],sha(job))
            self.assertEqual(manifest['files']['hermes/review-receipt']['sha256'],sha(receipt))
            self.assertIn('memory_review_jobs',manifest['tables'])
            self.assertIn('memory_shares',manifest['tables'])
            self.assertIn('honcho_context_cache',manifest['tables'])
            self.assertEqual(manifest['excluded_rebuildable_caches'],['hermes/profiles/fixture/.cache/uv'])
            self.assertFalse(any('.cache/uv' in name for name in manifest['files']))
            (state/'hermes/unknown-link').symlink_to('/not-read-by-backup')
            with patch('scripts.operations.compose',return_value=['fixture']),patch('scripts.operations.environment',return_value={}),\
                 patch('scripts.operations.subprocess.check_output',side_effect=['','fixture-revision']),\
                 patch('scripts.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('scripts.operations.subprocess.run',side_effect=run):
                with self.assertRaisesRegex(ValueError,'Unsupported state symlink'):backup(state,root/'rejected-backup')

    def test_restore_fingerprint_table_names_are_allowlisted(self):
        with patch('scripts.operations.subprocess.Popen') as process:
            with self.assertRaises(ValueError):fingerprints([],{},['events; DROP TABLE events'])
            process.assert_not_called()

    def test_restore_holds_all_executors_before_starting_services(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);snapshot=root/'snapshot';snapshot.mkdir();state=root/'restored'
            (snapshot/'archive.dump').write_bytes(b'dump')
            with tarfile.open(snapshot/'state.tar.gz','w:gz') as tar:
                raw=b'{"synthetic":"login"}';info=tarfile.TarInfo('state/hermes/auth.json');info.size=len(raw)
                tar.addfile(info,io.BytesIO(raw))
                provider=b'{"type":"codex","access_token":"shared"}';info=tarfile.TarInfo('state/provider/auth/codex.json');info.size=len(provider)
                tar.addfile(info,io.BytesIO(provider))
            manifest={'version':1,'tables':{'events':'exact-hash'},'files':{'hermes/auth.json':{},'provider/auth/codex.json':{}}}
            starts=[]
            def run(command,**kwargs):
                if command[:3]==['docker','volume','inspect']:return SimpleNamespace(returncode=1)
                if 'up' in command:
                    starts.append(command)
                    for name in ('spool/.restore-inactive','workflows/inactive','hermes/scheduler-inactive','admin/tools/inactive','hermes/auth.restore-pending.json','provider/auth.restore-pending/codex.json'):
                        self.assertTrue((state/name).is_file(),name)
                    self.assertFalse((state/'hermes/auth.json').exists())
                    self.assertFalse(any((state/'provider/auth').glob('*.json')))
                    self.assertIn("TELEGRAM_ENABLED='false'",(state/'.env').read_text())
                    self.assertIn("NOCHEH_WORKFLOWS_ENABLED='false'",(state/'.env').read_text())
                return SimpleNamespace(returncode=0)
            with patch('scripts.operations.validate_snapshot',return_value=manifest),\
                 patch('scripts.operations.initialize',return_value={'TELEGRAM_ENABLED':'true'}),\
                 patch('scripts.operations.compose',return_value=['fixture']),\
                 patch('scripts.operations.environment',return_value={}),\
                 patch('scripts.operations.fingerprints',return_value=manifest['tables']),\
                 patch('scripts.operations.subprocess.run',side_effect=run):
                result=restore(snapshot,state,'nocheh-test-restore',18980)
            self.assertEqual(len(starts),2);self.assertFalse(result['executors_active'])
            self.assertFalse(result['telegram_enabled']);self.assertFalse(result['subscription_login_activated'])
