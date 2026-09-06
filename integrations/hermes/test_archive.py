import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.archive import desktop_records, media_path, message_text
from . import archive_tools


class ArchiveTests(unittest.TestCase):
    def test_telegram_entities_and_supplied_media_roundtrip_without_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'voice.ogg').write_bytes(b'OggS\x00\xff')
            document={'id':100,'type':'private_supergroup','name':'Example','messages':[
                {'id':1,'type':'message','date':'2026-09-06T12:00:00','text':['Aws ',{'type':'bold','text':'pass: 123456'},'\r\n😃  '],'file':'voice.ogg','media_type':'voice_message'},
                {'id':2,'type':'service','action':'join_group','actor':'Someone','text':''},
                {'id':3,'type':'message','text':'missing','file':'missing.ogg'},
            ]}
            records=list(desktop_records(document,root,scope='-100123'))
            self.assertEqual(records,list(desktop_records(document,root,scope='-100123')))
            self.assertEqual(records[0][0]['event']['text'],'Aws pass: 123456\r\n😃  ')
            self.assertEqual(records[0][0]['event']['payload']['message'],document['messages'][0])
            self.assertEqual(records[0][1][0][1].read_bytes(),b'OggS\x00\xff')
            self.assertEqual(records[1][0]['event']['payload']['message']['action'],'join_group')
            self.assertEqual(records[2][0]['artifacts'][0]['state'],'failed')
            self.assertEqual(list(desktop_records(document,root))[0][0]['event']['scope'],'desktop:private_supergroup:100')

    def test_import_media_cannot_escape_export_directory_through_paths_or_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'escape').symlink_to('/etc')
            for path in ('../outside','/etc/passwd','escape/passwd'):
                with self.assertRaises(ValueError): media_path(root,path)

    def test_archive_tools_require_bound_scope_and_never_accept_scope_from_model(self):
        with patch('urllib.request.urlopen') as network:
            self.assertIn('error',json.loads(archive_tools.search_tool({'query':'Friday','scope':'private'})))
            network.assert_not_called()
        token=archive_tools.ARCHIVE_CREDENTIAL.set('signed-group-credential')
        try:
            with patch.object(archive_tools,'request',return_value=[]) as request:
                archive_tools.search_tool({'query':'Friday','scope':'private'})
                self.assertNotIn('scope',request.call_args.args[0])
        finally: archive_tools.ARCHIVE_CREDENTIAL.reset(token)


if __name__=='__main__': unittest.main()
