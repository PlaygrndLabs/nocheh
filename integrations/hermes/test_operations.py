import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.operations import sha,validate_snapshot,backup,fingerprints,TABLES


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
            def run(command,**kwargs):
                if 'pg_dump' in command:kwargs['stdout'].write(b'synthetic database dump')
            with patch('scripts.operations.compose',return_value=['fixture']),patch('scripts.operations.environment',return_value={}),\
                 patch('scripts.operations.subprocess.check_output',side_effect=['','fixture-revision']),\
                 patch('scripts.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('scripts.operations.subprocess.run',side_effect=run):
                backup(state,root/'backup')
            manifest=validate_snapshot(root/'backup')
            self.assertEqual(manifest['version'],3)
            self.assertEqual(manifest['files']['admin/jobs/fixture/job.json']['sha256'],sha(job))
            self.assertEqual(manifest['files']['hermes/review-receipt']['sha256'],sha(receipt))
            self.assertIn('memory_review_jobs',manifest['tables'])
            self.assertIn('memory_shares',manifest['tables'])

    def test_restore_fingerprint_table_names_are_allowlisted(self):
        with patch('scripts.operations.subprocess.Popen') as process:
            with self.assertRaises(ValueError):fingerprints([],{},['events; DROP TABLE events'])
            process.assert_not_called()
