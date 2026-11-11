import json
import io
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.archive.archive import desktop_records, desktop_topics, media_path, message_text
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

    def test_search_says_when_history_is_still_importing(self):
        import base64
        claims=base64.urlsafe_b64encode(json.dumps({'scope':'-1001'}).encode()).decode().rstrip('=')
        token=archive_tools.ARCHIVE_CREDENTIAL.set('scope.'+claims+'.signature')
        def answer(path):
            if path=='/v1/imports/pending':return {'imports':pending}
            return [{'id':'nocheh:source:'+'a'*64}]
        try:
            pending=[{'messages':40000,'ready_percent':42}]
            with patch.object(archive_tools,'request',side_effect=answer):
                result=json.loads(archive_tools.search_tool({'query':'Friday'}))
            self.assertEqual(result['import_status'],'Still importing: 42% of 40000 messages ready, so older history may be missing')
            self.assertEqual(len(result['sources']),1)
            pending=[]
            with patch.object(archive_tools,'request',side_effect=answer):
                self.assertNotIn('import_status',json.loads(archive_tools.search_tool({'query':'Friday'})))
            # A failed status check never blocks the search itself.
            with patch.object(archive_tools,'request',side_effect=lambda path:(_ for _ in ()).throw(ValueError('unavailable')) if 'pending' in path else []):
                self.assertEqual(json.loads(archive_tools.search_tool({'query':'Friday'}))['sources'],[])
        finally: archive_tools.ARCHIVE_CREDENTIAL.reset(token)

    def test_a_chat_is_read_page_by_page_and_found_by_meaning_through_the_bound_scope(self):
        page={'chat':'-1001','items':[],'next':None,'position':{'through':0,'total':0},'complete':True}
        def answer(path,body=None):
            if path=='/v1/imports/pending':return {'imports':[{'messages':10,'ready_percent':50}]}
            return page
        with patch.object(archive_tools,'request',side_effect=answer) as request:
            result=json.loads(archive_tools.page_tool({'chat':'-1002','from':'2026-10-01','after':'1-'+'a'*64,'limit':99,'scope':'ignored'}))
        self.assertEqual(request.call_args_list[-1].args,('/v1/archive/page?chat=-1002&from=2026-10-01&after=1-'+'a'*64+'&limit=50',))
        self.assertEqual(result['import_status'],'Still importing: 50% of 10 messages ready, so older history may be missing')
        from urllib.error import HTTPError
        with patch.object(archive_tools,'request',side_effect=HTTPError('url',403,'Forbidden',{},None)):
            self.assertEqual(json.loads(archive_tools.page_tool({'chat':'-1002'})),{'error':'conversation_not_permitted'})
        with patch.object(archive_tools,'request',side_effect=HTTPError('url',400,'Bad Request',{},None)):
            self.assertEqual(json.loads(archive_tools.page_tool({'from':'last week'}))['error'],'invalid_page_request')
        with patch.object(archive_tools,'request',side_effect=ValueError('archive_scope_not_bound')):
            self.assertEqual(json.loads(archive_tools.page_tool({})),{'error':'archive_page_unavailable'})
        with patch.object(archive_tools,'request',return_value={'sources':[],'learned':False}) as request:
            self.assertEqual(json.loads(archive_tools.meaning_tool({'query':'who sends the invoice','limit':50})),{'sources':[],'learned':False})
        request.assert_called_once_with('/v1/memory/honcho/search',{'query':'who sends the invoice','limit':10})
        with patch.object(archive_tools,'request') as request:
            self.assertEqual(json.loads(archive_tools.meaning_tool({'query':' '})),{'error':'memory_search_unavailable'})
            request.assert_not_called()

    def test_background_jobs_are_started_listed_and_stopped_through_the_bound_scope(self):
        with patch.object(archive_tools,'request',return_value={'id':'a'*64,'state':'proposed'}) as request:
            result=json.loads(archive_tools.job_tool({'action':'start','title':'Open tasks','instruction':'Find open tasks.','chat':'-1002','from':'2026-01-01','to':'2026-02-01',
                                                      'scope':'ignored','limit':5,'box':False}))
            archive_tools.job_tool({'action':'status','title':'ignored','box':True})
            archive_tools.job_tool({'action':'stop','id':'b'*64,'box':True})
        self.assertEqual(result['state'],'proposed')
        self.assertEqual([call.args for call in request.call_args_list],[
            ('/v1/jobs/start',{'title':'Open tasks','instruction':'Find open tasks.','chat':'-1002','from':'2026-01-01','to':'2026-02-01','box':False}),
            ('/v1/jobs/status',{'title':'ignored'}),('/v1/jobs/stop',{'id':'b'*64})])
        import io
        from urllib.error import HTTPError
        for code in ('job_limit_reached','job_too_long','job_not_found','job_not_permitted','job_in_a_job'):
            refused=HTTPError('url',409,'Conflict',{},io.BytesIO(json.dumps({'error':code}).encode()))
            with self.subTest(code=code),patch.object(archive_tools,'request',side_effect=refused):
                self.assertEqual(json.loads(archive_tools.job_tool({'action':'start','title':'t','instruction':'i'})),{'error':code})
        private=HTTPError('url',503,'Unavailable',{},io.BytesIO(b'{"error":"private storage detail"}'))
        with patch.object(archive_tools,'request',side_effect=private):
            self.assertEqual(json.loads(archive_tools.job_tool({'action':'status'})),{'error':'background_jobs_unavailable'})
        with patch.object(archive_tools,'request') as request:
            for action in ('delete','size','propose'):
                self.assertEqual(json.loads(archive_tools.job_tool({'action':action,'title':'t','instruction':'i'})),{'error':'background_jobs_unavailable'})
            request.assert_not_called()

    def test_a_repo_is_forwarded_only_with_start_and_a_name(self):
        with patch.object(archive_tools,'request',return_value={'id':'a'*64,'state':'proposed'}) as request,\
                patch.object(archive_tools,'isolated_runtime',return_value=True):
            archive_tools.job_tool({'action':'start','title':'t','instruction':'i','box':True,'repo':'example-org/widgets'})
            for repo in ('',None,7,['example-org/widgets']):
                archive_tools.job_tool({'action':'start','title':'t','instruction':'i','box':True,'repo':repo})
            archive_tools.job_tool({'action':'status','repo':'example-org/widgets'})
            archive_tools.job_tool({'action':'stop','id':'b'*64,'repo':'example-org/widgets'})
        self.assertEqual([call.args for call in request.call_args_list],[
            ('/v1/jobs/start',{'title':'t','instruction':'i','box':True,'repo':'example-org/widgets'}),
            *[('/v1/jobs/start',{'title':'t','instruction':'i','box':True})]*4,('/v1/jobs/status',{}),('/v1/jobs/stop',{'id':'b'*64})])
        import io
        from urllib.error import HTTPError
        refused=HTTPError('url',409,'Conflict',{},io.BytesIO(json.dumps({'error':'job_repo_not_allowed'}).encode()))
        with patch.object(archive_tools,'request',side_effect=refused),patch.object(archive_tools,'isolated_runtime',return_value=True):
            self.assertEqual(json.loads(archive_tools.job_tool({'action':'start','title':'t','instruction':'i','box':True,'repo':'example-org/widgets'})),
                             {'error':'job_repo_not_allowed'})
        tools={}
        class Context:
            def register_tool(self,**kwargs):tools[kwargs['name']]=kwargs['schema']
        archive_tools.register(Context())
        schema=tools['nocheh_background_job'];repo=schema['parameters']['properties']['repo']
        self.assertEqual((repo['type'],repo['maxLength']),('string',140));self.assertTrue(repo['description'].startswith('With start and box=true'))
        self.assertIn('/repo/code',repo['description']);self.assertIn('GitHub copies',schema['description'])
        self.assertNotIn('repo',schema['parameters']['required'])

    def test_a_machine_and_its_plan_are_forwarded_only_with_start_and_only_from_the_isolated_runtime(self):
        steps=['Install the build tools','Build the project','Report the test results']
        with patch.object(archive_tools,'request',return_value={'id':'a'*64,'state':'proposed'}) as request,\
                patch.object(archive_tools,'isolated_runtime',return_value=True):
            archive_tools.job_tool({'action':'start','title':'t','instruction':'i','machine':'build-vm','steps':steps})
            for machine,plan in (('',steps),(None,'Build it'),(7,None),(['build-vm'],{'1':'Build'})):
                archive_tools.job_tool({'action':'start','title':'t','instruction':'i','machine':machine,'steps':plan})
            archive_tools.job_tool({'action':'status','machine':'build-vm','steps':steps})
            archive_tools.job_tool({'action':'stop','id':'b'*64,'machine':'build-vm','steps':steps})
        self.assertEqual([call.args for call in request.call_args_list],[
            ('/v1/jobs/start',{'title':'t','instruction':'i','machine':'build-vm','steps':steps}),
            ('/v1/jobs/start',{'title':'t','instruction':'i','steps':steps}),*[('/v1/jobs/start',{'title':'t','instruction':'i'})]*3,
            ('/v1/jobs/status',{}),('/v1/jobs/stop',{'id':'b'*64})])
        # Its commands reach the machine only through the isolated runtime's broker.
        with patch.object(archive_tools,'request') as request,patch.object(archive_tools,'isolated_runtime',return_value=False):
            self.assertEqual(json.loads(archive_tools.job_tool({'action':'start','title':'t','instruction':'i','machine':'build-vm','steps':steps})),
                             {'error':'isolated_runtime_required'})
            request.assert_not_called()
        import io
        from urllib.error import HTTPError
        for code in ('job_machine_not_allowed','job_machine_not_found','job_card_too_long'):
            refused=HTTPError('url',409,'Conflict',{},io.BytesIO(json.dumps({'error':code}).encode()))
            with self.subTest(code=code),patch.object(archive_tools,'request',side_effect=refused),patch.object(archive_tools,'isolated_runtime',return_value=True):
                answer=json.loads(archive_tools.job_tool({'action':'start','title':'t','instruction':'i','machine':'build-vm','steps':steps}))
                self.assertEqual(answer.pop('error'),code)
                # A machine that is missing or not ready: the owner must add it and pass Test first.
                if code=='job_machine_not_found':
                    note=answer.pop('note')
                    for words in ('Settings › Machines','press Test','until the test passes','action=status'):self.assertIn(words,note)
                self.assertEqual(answer,{})
        tools={}
        class Context:
            def register_tool(self,**kwargs):tools[kwargs['name']]=kwargs['schema']
        archive_tools.register(Context())
        schema=tools['nocheh_background_job'];properties=schema['parameters']['properties']
        machine,plan=properties['machine'],properties['steps']
        self.assertEqual((machine['type'],machine['maxLength']),('string',40))
        self.assertTrue(machine['description'].startswith("For work on one of the owner's machines (see action=status machines): the machine's name and a short plan "
                                                          "of 1-12 steps the owner approves on one card. Only for the owner's own request in their private chat or a project group."))
        self.assertEqual((plan['type'],plan['minItems'],plan['maxItems'],plan['items']),('array',1,12,{'type':'string','maxLength':200}))
        self.assertIn('box or machine with steps',schema['description']);self.assertIn("lists the owner's machines",schema['description'])
        for name in ('machine','steps'):self.assertNotIn(name,schema['parameters']['required'])

    def test_the_job_tool_offers_start_status_and_stop_only(self):
        tools={}
        class Context:
            def register_tool(self,**kwargs):tools[kwargs['name']]=kwargs['schema']
        archive_tools.register(Context())
        schema=tools['nocheh_background_job']
        self.assertEqual(schema['parameters']['properties']['action']['enum'],['start','status','stop'])
        self.assertIn('action=start asks for one',schema['description']);self.assertNotIn('size',schema['description']);self.assertNotIn('propose',schema['description'])
        self.assertTrue(schema['parameters']['properties']['box']['description'].startswith('With start:'))

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
