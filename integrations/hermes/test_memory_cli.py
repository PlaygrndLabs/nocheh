import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.memory import main


class MemoryCliTests(unittest.TestCase):
    def invoke(self,args):
        with patch('scripts.memory.API') as api,contextlib.redirect_stdout(io.StringIO()):
            api.return_value.call.return_value={}
            self.assertEqual(main(args),0)
            return api.return_value.call.call_args.args

    def test_policy_round_trip_and_explicit_review(self):
        self.assertEqual(self.invoke(['policy','--space','-20/topic/1']),('/v1/memory/spaces?id=-20%2Ftopic%2F1',))
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'policy.json';file.write_text('{"mode":"isolated"}')
            self.assertEqual(self.invoke(['policy','--space','-20/topic/1','--set',str(file),'--revision','4']),
                             ('/v1/memory/spaces',{'id':'-20/topic/1','overrides':{'mode':'isolated'},'revision':4}))
        with patch('scripts.memory.API') as api,contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):main(['review','a'*64])
            api.assert_not_called()
        self.assertEqual(self.invoke(['review','a'*64,'--approve'])[1]['approved'],True)

    def test_pause_resume_and_private_recall(self):
        self.assertEqual(self.invoke(['pause','job']),('/v1/memory/reviews/control',{'id':'job','action':'pause'}))
        self.assertEqual(self.invoke(['resume','job']),('/v1/memory/reviews/control',{'id':'job','action':'resume'}))
        self.assertEqual(self.invoke(['recall','Juniper','--profile','native-profile','--limit','5']),
                         ('/v1/memory/recall',{'query':'Juniper','profile':'native-profile','limit':5}))
