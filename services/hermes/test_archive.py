import json
import io
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.archive.archive import desktop_records, media_path, message_text
from . import archive_tools


class ArchiveTests(unittest.TestCase):
    def test_current_reaction_discovery_uses_bound_scope_without_text_or_memory_search(self):
        result={'sources':[{'source':'nocheh:event:'+'a'*64,'kind':'captured_reaction','target_sources':['nocheh:event:'+'b'*64]}],'complete':False}
        with patch.object(archive_tools,'request',return_value=result) as request:
            self.assertEqual(json.loads(archive_tools.search_tool({'mode':'current_reactions','scope':'private','query':'ignored','limit':99})),result)
            request.assert_called_once_with('/v1/search?mode=current_reactions&limit=10')
        with patch.object(archive_tools,'request',side_effect=ValueError('audience_context_changed')):
            self.assertEqual(json.loads(archive_tools.search_tool({'mode':'current_reactions'})),{'error':'archive_search_unavailable'})
        with patch.object(archive_tools,'request') as request:
            for args in ({'mode':'unknown'},{'mode':'text'},{'query':'   '}):
                self.assertEqual(json.loads(archive_tools.search_tool(args)),{'error':'archive_search_unavailable'})
            request.assert_not_called()

    def test_slow_context_and_honcho_reads_can_finish_without_extending_normal_archive_reads(self):
        def slow_read(request,timeout):
            if timeout < 30: raise TimeoutError()
            return io.BytesIO(b'{"sources":[{"kind":"memory_inference"}]}')
        token=archive_tools.ARCHIVE_CREDENTIAL.set('signed-synthetic-credential')
        try:
            with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None),patch('urllib.request.urlopen',side_effect=slow_read) as network:
                result=archive_tools.request('/v1/memory/honcho/recall',{'query':'Synthetic recall'})
                self.assertEqual(result['sources'][0]['kind'],'memory_inference')
                self.assertGreater(network.call_args.kwargs['timeout'],600)
                archive_tools.request('/v1/context/prepare',{'text':'Synthetic context'})
                self.assertEqual(network.call_args.kwargs['timeout'],60)
                with self.assertRaises(TimeoutError): archive_tools.request('/v1/search?q=synthetic')
                self.assertEqual(network.call_args.kwargs['timeout'],15)
        finally: archive_tools.ARCHIVE_CREDENTIAL.reset(token)

    def test_foreground_recall_reserves_time_for_the_answer_and_skips_expired_calls(self):
        token=archive_tools.ARCHIVE_CREDENTIAL.set('signed-synthetic-credential')
        try:
            with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None),patch.object(
                    archive_tools,'_PROCESS_DEADLINE',time.time()+100),patch(
                    'urllib.request.urlopen',side_effect=lambda *args,**kwargs:io.BytesIO(b'{"sources":[]}')) as network:
                archive_tools.request('/v1/memory/honcho/recall',{'query':'Synthetic recall'})
                self.assertGreater(network.call_args.kwargs['timeout'],50)
                self.assertLess(network.call_args.kwargs['timeout'],56)
                archive_tools.request('/v1/search?q=synthetic')
                self.assertEqual(network.call_args.kwargs['timeout'],15)
            with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None),patch.object(
                    archive_tools,'_PROCESS_DEADLINE',time.time()+44),patch('urllib.request.urlopen') as network:
                self.assertEqual(json.loads(archive_tools.recall_tool({'query':'Synthetic recall'})),
                                 {'error':'owner_memory_unavailable'})
                network.assert_not_called()
        finally: archive_tools.ARCHIVE_CREDENTIAL.reset(token)

    def test_archive_read_preserves_reaction_removal_and_bounded_current_source_links(self):
        source='a'*64
        record={'source':'nocheh:event:'+source,'event':{'scope':'-1','origin':'live','kind':'telegram_update','text':'',
            'payload':{'message_reaction':{'date':1,'user':{'id':7},'old_reaction':[{'type':'emoji','emoji':'✅'}],'new_reaction':[],
                'chat':{'title':'omitted metadata'},'unrelated':'not evidence'}}},'artifacts':[],'derived':[],
            'current_reactions':{'sources':['nocheh:event:'+'b'*64],'complete':False}}
        with patch.object(archive_tools,'request',return_value=record):
            result=json.loads(archive_tools.read_tool({'id':source}))
        self.assertEqual(result['reaction_observation']['mode'],'individual')
        self.assertEqual(result['reaction_observation']['new_reaction'],[])
        self.assertEqual(result['reaction_observation']['old_reaction'],[{'type':'emoji','emoji':'✅'}])
        self.assertEqual(result['current_reactions'],record['current_reactions'])
        self.assertNotIn('omitted metadata',json.dumps(result))
        self.assertNotIn('not evidence',json.dumps(result))
        record['event']['payload']={'message_reaction_count':{'date':2,'reactions':[{'type':{'type':'emoji','emoji':'👍'},'total_count':2}]}}
        with patch.object(archive_tools,'request',return_value=record):
            aggregate=json.loads(archive_tools.read_tool({'id':source}))['reaction_observation']
        self.assertEqual(aggregate['mode'],'aggregate')
        self.assertEqual(aggregate['reactions'][0]['total_count'],2)
        self.assertNotIn('user',aggregate)
        record['event']['payload']['message_reaction_count']['reactions']=['x'*7000]
        with patch.object(archive_tools,'request',return_value=record):
            bounded=json.loads(archive_tools.read_tool({'id':source}))['reaction_observation']
        self.assertEqual(bounded,{'mode':'aggregate','unavailable':'observation_size_limit'})
        with patch.object(archive_tools,'request',side_effect=ValueError('source_not_found')):
            self.assertEqual(json.loads(archive_tools.read_tool({'id':source})),{'error':'archive_source_unavailable'})

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
