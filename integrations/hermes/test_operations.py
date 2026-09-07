import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from scripts.operations import sha,validate_snapshot


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
