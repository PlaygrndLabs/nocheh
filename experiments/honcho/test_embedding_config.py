"""Environment selection, secret isolation and model-specific spending limits."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import write_env,read_env,initialize,env_path,load
from scripts.embedding_config import embeddings
from scripts.settings import view
from . import control
from .meter import Egress,Ledger,Rejected
from .test_meter import Transport


class EmbeddingConfigTests(unittest.TestCase):
    def test_provider_model_validation_and_redacted_owner_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            self.assertEqual(values['NOCHEH_EMBEDDING_PROVIDER'],'openai')
            values['OPENAI_API_KEY']='synthetic-owner-key';write_env(env_path(state),values)
            visible=view(state)
            self.assertNotIn('synthetic-owner-key',str(visible))
            field=next(v for v in visible['fields'] if v['key']=='OPENAI_API_KEY')
            self.assertTrue(field['secret']);self.assertTrue(field['configured']);self.assertIsNone(field['value'])
            for change in ({'NOCHEH_EMBEDDING_PROVIDER':'openrouter'},{'NOCHEH_EMBEDDING_MODEL':'unreviewed-model'}):
                with self.assertRaises(ValueError):embeddings(change)
            del values['OPENAI_API_KEY'];values['NOCHEH_EMBEDDING_API_KEY']='legacy-dedicated-key';write_env(env_path(state),values)
            self.assertEqual(load(state)['OPENAI_API_KEY'],'legacy-dedicated-key')
            self.assertEqual(initialize(state)['OPENAI_API_KEY'],'legacy-dedicated-key')

    def test_honcho_and_meter_follow_env_without_receiving_paid_reasoning_key(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state'
            values={'NOCHEH_EMBEDDING_PROVIDER':'openai','NOCHEH_EMBEDDING_MODEL':'text-embedding-3-large','OPENAI_API_KEY':'synthetic-dedicated-key'}
            write_env(root/'.env',values)
            with patch.object(control,'ROOT',root),patch.object(control,'STATE',state),patch.dict(os.environ,{'OPENAI_API_KEY':'unrelated-shell-key'}):
                control.initialize()
                self.assertEqual((state/'temporary_embedding_key').read_text(),'synthetic-dedicated-key')
                self.assertEqual((state/'temporary_embedding_key').stat().st_mode&0o777,0o600)
                honcho=read_env(state/'honcho.env');meter=read_env(state/'meter.env')
                self.assertEqual(honcho['EMBEDDING_MODEL_CONFIG__MODEL'],values['NOCHEH_EMBEDDING_MODEL'])
                self.assertEqual(honcho['EMBEDDING_VECTOR_DIMENSIONS'],'1536')
                self.assertEqual(meter['NOCHEH_EMBEDDING_MODEL'],values['NOCHEH_EMBEDDING_MODEL'])
                self.assertEqual(honcho['DERIVER_MODEL_CONFIG__MODEL'],'gpt-5.6-sol')
                for name in ('compose.env','honcho.env','meter.env'):
                    self.assertNotIn(values['OPENAI_API_KEY'],(state/name).read_text())
                    self.assertNotIn('unrelated-shell-key',(state/name).read_text())
                values['OPENAI_API_KEY']='';values['NOCHEH_EMBEDDING_API_KEY']='old-key';write_env(root/'.env',values)
                control.initialize();self.assertEqual((state/'temporary_embedding_key').read_text(),'','explicit empty key must revoke saved and legacy credentials')

    def test_large_model_forces_matching_dimensions_and_reserves_its_full_cost(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'budget.sqlite';ledger=Ledger(path);transport=Transport()
            large=embeddings({'NOCHEH_EMBEDDING_MODEL':'text-embedding-3-large'})
            self.assertGreater(large.reservation,131072*large.price_per_million)
            egress=Egress(ledger,'subscription-token','dedicated-key',transport,embedding=large,reasoning_key='honcho-client')
            payload={'model':large.model,'input':'synthetic text'}
            self.assertEqual(egress.send('/v1/embeddings',payload)[0],200)
            sent=transport.calls[0]
            self.assertEqual(json.loads(sent.data)['dimensions'],1536)
            self.assertEqual(sent.full_url,'https://api.openai.com/v1/embeddings')
            self.assertEqual(ledger.report()['reserved_usd'],.02)
            for _ in range(249):ledger.reserve('/v1/embeddings',b'fixture',large)
            with self.assertRaises(Rejected):egress.send('/v1/embeddings',payload)
            self.assertEqual(len(transport.calls),1)
            restored=Ledger(path)
            self.assertEqual(restored.report()['reserved_usd'],5)
            with self.assertRaisesRegex(Rejected,'embedding_model_change_requires_rebuild'):restored.reserve('/v1/embeddings',b'fixture')
            self.assertEqual(restored.report()['embedding_route']['model'],large.model)


if __name__=='__main__':unittest.main()
