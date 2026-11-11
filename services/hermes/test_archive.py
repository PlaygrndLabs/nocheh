import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.archive.archive import desktop_records, desktop_topics, media_path, message_text
from . import archive_tools


class ArchiveTests(unittest.TestCase):
    def test_slow_context_reads_can_finish_without_extending_normal_archive_reads(self):
        def slow_read(request,timeout):
            if timeout < 30: raise TimeoutError()
            return io.BytesIO(b'{"text":"Synthetic context"}')
        token=archive_tools.ARCHIVE_CREDENTIAL.set('signed-synthetic-credential')
        try:
            with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None),patch('urllib.request.urlopen',side_effect=slow_read) as network:
                self.assertEqual(archive_tools.request('/v1/context/prepare',{'text':'Synthetic context'}),{'text':'Synthetic context'})
                self.assertEqual(network.call_args.kwargs['timeout'],60)
                with self.assertRaises(TimeoutError): archive_tools.request('/v1/search?q=synthetic')
                self.assertEqual(network.call_args.kwargs['timeout'],15)
        finally: archive_tools.ARCHIVE_CREDENTIAL.reset(token)

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

    def test_forum_topics_follow_reply_chains_to_their_topic_created_message(self):
        messages=[
            {'id':1,'type':'service','action':'migrate_from_group'},
            {'id':3,'type':'service','action':'topic_created','title':'tests'},
            {'id':4,'type':'message','text':'in tests','reply_to_message_id':3},
            {'id':5,'type':'message','text':'General has no reply link'},
            {'id':6,'type':'message','text':'reply in General','reply_to_message_id':5},
            {'id':7,'type':'message','text':'reply in tests','reply_to_message_id':4},
            {'id':8,'type':'message','text':'target outside the export','reply_to_message_id':2},
            {'id':9,'type':'message','text':'loop','reply_to_message_id':10},
            {'id':10,'type':'message','text':'loop','reply_to_message_id':9},
            {'id':11,'type':'message','text':'odd link','reply_to_message_id':[3]},
        ]
        self.assertEqual(desktop_topics(messages),{3:3,4:3,7:3})
        self.assertEqual(desktop_topics([m for m in messages if m['id']!=3]),{},'no topics without a topic_created message')
        document={'id':100,'type':'private_supergroup','name':'Forum','messages':messages}
        records=[record['event'] for record,_ in desktop_records(document,Path('.'),scope='-100100')]
        self.assertEqual([event['payload'].get('topic_id') for event in records],[None,3,3,None,None,3,None,None,None,None])
        self.assertEqual(records[2]['payload']['message'],messages[2],'the exported message itself is unchanged')

    def test_import_media_cannot_escape_export_directory_through_paths_or_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'escape').symlink_to('/etc')
            for path in ('../outside','/etc/passwd','escape/passwd'):
                with self.assertRaises(ValueError): media_path(root,path)

    def test_archive_requests_require_a_bound_scope(self):
        with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None),patch('urllib.request.urlopen') as network:
            with self.assertRaisesRegex(RuntimeError,'archive_scope_not_bound'):archive_tools.request('/v1/memory/longterm/context',{})
            network.assert_not_called()


if __name__=='__main__': unittest.main()
