import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .assistant_gateway import AssistantGateway,continuation_id
from .capture import canonical,digest,immutable_file
from .scopes import Scope

LEADER='ab'*32
KEY='telegram:123456:update:41'


def attempt(n,leader=LEADER):return 'c'+str(n)+'-'+leader[:40]


class ContinuationAcceptanceTests(unittest.TestCase):
    def test_message_turn_needs_a_whole_attempt(self):
        self.assertIsNone(continuation_id({'attempt':1}))
        for value in (attempt(1),True,0,'1',None):
            with self.subTest(attempt=value),self.assertRaisesRegex(ValueError,'invalid_dispatch_attempt'):continuation_id({'attempt':value})

    def test_continuation_attempt_must_name_its_continuation(self):
        self.assertEqual(continuation_id({'attempt':attempt(1),'continuation':LEADER}),LEADER)
        self.assertEqual(continuation_id({'attempt':attempt(999),'continuation':LEADER}),LEADER)
        for body in ({'attempt':attempt(1,'f'*64),'continuation':LEADER},
                     {'attempt':'c0-'+LEADER[:40],'continuation':LEADER},
                     {'attempt':'c1000-'+LEADER[:40],'continuation':LEADER},
                     {'attempt':attempt(1,LEADER.upper()),'continuation':LEADER.upper()},
                     {'attempt':attempt(1),'continuation':LEADER[:63]},
                     {'attempt':1,'continuation':LEADER},
                     {'attempt':attempt(1),'continuation':LEADER,'control_reply':'Fixed reply'}):
            with self.subTest(body=body),self.assertRaisesRegex(ValueError,'invalid_continuation'):continuation_id(body)


class ContinuationDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);self.root=Path(folder.name)
        for value in (patch.dict(os.environ,{'SERVICE_TOKEN':'synthetic-service-token-123456789','TELEGRAM_GROUP_REPLIES':'addressed','TELEGRAM_BOT_NAMES':'Nocheh'}),
                      patch('services.hermes.assistant_gateway.verify_capability',return_value={})):
            value.start();self.addCleanup(value.stop)
        policy=SimpleNamespace(enabled=True,resolve=lambda payload,scope:Scope(scope,'456',False,'p',scope))
        self.gateway=AssistantGateway(self.root,self.root/'spool',policy,'123456:synthetic','m',lambda:None)
        self.gateway.status='connected';self.gateway.adapter=SimpleNamespace();self.gateway.capacity=asyncio.Semaphore(1)
        self.runs=[]
        def recorder(kind):
            # Writes the receipt the way the real runner does, so dispatch replays it.
            async def run(scope,body,name,progress,cancelled):
                self.runs.append((kind,body['attempt']));result={'state':'done','runner':kind}
                await asyncio.to_thread(immutable_file,self.gateway.receipts,name+'.result',canonical(result))
                return result
            return run
        self.gateway._run_turn,self.gateway._run_continuation=recorder('turn'),recorder('continuation')

    def body(self,**changes):
        text='[Operations ended] Synthetic follow-up'
        value={'channel':'telegram','event_id':digest(KEY),'source_key':KEY,'scope':'-20','attempt':attempt(1),'continuation':LEADER,
               'archive_credential':'turn.synthetic.credential','text':text,'transcripts':[],'files':[],'guard_mode':'on',
               'payload':{'update_id':41,'message':{'message_id':41,'date':1700000000,'chat':{'id':-20,'type':'supergroup','is_forum':True},
                          'from':{'id':456,'is_bot':False,'first_name':'Participant'},'text':text,'message_thread_id':17,'is_topic_message':True}}}
        value.update(changes)
        return {key:item for key,item in value.items() if item is not None}

    async def test_an_unaddressed_group_continuation_still_runs(self):
        unaddressed={'direct':False,'handles':[]}
        self.assertEqual(await self.gateway.dispatch(self.body(group_addressing=unaddressed)),{'state':'done','runner':'continuation'})
        self.assertEqual(self.runs,[('continuation',attempt(1))])
        self.assertEqual(await self.gateway.dispatch(self.body(group_addressing=unaddressed,continuation=None,attempt=1)),
                         {'state':'suppressed','error_code':'not_addressed'},'a plain group message still needs addressing')
        self.assertEqual(self.runs,[('continuation',attempt(1))],'the message turn never ran')

    async def test_a_continuation_attempt_has_its_own_receipt(self):
        turn=self.body(continuation=None,attempt=1,group_addressing={'direct':True,'handles':[]})
        self.assertEqual(await self.gateway.dispatch(turn),{'state':'done','runner':'turn'})
        message=self.gateway.receipts/(digest(digest(KEY)+':1')+'.result');saved=message.read_bytes()
        first=self.body()
        self.assertEqual(await self.gateway.dispatch(first),{'state':'done','runner':'continuation'},'a message turn receipt never answers a continuation')
        self.assertTrue((self.gateway.receipts/(digest(digest(KEY)+':'+attempt(1))+'.result')).is_file())
        self.assertEqual(await self.gateway.dispatch(first),{'state':'done','runner':'continuation'})
        self.assertEqual(self.runs,[('turn',1),('continuation',attempt(1))],'the same attempt replays its receipt')
        self.assertEqual(await self.gateway.dispatch(self.body(attempt=attempt(2))),{'state':'done','runner':'continuation'})
        self.assertEqual(self.runs[-1],('continuation',attempt(2)),'a new attempt runs again')
        self.assertEqual(message.read_bytes(),saved,'the message turn receipt is untouched')
        self.assertEqual(await self.gateway.dispatch(turn),{'state':'done','runner':'turn'})
        self.assertEqual(len(self.runs),3)

    async def test_a_continuation_stays_bound_to_the_asking_update(self):
        other='telegram:123456:update:42'
        for body in (self.body(source_key=other),self.body(source_key=other,event_id=digest(other)),
                     self.body(source_key='telegram:654321:update:41',event_id=digest('telegram:654321:update:41'))):
            with self.subTest(source_key=body['source_key']),self.assertRaisesRegex(ValueError,'invalid_dispatch_identity'):await self.gateway.dispatch(body)
        self.assertEqual(self.runs,[]);self.assertEqual(list(self.gateway.receipts.iterdir()),[])

    async def test_a_malformed_continuation_closes_its_run_without_a_turn(self):
        # The asynchronous path: the refusal reaches no runner and the run closes uncertain, never retried as a message turn.
        self.gateway.loop=asyncio.get_running_loop()
        body=self.body(attempt=attempt(1,'f'*64))
        self.gateway.runs.start(body)
        for _ in range(200):
            state=self.gateway.runs.resume({'channel':'telegram','event_id':body['event_id'],'attempt':body['attempt'],'observe_only':True})
            if state['state'] not in ('queued','running'):break
            await asyncio.sleep(0.01)
        self.assertEqual((state['state'],state.get('error_code')),('ambiguous','runtime_execution_interrupted'))
        self.assertEqual(self.runs,[]);self.assertEqual(list(self.gateway.receipts.iterdir()),[])


if __name__=='__main__':unittest.main()
