import contextlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from scripts.import_job import inspect, run


class FakeArchive:
    def __init__(self): self.records = {}; self.files = {}; self.fail = False; self.reviews=[]
    def call(self, path, body):
        if path == '/v1/memory/reviews': self.reviews.extend(body['event_ids']);return {}
        if path == '/v1/import':
            key = body['event']['key']
            duplicate = key in self.records
            self.records[key] = body
            return {'duplicate': duplicate}
        if self.fail:
            self.fail = False
            raise RuntimeError('simulated_disconnect')
        self.files[path] = body
        return {}


class ImportJobTests(unittest.TestCase):
    def prepare(self, folder):
        root=Path(folder); upload=root/'upload'; upload.mkdir()
        document={'id':42,'type':'private_group','name':'Fixture', 'messages':[
            {'id':1,'type':'message','text':'Original  متن\r\n  ','file':'photo.bin'},
            {'id':2,'type':'message','text':'Second','file':'not supplied'}]}
        original=json.dumps(document,ensure_ascii=False,indent=2).encode()
        (upload/'result.json').write_bytes(original); (upload/'photo.bin').write_bytes(b'\x00\xffphoto')
        preview=inspect(root); (root/'job.json').write_text(json.dumps({'preview':preview}))
        return root,original

    def test_preview_missing_files_retry_and_exact_original_export(self):
        with tempfile.TemporaryDirectory() as folder:
            root,original=self.prepare(folder); preview=inspect(root)
            self.assertEqual(preview['missing_files'],1)
            self.assertEqual(preview['supplied_files'],1)
            self.assertEqual(preview['chats'][0]['scope'],'desktop:private_group:42')
            api=FakeArchive();api.fail=True
            with self.assertRaises(RuntimeError): run(root,{},api=api)
            with contextlib.redirect_stdout(io.StringIO()): result=run(root,{},api=api)
            self.assertEqual(result['telegram_replies'],0)
            self.assertEqual(len(api.records),3)  # Batch manifest + two originals.
            with contextlib.redirect_stdout(io.StringIO()): result=run(root,{},api=api)
            self.assertEqual(result['duplicates'],2)
            import base64
            self.assertIn(original,[base64.b64decode(v['bytes_base64']) for v in api.files.values()])
            texts=[r['event']['text'] for r in api.records.values()]
            self.assertIn('Original  متن\r\n  ',texts)

    def test_zip_paths_symlinks_and_duplicate_members_are_rejected(self):
        for name,symlink in [('../escape.json',False),('/absolute.json',False),('symlink',True)]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);(root/'upload').mkdir()
                with zipfile.ZipFile(root/'upload/export.zip','w') as archive:
                    member=zipfile.ZipInfo(name)
                    if symlink:member.external_attr=0o120777<<16
                    archive.writestr(member,'{}')
                with self.assertRaises(ValueError):inspect(root)

    def test_export_edit_after_preview_is_rejected_before_archive_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            root,_=self.prepare(folder);(root/'upload/result.json').write_text('{}')
            api=FakeArchive()
            with self.assertRaisesRegex(ValueError,'integrity'):run(root,{},api=api)
            self.assertFalse(api.records)

    def test_bounded_batches_resume_same_sources_and_learning_waits_for_all_bytes(self):
        with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):
            root,_=self.prepare(folder);metadata=json.loads((root/'job.json').read_text())
            metadata['review_approved']=True;(root/'job.json').write_text(json.dumps(metadata))
            api=FakeArchive()
            first=run(root,{},api=api,limit=1)
            self.assertEqual(first['completed'],1);self.assertFalse(first['complete']);self.assertEqual(api.reviews,[])
            # A lost checkpoint can replay capture; its source identities do not change.
            replay=run(root,{},api=api,limit=1)
            self.assertEqual(replay['duplicates'],1);self.assertEqual(len(api.records),2)
            second=run(root,{},after=1,api=api,limit=1,duplicates=replay['duplicates'])
            self.assertEqual(second['completed'],2);self.assertEqual(second['learning_after'],1);self.assertFalse(second['complete'])
            final=run(root,{},after=2,api=api,limit=1,duplicates=second['duplicates'],learning_after=1)
            self.assertTrue(final['complete']);self.assertEqual(final['telegram_replies'],0)
            self.assertEqual(len(set(api.reviews)),2);self.assertEqual(len(api.records),3)
            for kwargs in ({'limit':101},{'after':3},{'learning_after':-1},{'duplicates':-1}):
                clean=FakeArchive()
                with self.assertRaises(ValueError):run(root,{},api=clean,**kwargs)
                self.assertFalse(clean.records)
