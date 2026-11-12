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
    def test_a_review_frees_room_in_full_notes_and_saves_the_new_note(self):
        # Hermes holds a background review's patch or remove for a person's approval in the
        # profile's pending folder. A review turn has no person to approve it, and that folder
        # goes with the turn's container, so full notes would never take a new note. A real
        # review, in its own process as in production, against a scripted local model server:
        # the add is refused as over the limit, then sent again with a remove in one batch.
        import os,subprocess,sys,threading
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        old=['Stale note %d: '%n+'x'*530 for n in range(4)];new='The owner moved the launch to Friday.'
        add=[{'action':'add','content':new}];batch=[{'action':'remove','old_text':'Stale note 0:'},*add]
        results=[]
        class Model(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,body,kind='application/json'):
                self.send_response(200);self.send_header('content-type',kind);self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):self.reply(json.dumps({'object':'list','data':[{'id':'synthetic','object':'model','context_length':128000}]}).encode())
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers.get('content-length',0))))
                usage={'prompt_tokens':10,'completion_tokens':2,'total_tokens':12}
                answers=[json.loads(m['content']) for m in payload.get('messages',[]) if m.get('role')=='tool']
                if payload.get('tools'):results[:]=answers
                # First a lone add; after it is refused, the batch that frees room; then the summary.
                operations=None if not payload.get('tools') or answers and answers[-1].get('success') else batch if answers else add
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
            with tempfile.TemporaryDirectory() as folder:
                profile=Path(folder)/'profile';(profile/'native-state').mkdir(parents=True);(profile/'memories').mkdir()
                notes=profile/'memories'/'MEMORY.md';notes.write_text('\n§\n'.join(old))
                body={'review':True,'review_id':'a'*64,'text':'The owner said the launch moved to Friday.','session_id':'review-'+'a'*64,
                      'chat_id':'5','user_id':'5','owner':True,'memory_context':'evidence','prompts':{},'model':'synthetic','api_key':'synthetic',
                      'base_url':base,'provider':'openai','api_mode':'chat_completions','archive_credential':'turn.synthetic'}
                process=subprocess.run([sys.executable,'-c',child,base],input=json.dumps(body),cwd=Path(__file__).resolve().parents[2],
                                       env={**os.environ,'HERMES_HOME':str(profile)},capture_output=True,text=True,timeout=240)
                self.assertEqual(process.returncode,0,process.stderr[-2000:])
                self.assertEqual(json.loads(process.stdout.strip().splitlines()[-1])['state'],'done')
                self.assertEqual([r.get('success') for r in results],[False,True],results)
                self.assertNotIn('staged',results[-1])
                saved=notes.read_text()
                self.assertIn(new,saved);self.assertNotIn('Stale note 0:',saved);self.assertIn('Stale note 3:',saved)
                self.assertFalse((profile/'pending').exists(),'nothing is held for an approval no one can give')
        finally:server.shutdown();server.server_close()
