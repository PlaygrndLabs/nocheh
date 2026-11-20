import tempfile
import unittest
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .native_memory import recall, native_review
from .scopes import Scopes


class NativeMemoryTests(unittest.TestCase):
    def test_recall_requires_matching_installation_and_guard_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,generation,epoch in [('current','new',4),('old-installation','old',4),('old-guard','new',3)]:
                profile=root/'profiles'/Scopes.profile(name);(profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('Juniper '+name)
                (profile/'space.json').write_text(json.dumps({'generation':generation,'guard_epoch':epoch}))
            result=recall(root,{'query':'Juniper','generation':'new','guard_epoch':4})
            self.assertEqual([hit['text'] for hit in result['hits']],['Juniper current'])

    def test_owner_recalls_actual_native_notes_and_sessions_without_writes(self):
        from hermes_state import SessionDB
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for scope in ('123','-20'):
                profile=root/'profiles'/Scopes.profile(scope)
                (profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('Juniper launch Friday. nocheh:event:'+'a'*64)
                db=SessionDB(profile/'state.db');db.create_session('session-'+scope,source='telegram')
                db.append_message('session-'+scope,role='user',content='Juniper needs the checklist.');db.close()
            nothing_retired=lambda ids:{'revision':'0:','retired':[],'answered':[]}
            result=recall(root,{'query':'Juniper','limit':20},retirements=nothing_retired)
            self.assertEqual(len(result['hits']),4)
            self.assertEqual({h['kind'] for h in result['hits']},{'native_note','native_session'})
            with self.assertRaises(ValueError):recall(root,{'query':'Juniper','profile':'../../secret'})

    def test_each_recalled_hit_says_whose_profile_it_is_in(self):
        # Nocheh turns these into the label of the chat a hit came from (ADR-0251). A private answer's profile names the
        # owner's private chat but is never the owner's (ADR-0249), with or without the receipt of where it was asked.
        from hermes_state import SessionDB
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            profiles={'owner':{'space':'123','owner':True},'group':{'space':'-20/topic/4','owner':False},
                       'answer':{'space':'123','owner':False,'answer':'a'*32},'answer-old':{'space':'123','owner':False,'answer':'b'*32}}
            for name,metadata in profiles.items():
                profile=root/'profiles'/Scopes.profile(name);(profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('Juniper note in '+name)
                (profile/'space.json').write_text(json.dumps({**metadata,'generation':'new','guard_epoch':4}))
                db=SessionDB(profile/'state.db');db.create_session('session-'+name,source='telegram')
                db.append_message('session-'+name,role='user',content='Juniper talk in '+name);db.close()
            (root/'profiles'/Scopes.profile('answer')/'answer.json').write_text(json.dumps({'group':'“Synthetic Forum”','at':'2026-01-02T03:04:05+00:00'}))
            nothing_retired=lambda ids:{'revision':'0:','retired':[],'answered':[]}
            result=recall(root,{'query':'Juniper','limit':20,'generation':'new','guard_epoch':4},retirements=nothing_retired)
            where={}
            for hit in result['hits']:
                where.setdefault(hit['profile'],set()).add(json.dumps({key:hit.get(key) for key in ('space','owner','answer','answer_group')},sort_keys=True))
            expected={'owner':{'space':'123','owner':True,'answer':False,'answer_group':None},
                      'group':{'space':'-20/topic/4','owner':False,'answer':False,'answer_group':None},
                      'answer':{'space':'123','owner':False,'answer':True,'answer_group':'“Synthetic Forum”'},
                      'answer-old':{'space':'123','owner':False,'answer':True,'answer_group':None}}
            self.assertEqual(where,{Scopes.profile(name):{json.dumps(value,sort_keys=True)} for name,value in expected.items()},
                             'every note and session hit of a profile says the same')
            self.assertEqual(len(result['hits']),8)
            self.assertNotIn('answer_at',json.dumps(result))

    def test_recall_without_space_metadata_names_no_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,marker in (('plain',False),('named',True)):
                profile=root/'profiles'/(name if marker else Scopes.profile(name));(profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('Juniper '+name)
                if marker:(profile/'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
            nothing_retired=lambda ids:{'revision':'0:','retired':[],'answered':[]}
            hits={hit['text']:hit for hit in recall(root,{'query':'Juniper'},retirements=nothing_retired)['hits']}
            self.assertEqual((hits['Juniper plain']['space'],hits['Juniper plain']['owner'],hits['Juniper plain']['answer']),(None,False,False))
            self.assertEqual((hits['Juniper named']['owner'],hits['Juniper named']['answer']),(True,False),'an owner-named profile is the owner\'s')

    def test_each_recalled_note_line_carries_its_whole_notes_record_and_each_row_its_writer(self):
        # A hit is one line, but its source is the note it is in (ADR-0257): found by walking the file note by note.
        from hermes_state import SessionDB
        from . import note_sources
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=root/'profiles'/Scopes.profile('family');(profile/'memories').mkdir(parents=True)
            first='Trip planning:\nJuniper cabin booked for May.\nnocheh:event:'+'c'*64
            (profile/'memories/MEMORY.md').write_text('\ufeff'+first+'\n§\nJuniper is Alice\'s dog.')
            (profile/'space.json').write_text(json.dumps({'space':'chat-family','owner':False}))
            origin={'by':'review','review':'a'*64}
            note_sources.save(profile,{note_sources.key('memory',first):{'origins':[origin],'more':0,'at':'2026-11-08'}})
            db=SessionDB(profile/'state.db');db.create_session('s',source='telegram')
            db.append_message('s',role='user',content='Juniper walk at noon?');db.append_message('s',role='assistant',content='Juniper walk is set.');db.close()
            nothing_retired=lambda ids:{'revision':'0:','retired':[],'answered':[]}
            hits=recall(root,{'query':'Juniper','limit':20},retirements=nothing_retired)['hits']
            notes={hit['text']:hit['note'] for hit in hits if hit['kind']=='native_note'}
            self.assertEqual(notes['Juniper cabin booked for May.'],{'key':note_sources.key('memory',first),'origins':[origin],'more':0,'cites':['c'*64]})
            self.assertEqual(notes["Juniper is Alice's dog."],{'key':note_sources.key('memory',"Juniper is Alice's dog."),'origins':[{'by':'unknown'}],'more':0,'cites':[]})
            rows=[hit for hit in hits if hit['kind']=='native_session']
            self.assertTrue(rows);self.assertTrue(all(hit['role'] in ('user','assistant') for hit in rows))

    def test_owner_recall_session_hits_carry_their_own_text_and_time_never_a_neighbours(self):
        # Hermes's search drops a hit's content and, unless its fields leave it out, adds the rows before and after it,
        # without their ids (`context`). A stale profile's next turn withholds those neighbours here (a retired turn
        # message, and a turn quoting a retired recent message); recall reads the hit's own snippet and time instead.
        from hermes_state import SessionDB
        from .retired_history import withheld_ids
        retired,quoted,source='a'*64,'b'*64,'c'*64
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=root/'profiles'/Scopes.profile('123');(profile/'memories').mkdir(parents=True)
            db=SessionDB(profile/'state.db');db.create_session('s',source='telegram')
            db.append_message('s',role='user',content='Bob PIN is 4321, keep it.\n\n[Archive source: nocheh:event:'+retired+']')
            db.append_message('s',role='assistant',content='Juniper walk is set for noon, as nocheh:event:'+source+' says.')
            db.append_message('s',role='user',content='[Recent messages in this group that were not addressed to you, oldest first]\n\n'
                              '[Group message from Bob] (source nocheh:event:'+quoted+')\nvault code 9876\n\n[End of recent messages]\n\nok'
                              '\n\n[Archive source: nocheh:event:'+'d'*64+']')
            db.close()
            lookup=lambda ids:{'revision':'1:','retired':[i for i in ids if i in (retired,quoted)],'answered':{}}
            self.assertEqual(withheld_ids(profile/'state.db',lookup),{1,3},'both neighbours are withheld rows')
            asked=[]
            original=SessionDB.search_messages
            def search(db,*args,**kwargs):
                asked.append(kwargs.get('fields'));return original(db,*args,**kwargs)
            with patch.object(SessionDB,'search_messages',search):
                hits=recall(root,{'query':'Juniper','limit':20},retirements=lookup)['hits']
            rows=[hit for hit in hits if hit['kind']=='native_session']
            self.assertEqual(len(rows),1)
            self.assertIn('Juniper walk',rows[0]['text'],'the hit reads its own row')
            self.assertLessEqual(len(rows[0]['text']),120)
            self.assertRegex(rows[0]['at'],r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$')
            self.assertEqual(rows[0]['citations'],['nocheh:event:'+source])
            self.assertEqual(rows[0]['role'],'assistant')
            self.assertTrue(asked and all(fields is not None and 'context' not in fields for fields in asked),'neighbours are never asked for')
            for secret in ('4321','9876',retired,quoted):self.assertNotIn(secret,json.dumps(hits))

    def test_a_review_reports_the_memory_operations_its_forks_asked_for(self):
        # So its parent can tell which notes a new note replaced; without every fork's messages it reports none.
        from agent import background_review as native
        call={'id':'c','type':'function','function':{'name':'memory','arguments':json.dumps({'action':'replace','target':'user','old_text':'old','content':'new'})}}
        def spawn(parent,messages,**options):
            def target():
                fork,_,_=native.build_cache_parity_fork(parent);fork.run_conversation('review')
            return target,'native prompt'
        for result,expected in (({'completed':True,'messages':[{'role':'assistant','tool_calls':[call]},{'role':'tool','content':'ok'}]},
                                  {'state':'done','memory_ops':[{'action':'replace','target':'user','old_text':'old','content':'new'}]}),
                                 ({'completed':True},{'state':'done'})):
            fork=SimpleNamespace(valid_tool_names={'memory'},run_conversation=lambda *_,value=result:value)
            with patch.object(native,'build_cache_parity_fork',return_value=(fork,None,False)),patch.object(native,'spawn_background_review_thread',side_effect=spawn):
                self.assertEqual(native_review(object(),'source'),expected)

    def test_native_review_waits_for_actual_completion_and_denies_extra_tools(self):
        from agent import background_review as native
        original=native.build_cache_parity_fork
        def spawn(parent,messages,**options):
            self.assertTrue(options['review_memory']);self.assertFalse(options['review_skills'])
            self.assertIn('Archived evidence',messages[0]['content'])
            def target():
                fork,_,_=native.build_cache_parity_fork(parent)
                fork.run_conversation('review')
            return target,'native prompt'
        for result in ({'completed':True},{'completed':False,'failed':True}):
            fork=SimpleNamespace(valid_tool_names={'memory'},run_conversation=lambda *_:result)
            with patch.object(native,'build_cache_parity_fork',return_value=(fork,None,False)),patch.object(native,'spawn_background_review_thread',side_effect=spawn):
                if result['completed']:self.assertEqual(native_review(object(),'source'),{'state':'done'})
                else:
                    with self.assertRaises(RuntimeError):native_review(object(),'source')
        self.assertIs(native.build_cache_parity_fork,original)
        fork=SimpleNamespace(valid_tool_names={'memory','terminal'})
        with patch.object(native,'build_cache_parity_fork',return_value=(fork,None,False)),patch.object(native,'spawn_background_review_thread',side_effect=spawn):
            with self.assertRaises(RuntimeError):native_review(object(),'source')


class ReviewBudgetTests(unittest.TestCase):
    def test_a_review_budget_counts_cached_prompt_tokens_too(self):
        # Hermes counts uncached input only; prompt caching keeps that near zero, so a review
        # would run past Nocheh's budget. Every prompt token counts, as before caching.
        from agent import background_review as native, conversation_loop as loop
        original=loop._review_input_budget_exhausted;seen=[]
        def spawn(parent,messages,**options):
            def target():
                fork,_,_=native.build_cache_parity_fork(parent)
                for used in ((2000,0,0),(500,18000,3000),(100,23500,500)):
                    fork.session_input_tokens,fork.session_cache_read_tokens,fork.session_cache_write_tokens=used
                    seen.append(loop._review_input_budget_exhausted(fork))
                fork.run_conversation('review')
            return target,'native prompt'
        fork=SimpleNamespace(valid_tool_names={'memory'},run_conversation=lambda *_:{'completed':True},_review_input_token_budget=24000)
        with patch.object(native,'build_cache_parity_fork',return_value=(fork,None,False)),patch.object(native,'spawn_background_review_thread',side_effect=spawn):
            self.assertEqual(native_review(object(),'source'),{'state':'done'})
        self.assertEqual(seen,[False,False,True])
        self.assertIs(loop._review_input_budget_exhausted,original)


class FullNotesReviewTests(unittest.TestCase):
    def review(self,steps,prompt_tokens):
        """A real review, in its own process as in production, against a scripted local model
        server on notes 2,172 of 2,200 characters full: each tool step sends the next memory
        operations until one is applied, then a summary. Returns the result, what the memory
        tool answered each step, the notes before and after, and the profile."""
        import os,subprocess,sys,threading
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        old=['Stale note %d: '%n+'x'*530 for n in range(4)];old[-1]=old[-1][:-13]
        results=[]
        class Model(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,body,kind='application/json'):
                self.send_response(200);self.send_header('content-type',kind);self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):self.reply(json.dumps({'object':'list','data':[{'id':'synthetic','object':'model','context_length':128000}]}).encode())
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers.get('content-length',0))))
                usage={'prompt_tokens':prompt_tokens,'completion_tokens':2,'total_tokens':prompt_tokens+2}
                # Hermes may add a note after a tool result's JSON, such as a tool loop warning.
                answers=[json.JSONDecoder().raw_decode(m['content'])[0] for m in payload.get('messages',[]) if m.get('role')=='tool']
                if payload.get('tools'):results[:]=answers
                done=not payload.get('tools') or answers and answers[-1].get('success') or len(answers)>=len(steps)
                operations=None if done else steps[len(answers)]
                call=operations is not None
                tool={'id':'call_%d'%len(answers),'type':'function','function':{'name':'memory','arguments':json.dumps({'target':'memory','operations':operations})}}
                message={'role':'assistant','content':None,'tool_calls':[tool]} if call else {'role':'assistant','content':'Saved.'}
                finish='tool_calls' if call else 'stop'
                if not payload.get('stream'):
                    return self.reply(json.dumps({'id':'r','object':'chat.completion','created':0,'model':'synthetic','usage':usage,
                        'choices':[{'index':0,'message':message,'finish_reason':finish}]}).encode())
                delta={'role':'assistant','tool_calls':[{'index':0,**tool}]} if call else {'role':'assistant','content':'Saved.'}
                chunks=[{'choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':usage}]
                self.reply(b''.join(b'data: '+json.dumps({'id':'r','object':'chat.completion.chunk','created':0,'model':'synthetic',**c}).encode()+b'\n\n' for c in chunks)+b'data: [DONE]\n\n','text/event-stream')
        child=("import sys\nfrom unittest.mock import patch\n"
               "from services.hermes import archive_tools,assistant_turn,request_boundary,subscription\n"
               "install=request_boundary.install\n"
               "with patch.object(request_boundary,'install',lambda:install(request_boundary.Boundary('on',transform=lambda url,payload:payload))),"
               "patch.object(subscription,'configured_urls',lambda:{sys.argv[1]}),patch.object(archive_tools,'request',lambda path,value:value):\n"
               "    assistant_turn.main()\n")
        server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
        base='http://127.0.0.1:%d/v1'%server.server_address[1]
        try:
            folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
            profile=Path(folder.name)/'profile';(profile/'native-state').mkdir(parents=True);(profile/'memories').mkdir()
            notes=profile/'memories'/'MEMORY.md';notes.write_text('\n§\n'.join(old));before=notes.read_text()
            body={'review':True,'review_id':'a'*64,'text':'The owner said the launch moved to Friday.','session_id':'review-'+'a'*64,
                  'chat_id':'5','user_id':'5','owner':True,'memory_context':'evidence','prompts':{},'model':'synthetic','api_key':'synthetic',
                  'base_url':base,'provider':'openai','api_mode':'chat_completions','archive_credential':'turn.synthetic'}
            process=subprocess.run([sys.executable,'-c',child,base],input=json.dumps(body),cwd=Path(__file__).resolve().parents[2],
                                   env={**os.environ,'HERMES_HOME':str(profile)},capture_output=True,text=True,timeout=240)
            self.assertEqual(process.returncode,0,process.stderr[-2000:])
            return json.loads(process.stdout.strip().splitlines()[-1]),results,before,notes.read_text(),profile
        finally:server.shutdown();server.server_close()

    def test_a_review_frees_room_in_full_notes_and_saves_the_new_note(self):
        # Hermes holds a background review's patch or remove for a person's approval in the
        # profile's pending folder. A review turn has no person to approve it, and that folder
        # goes with the turn's container, so full notes would never take a new note. The add is
        # refused as over the limit, then sent again with a remove in one batch.
        add=[{'action':'add','content':NEW}]
        result,results,_,saved,profile=self.review([add,[{'action':'remove','old_text':'Stale note 0:'},*add]],10)
        self.assertEqual(result['state'],'done')
        self.assertEqual([r.get('success') for r in results],[False,True],results)
        self.assertNotIn('staged',results[-1])
        self.assertIn(NEW,saved);self.assertNotIn('Stale note 0:',saved);self.assertIn('Stale note 3:',saved)
        self.assertFalse((profile/'pending').exists(),'nothing is held for an approval no one can give')
        # The review's own empty session is removed, so reviews leave no sessions behind.
        from hermes_state import SessionDB
        from .isolated_profile import database_path
        db=SessionDB(database_path(profile),read_only=True)
        try:self.assertIsNone(db.get_session('review-'+'a'*64))
        finally:db.close()

    def test_a_refused_batch_on_full_notes_leaves_room_to_try_again(self):
        # At a live-sized prompt per call, a review that needs a second try (here a patch whose
        # old_text matches no note, which refuses its whole batch) still gets the call that
        # saves the note and the summary after it, inside the review's input budget.
        add=[{'action':'add','content':NEW}]
        steps=[add,[{'action':'patch','old_text':'Stale entry 0','content':'S'},*add],[{'action':'remove','old_text':'Stale note 0:'},*add]]
        result,results,before,saved,_=self.review(steps,9600)
        self.assertEqual(result['state'],'done',result)
        self.assertEqual(result['usage']['calls'],4)
        self.assertEqual([r.get('success') for r in results],[False,False,True],results)
        self.assertNotEqual(saved,before);self.assertIn(NEW,saved)


NEW='The owner moved the launch to Friday.'
