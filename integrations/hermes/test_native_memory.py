import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .native_memory import recall, native_review
from .scopes import Scopes


class NativeMemoryTests(unittest.TestCase):
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
            result=recall(root,{'query':'Juniper','limit':20})
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
