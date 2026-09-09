import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from .scopes import Scopes,Scope


class PreparedContextTests(unittest.TestCase):
    def test_guard_generations_isolate_owner_and_group_native_state(self):
        for scope in (Scope('123','123',True,'owner','123'),Scope('-20','123',False,'group','-20')):
            a=Scopes.apply_revision(scope,{'revision':2,'guard_epoch':5})
            b=Scopes.apply_revision(scope,{'revision':2,'guard_epoch':6})
            self.assertNotEqual(a.profile,b.profile)
            self.assertEqual(Scopes.apply_revision(a,{'revision':2,'guard_epoch':5}),a)

    def test_native_notes_keep_real_memory_store_and_prepare_reads_writes_results(self):
        from tools.memory_tool import MemoryStore
        from run_agent import AIAgent
        from .prepared_context import install
        seen=[]
        def prepare(value):
            seen.append(value)
            return json.loads(json.dumps(value).replace('synthetic-secret','***'))
        with tempfile.TemporaryDirectory() as folder,patch('integrations.hermes.prepared_context.prepare',side_effect=prepare):
            file=Path(folder)/'MEMORY.md';file.write_text('password: synthetic-secret')
            restore=install()
            try:
                self.assertEqual(MemoryStore._read_raw_checked(file),('password: ***',True))
                self.assertEqual(file.read_text(),'password: synthetic-secret','read projection leaves native original intact')
                MemoryStore._write_file(file,['new password: synthetic-secret'])
                self.assertEqual(file.read_text(),'new password: ***')
                self.assertEqual(AIAgent._tool_result_content_for_active_model(None,'fixture','tool synthetic-secret'),'tool ***')
                self.assertIn(['new password: synthetic-secret'],seen,'new unmodified note content reaches preparation for durable capture')
            finally:restore()
