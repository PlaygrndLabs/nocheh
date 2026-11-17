import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from .retired_history import NOTE_DELIMITER, SUMMARY_WITHHELD, withheld_ids, withhold_retired

FACT='Synthetic Kite Juniper'
PRIVATE,QUESTION,UNRELATED='a'*64,'b'*64,'c'*64
OTHER_SOURCE='d'*64
# Delivered replies to the private message and to the later question.
NOTED,ANSWERED='e'*64,'f'*64

# The pinned Hermes messages table and a full-text index kept by triggers.
SCHEMA='''
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT);
CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
 tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, reasoning_content TEXT,
 reasoning_details TEXT, codex_reasoning_items TEXT, codex_message_items TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, api_content TEXT, display_kind TEXT, display_metadata TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, tool_calls);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
 INSERT INTO messages_fts(rowid,content,tool_calls) VALUES (new.id,coalesce(new.content,''),coalesce(new.tool_calls,'')); END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content,tool_calls ON messages BEGIN
 DELETE FROM messages_fts WHERE rowid=old.id;
 INSERT INTO messages_fts(rowid,content,tool_calls) VALUES (new.id,coalesce(new.content,''),coalesce(new.tool_calls,'')); END;
'''


def marker(event):
    return '\n\n[Archive source: nocheh:event:'+event+']'


def source(*events):
    return ', '.join('nocheh:event:'+event for event in events)


def call(name,arguments):
    return json.dumps([{'id':'call-'+name,'type':'function','function':{'name':name,'arguments':json.dumps(arguments)}}])


class Lookup:
    """Storage's answer: the private message and the later answer repeating it are retired."""
    def __init__(self,retired=(PRIVATE,),answered=((PRIVATE,NOTED),(QUESTION,ANSWERED)),revision='1:2026-10-10'):
        self.answered=dict(answered);self.retired=set(retired)|set(self.answered.values())
        self.revision,self.calls=revision,[]

    def __call__(self,event_ids):
        self.calls.append(list(event_ids))
        return {'revision':self.revision,'retired':sorted(self.retired&set(event_ids)),
                'answered':{event:[self.answered[event]] for event in event_ids if event in self.answered}}


class RetiredHistoryTests(unittest.TestCase):
    def history(self,folder,memory={'content':'Kite: '+FACT}):
        """A private chat whose earlier turns stated and then repeated a fact."""
        database=Path(folder)/'native-state'/'state.db';database.parent.mkdir()
        connection=sqlite3.connect(database);connection.executescript(SCHEMA)
        connection.execute("INSERT INTO sessions(id,title,title_source) VALUES ('private','Kite named "+FACT+"','llm'),('renamed','Owner title','user')")
        rows=[
            ('private','user','[CONTEXT SUMMARY]: earlier small talk.',None,None,1.0,1),
            ('private','user','My kite is named '+FACT+'.'+marker(PRIVATE),None,None,2.0,0),
            ('private','assistant','',call('memory',memory),None,2.1,0),
            ('private','tool','{"success": true, "entry": "Kite: '+FACT+'"}',None,'call-memory',2.2,0),
            ('private','assistant','Noted, your kite is '+FACT+'.',None,None,2.3,0),
            ('private','user','What is my kite called?'+marker(QUESTION),None,None,3.0,0),
            ('private','assistant','',call('mcp__nocheh__archive_search',{'query':'kite'}),None,3.1,0),
            ('private','tool',json.dumps({'results':[{'id':PRIVATE,'text':'My kite is named '+FACT}]}),None,'call-mcp__nocheh__archive_search',3.2,0),
            ('private','assistant','It is '+FACT+'.',None,None,3.3,0),
            ('private','user','[CONTEXT SUMMARY]: the kite is '+FACT+'.',None,None,3.5,1),
            ('private','user','Will it rain?'+marker(UNRELATED),None,None,4.0,0),
            ('private','assistant','',call('mcp__nocheh__archive_search',{'query':'rain'}),None,4.1,0),
            ('private','tool',json.dumps({'results':[{'id':OTHER_SOURCE,'text':'Rain on Friday'}]}),None,'call-mcp__nocheh__archive_search',4.2,0),
            ('private','assistant','Rain is expected on Friday.',None,None,4.3,0),
            ('renamed','user','Different chat.'+marker(UNRELATED),None,None,5.0,0),
        ]
        for session,role,content,tool_calls,tool_call_id,timestamp,summary in rows:
            connection.execute('INSERT INTO messages(session_id,role,content,tool_calls,tool_call_id,timestamp,_compressed_summary,reasoning,api_content) VALUES (?,?,?,?,?,?,?,?,?)',
                (session,role,content,tool_calls,tool_call_id,timestamp,summary,'Thinking about '+FACT if role=='assistant' and FACT in (content or '') else None,
                 content if role=='assistant' else None))
        connection.commit();connection.close()
        return database

    def rows(self,database):
        connection=sqlite3.connect(database);connection.row_factory=sqlite3.Row
        try:return [dict(row) for row in connection.execute('SELECT * FROM messages ORDER BY id')]
        finally:connection.close()

    def leaks(self,database):
        connection=sqlite3.connect(database)
        try:
            stored=[value for row in connection.execute('SELECT * FROM messages') for value in row if isinstance(value,str) and 'Juniper' in value]
            indexed=connection.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'Juniper'").fetchone()[0]
            titled=connection.execute("SELECT count(*) FROM sessions WHERE title LIKE '%Juniper%'").fetchone()[0]
            return stored,indexed,titled
        finally:connection.close()

    def test_retired_message_and_repeating_answer_leave_stored_native_history(self):
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder);before=self.rows(database)
            self.assertEqual(self.leaks(database)[1],7,'the fixture reproduces the leak first')
            lookup=Lookup()
            self.assertEqual(withheld_ids(database,lookup),{2,3,4,5,7,8,9,10})
            self.assertEqual(self.rows(database),before,'a read-only check never writes')
            self.assertEqual(withhold_retired(database,lookup),8)
            self.assertEqual(self.leaks(database),([],0,0))
            after={row['id']:row for row in self.rows(database)}
            self.assertEqual(after[2]['content'],'[Retired message: '+source(PRIVATE)+']','the row says it was retired and which message')
            self.assertEqual(json.loads(after[3]['tool_calls'])[0]['function'],{'name':'memory','arguments':'{}'})
            self.assertEqual((after[4]['content'],after[5]['content'],after[8]['content'],after[9]['content']),
                             ('[Tool result withheld; its source was retired: '+source(PRIVATE,NOTED)+']','[Retired reply: '+source(NOTED)+']',
                              '[Tool result withheld; its source was retired: '+source(PRIVATE,ANSWERED)+']','[Retired reply: '+source(ANSWERED)+']'))
            self.assertEqual(after[6]['content'],'What is my kite called?'+marker(QUESTION),'the later question was not retired')
            self.assertEqual(after[10]['content'],SUMMARY_WITHHELD)
            unchanged={row['id']:row for row in before if row['id'] in (1,11,12,13,14,15)}
            self.assertEqual({key:after[key] for key in unchanged},unchanged,'earlier summary and unrelated turns stay')
            connection=sqlite3.connect(database)
            self.assertEqual(connection.execute("SELECT id,title FROM sessions ORDER BY id").fetchall(),[('private',None),('renamed','Owner title')])
            connection.close()
            # The next turn on an unchanged retirement revision reads nothing more.
            lookup.calls.clear()
            self.assertEqual(withhold_retired(database,lookup),0);self.assertEqual(lookup.calls,[[]])
            self.assertEqual(withheld_ids(database,lookup),set())
            # Placeholders keep naming their turn and source, so a later retirement rewrites nothing twice.
            self.assertEqual(withhold_retired(database,Lookup(revision='2:later')),0)
            self.assertEqual({row['id']:row['content'] for row in self.rows(database)},{key:row['content'] for key,row in after.items()})

    def test_retiring_only_the_message_keeps_its_delivered_answer_without_reasoning(self):
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder)
            withhold_retired(database,Lookup(answered=()))
            after={row['id']:row for row in self.rows(database)}
            self.assertEqual(after[2]['content'],'[Retired message: '+source(PRIVATE)+']')
            self.assertEqual((after[4]['content'],after[8]['content']),('[Tool result withheld; its source was retired: '+source(PRIVATE)+']',)*2,
                             'tool work for and results citing the retired message are withheld')
            self.assertEqual(after[5]['content'],'Noted, your kite is '+FACT+'.','an unretired reply remains its own source')
            self.assertIsNone(after[5]['reasoning'])
            self.assertEqual(after[9]['content'],'It is '+FACT+'.')
            # The retired message's notice still identifies its turn when its reply is retired later.
            withhold_retired(database,Lookup(revision='2:reply'))
            self.assertEqual(self.rows(database)[4]['content'],'[Retired reply: '+source(NOTED)+']')

    def test_a_new_retirement_rechecks_history_and_restoring_does_not_rebuild_it(self):
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder)
            withhold_retired(database,Lookup(retired=(),answered=()))
            self.assertEqual(self.leaks(database)[1],7)
            self.assertEqual(withhold_retired(database,Lookup(revision='2:later')),8)
            self.assertEqual(withhold_retired(database,Lookup(retired=(),answered=(),revision='3:restored')),0)
            self.assertEqual(self.leaks(database),([],0,0))

    def notes(self,folder,**files):
        notes=Path(folder)/'memories';notes.mkdir(exist_ok=True)
        for name,entries in files.items():(notes/name.replace('_','.',1)).write_text(NOTE_DELIMITER.join(entries))
        return notes

    def entries(self,notes,name):
        return (notes/name).read_text().split(NOTE_DELIMITER)

    def test_native_notes_lose_entries_written_by_or_citing_a_retired_message(self):
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder);cited='Kite colour noted (nocheh:event:'+PRIVATE+')';rain='Rain on Friday (nocheh:event:'+UNRELATED+')'
            notes=self.notes(folder,MEMORY_md=['Kite: '+FACT,cited,rain],USER_md=['Prefers Persian replies'],
                             **{'MEMORY_md.bak.1700000000':['Kite: '+FACT,cited]})
            # Seven rows: the later answer that read the retired message in a search result loses its reasoning too.
            self.assertEqual(withhold_retired(database,Lookup(answered=()),notes),7+4,'seven history rows and four note entries')
            self.assertEqual(self.entries(notes,'MEMORY.md'),[rain],'the retired turn\'s memory write and a citing entry are removed')
            self.assertEqual(self.entries(notes,'USER.md'),['Prefers Persian replies'])
            self.assertEqual((notes/'MEMORY.md.bak.1700000000').read_text(),'','Hermes\' drift backup is a copy too')
            self.assertFalse([path for path in notes.iterdir() if path.name.startswith('.mem_')])
            # A note written after the last check is checked on the next turn without rereading history.
            (notes/'MEMORY.md').write_text(NOTE_DELIMITER.join([rain,'Kite again (nocheh:event:'+PRIVATE+')']))
            lookup=Lookup(answered=())
            self.assertEqual(withhold_retired(database,lookup,notes),1)
            self.assertEqual(self.entries(notes,'MEMORY.md'),[rain]);self.assertEqual(lookup.calls,[[PRIVATE,UNRELATED]])

    def test_native_notes_lose_entries_written_through_memory_operations(self):
        add={'action':'add','content':'Kite: '+FACT};rain='Rain on Friday'
        # Hermes advertises operations[]; a model may still send it as a JSON string or one object.
        # A patch swaps only its span (here FACT for 'Blue') and keeps the rest of the entry.
        for operations in ([{'action':'remove','old_text':'Old','content':rain},add],json.dumps([add]),add,[json.dumps(add)],
                           [{'action':'patch','old_text':'Blue','content':FACT}],[{'action':'patch','old_text':'Blue','new_text':FACT}]):
            with self.subTest(operations=operations),tempfile.TemporaryDirectory() as folder:
                database=self.history(folder,{'target':'memory','operations':operations})
                notes=self.notes(folder,MEMORY_md=['Kite: '+FACT,rain])
                withhold_retired(database,Lookup(answered=()),notes)
                self.assertEqual(self.entries(notes,'MEMORY.md'),[rain],'only add and patch text counts as written')
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder,{'target':'memory','operations':[{'action':'patch','old_text':'Sat','content':'Fri'}]})
            notes=self.notes(folder,MEMORY_md=['Kite: '+FACT,rain,'Sun'])
            withhold_retired(database,Lookup(answered=()),notes)
            self.assertEqual(self.entries(notes,'MEMORY.md'),['Kite: '+FACT,rain,'Sun'],'a span this short marks no entry')

    def test_memory_operations_are_read_one_by_one_from_a_rows_raw_calls(self):
        # Who wrote a note follows the replace and patch operations a run asked for (ADR-0257).
        from .retired_history import memory_ops
        batch={'operations':[{'action':'patch','target':'user','old_text':'tea','new_text':'coffee'},'{"action":"remove","old_text":"Bob"}'],'target':'memory'}
        row={'tool_calls':json.dumps([
            {'id':'1','type':'function','function':{'name':'memory','arguments':json.dumps({'action':'replace','target':'user','old_text':'old','content':'new'})}},
            {'id':'2','type':'function','function':{'name':'memory','arguments':json.dumps(batch)}},
            {'id':'3','type':'function','function':{'name':'web_extract','arguments':'{"url":"https://example.test"}'}},
            {'id':'4','type':'function','function':{'name':'memory','arguments':'not json'}}])}
        self.assertEqual(memory_ops(row),[
            {'action':'replace','target':'user','old_text':'old','content':'new'},
            {'action':None,'target':'memory','old_text':None,'content':None},
            {'action':'patch','target':'user','old_text':'tea','content':'coffee'},
            {'action':'remove','target':'memory','old_text':'Bob','content':None}])
        self.assertEqual(memory_ops({'tool_calls':None}),[])

    def test_owner_recall_skips_native_notes_citing_a_retired_message(self):
        import sys
        from types import SimpleNamespace
        from .native_memory import recall
        from .scopes import Scopes
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder)/'profiles'/Scopes.profile('123');profile.mkdir(parents=True)
            self.notes(profile,MEMORY_md=['Kite '+FACT+' (nocheh:event:'+PRIVATE+')','Kite festival '+FACT+' (nocheh:event:'+UNRELATED+')'])
            with patch.dict(sys.modules,{'hermes_state':SimpleNamespace(SessionDB=None)}):
                found=recall(Path(folder),{'query':'Juniper','limit':20},retirements=Lookup())
            self.assertEqual([hit['citations'] for hit in found['hits']],[['nocheh:event:'+UNRELATED]])

    def test_unavailable_retirement_state_writes_nothing_and_stops_the_turn(self):
        from .scopes import Scope
        from .turn_process import run_process
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);database=self.history(folder);before=self.rows(database)
            def unavailable(event_ids):raise OSError('storage unavailable')
            with patch('services.hermes.retired_history.service_lookup',unavailable),\
                 patch('services.hermes.assistant_gateway.prepare_profile',return_value=profile),\
                 patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=True),\
                 patch('services.hermes.turn_process._run_process',new_callable=AsyncMock) as child:
                with self.assertRaises(OSError):
                    asyncio.run(run_process(profile,Scope('42','42',True,'owner'),{'archive_credential':'turn.e30.signature'},'model',None,'session'))
                child.assert_not_awaited()
            self.assertEqual(self.rows(database),before)
            connection=sqlite3.connect(database)
            self.assertEqual(connection.execute('SELECT count(*) FROM state_meta').fetchone()[0],0,'nothing is marked checked')
            connection.close()

    def test_turn_withholds_retired_history_before_the_child_starts(self):
        from .scopes import Scope
        from .turn_process import run_process
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);database=self.history(folder)
            async def child(*args):
                self.assertEqual(self.leaks(database),([],0,0));return {'state':'done'}
            with patch('services.hermes.retired_history.service_lookup',Lookup()),\
                 patch('services.hermes.assistant_gateway.prepare_profile',return_value=profile),\
                 patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=True),\
                 patch('services.hermes.turn_process._run_process',side_effect=child):
                self.assertEqual(asyncio.run(run_process(profile,Scope('42','42',True,'owner'),{'archive_credential':'turn.e30.signature'},
                                                         'model',None,'session'))['state'],'done')

    def test_native_hermes_replay_and_search_no_longer_return_a_retired_fact(self):
        try:from hermes_state import SessionDB
        except ImportError:self.skipTest('pinned Hermes runtime required')
        from .native_memory import recall
        from .scopes import Scopes
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder)/'profiles'/Scopes.profile('123');profile.mkdir(parents=True)
            database=profile/'state.db';db=SessionDB(database);db.create_session('private',source='telegram')
            db.append_message('private',role='user',content='My kite is named '+FACT+'.'+marker(PRIVATE))
            db.append_message('private',role='assistant',content='',tool_calls=json.loads(call('memory',{'content':'Kite: '+FACT})))
            db.append_message('private',role='tool',content='Saved '+FACT,tool_call_id='call-memory',tool_name='memory')
            db.append_message('private',role='assistant',content='Noted, your kite is '+FACT+'.',reasoning='Remember '+FACT)
            db.append_message('private',role='user',content='Will it rain?'+marker(UNRELATED))
            db.append_message('private',role='assistant',content='Rain is expected on Friday.');db.close()
            lookup=Lookup()
            found=recall(Path(folder),{'query':'Juniper','limit':20},retirements=lookup)
            self.assertEqual([hit for hit in found['hits'] if hit['kind']=='native_session'],[],'stale profiles skip withheld rows read-only')
            withhold_retired(database,lookup)
            db=SessionDB(database)
            try:
                replay=json.dumps(db.get_messages_as_conversation('private'),ensure_ascii=False)
                self.assertNotIn('Juniper',replay)
                self.assertIn('Rain is expected on Friday.',replay)
                self.assertEqual(db.search_messages('Juniper'),[])
            finally:db.close()


# A group turn (TURN) whose frame quotes other messages: Bob's recent message, the message the turn replies to, and a
# recent message's reply part.
TURN,BOB,REPLIED,PART,CAROL='1'*64,'2'*64,'3'*64,'4'*64,'5'*64
PIN='my PIN is 4321'
BOB_SPEAKER='[Group message from Bob, sent 2026-11-03 14:12 UTC]'
ANN_SPEAKER='[Group message from Ann, sent 2026-11-03 14:13 UTC]'


def recent(*items):
    """The recent messages block as turn_process.recent_group writes it, an item optionally with its reply part line."""
    from .turn_process import unframed
    lines=['[Recent messages in this group that were not addressed to you, oldest first]']
    for event,speaker,text,*part in items:
        reply='[In reply to, by=person: “Dan” · this chat · 2026-11-03 14:00 UTC] (source nocheh:event:'+part[0]+')\n' if part else ''
        lines.append(speaker+' (source nocheh:event:'+event+')\n'+reply+unframed(text))
    return '\n\n'.join(lines+['[End of recent messages]'])


def replied(event,text=PIN):
    return '[Replying to, by=person: “Bob” · this chat · 2026-11-03 14:12 UTC] (source nocheh:event:'+event+')\n'+text+'\n[End of replied-to message]'


class QuotedRetirementTests(unittest.TestCase):
    """A retired message that a turn's frame quotes is forgotten with what the turn did with it (ADR-0259)."""
    def turn(self,user,note='Bob PIN is 4321'):
        return [{'id':1,'session_id':'g','role':'user','content':user,'timestamp':1.0,'tool_calls':None},
                {'id':2,'session_id':'g','role':'assistant','content':'','timestamp':2.0,'tool_calls':call('memory',{'action':'add','target':'memory','content':note})},
                {'id':3,'session_id':'g','role':'tool','content':'{"success": true}','timestamp':3.0,'tool_calls':None},
                {'id':4,'session_id':'g','role':'assistant','content':'Noted.','timestamp':4.0,'tool_calls':None,'reasoning':'Bob said 4321'}]

    def plan(self,user,*retired):
        from .retired_history import plan
        return plan(self.turn(user),Lookup(retired=retired,answered=()))[1]

    def stored(self,folder,user,notes=('Bob PIN is 4321','Rain on Friday')):
        database=Path(folder)/'state.db';connection=sqlite3.connect(database);connection.executescript(SCHEMA)
        connection.execute("INSERT INTO sessions(id,title,title_source) VALUES ('g','Bob PIN','llm')")
        for row in self.turn(user):
            connection.execute('INSERT INTO messages(id,session_id,role,content,tool_calls,timestamp,reasoning,api_content) VALUES (?,?,?,?,?,?,?,?)',
                               (row['id'],'g',row['role'],row['content'],row['tool_calls'],row['timestamp'],row.get('reasoning'),row['content'] if row['id']==1 else None))
        connection.commit();connection.close()
        memories=Path(folder)/'memories';memories.mkdir()
        (memories/'MEMORY.md').write_text(NOTE_DELIMITER.join(notes))
        return database,memories

    def text(self,database):
        connection=sqlite3.connect(database)
        try:return json.dumps([list(row) for row in connection.execute('SELECT * FROM messages')]+
                              [list(row) for row in connection.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '4321'")])
        finally:connection.close()

    def test_the_reviews_probe_withholds_a_retired_recent_message_and_keeps_the_rows_own_text(self):
        from .retired_history import plan
        rows=[{'id':1,'session_id':'s','role':'user','content':recent((BOB,'[Group message from Bob]','secret text'))+'\n\nhello'+marker(TURN),'timestamp':1,'tool_calls':None},
              {'id':2,'session_id':'s','role':'assistant','content':'answer','timestamp':2,'tool_calls':None}]
        self.assertEqual(plan(rows,Lookup(retired=(BOB,),answered=())),('1:2026-10-10',{1:{'content':
            '[Recent messages in this group that were not addressed to you, oldest first]\n\n[Quoted message withheld; it was retired: nocheh:event:'+BOB+
            ']\n\n[End of recent messages]\n\nhello'+marker(TURN)}}),'today this returned no change at all')

    def test_a_retired_recent_message_withholds_the_turns_tool_work_and_the_note_written_from_it(self):
        user=recent((BOB,BOB_SPEAKER,PIN),(CAROL,'[Group message from Carol, sent 2026-11-03 14:12 UTC]','lunch at noon'))+'\n\n'+ANN_SPEAKER+'\nremember that'+marker(TURN)
        with tempfile.TemporaryDirectory() as folder:
            database,memories=self.stored(folder,user);lookup=Lookup(retired=(BOB,),answered=())
            self.assertEqual(withheld_ids(database,lookup),{1,2,3,4},'a stale profile\'s native search skips the rows the next turn changes')
            self.assertEqual(withhold_retired(database,lookup,memories),4+1)
            after={row['id']:row for row in RetiredHistoryTests.rows(self,database)}
            self.assertEqual(after[1]['content'],user.replace(BOB_SPEAKER+' (source nocheh:event:'+BOB+')\n'+PIN,'[Quoted message withheld; it was retired: nocheh:event:'+BOB+']'),
                             'only the retired message goes: another recent message, the row\'s own text and its marker stay')
            self.assertIsNone(after[1]['api_content'])
            self.assertEqual(json.loads(after[2]['tool_calls'])[0]['function'],{'name':'memory','arguments':'{}'})
            self.assertEqual(after[3]['content'],'[Tool result withheld; its source was retired: '+source(BOB)+']')
            self.assertEqual((after[4]['content'],after[4]['reasoning']),('Noted.',None),'the delivered answer stays without its reasoning')
            self.assertEqual(self.entries(memories),['Rain on Friday'],'the note the turn wrote from the quoted message is removed')
            self.assertNotIn('4321',self.text(database))
            # Its notice is not a message to quote: an unchanged revision reads nothing, a new one rewrites nothing.
            self.assertEqual(withhold_retired(database,lookup,memories),0)
            self.assertEqual(withhold_retired(database,Lookup(retired=(BOB,),answered=(),revision='2:later'),memories),0)

    def entries(self,memories):
        return (memories/'MEMORY.md').read_text().split(NOTE_DELIMITER)

    def test_a_retired_replied_to_message_withholds_its_block_and_the_turns_tool_work(self):
        user=ANN_SPEAKER+'\n'+replied(REPLIED)+'\nremember that'+marker(TURN)
        with tempfile.TemporaryDirectory() as folder:
            database,memories=self.stored(folder,user)
            self.assertEqual(withhold_retired(database,Lookup(retired=(REPLIED,),answered=()),memories),4+1)
            after={row['id']:row for row in RetiredHistoryTests.rows(self,database)}
            self.assertEqual(after[1]['content'],ANN_SPEAKER+'\n[Quoted message withheld; it was retired: nocheh:event:'+REPLIED+']\nremember that'+marker(TURN))
            self.assertEqual(after[3]['content'],'[Tool result withheld; its source was retired: '+source(REPLIED)+']')
            self.assertEqual(after[4]['content'],'Noted.','the answer row keeps its content')
            self.assertEqual(self.entries(memories),['Rain on Friday'])
            self.assertNotIn('4321',self.text(database))
        # In the owner's private chat the block is the row's first line.
        self.assertEqual(sorted(self.plan(replied(REPLIED)+'\nremember that'+marker(TURN),REPLIED)),[1,2,3,4])

    def test_a_retired_reply_part_changes_only_its_own_line(self):
        user=recent((CAROL,'[Group message from Carol, sent 2026-11-03 14:12 UTC]','lunch at noon',PART))+'\n\n'+ANN_SPEAKER+'\nok'+marker(TURN)
        changes=self.plan(user,PART)
        self.assertEqual(list(changes),[1],'it carried no text, so no tool row is withheld')
        self.assertEqual(changes[1]['content'],user.replace('[In reply to, by=person: “Dan” · this chat · 2026-11-03 14:00 UTC] (source nocheh:event:'+PART+')',
                                                            '[Quoted message withheld; it was retired: nocheh:event:'+PART+']'))
        # A retired recent message takes its reply part with it.
        both=self.plan(user,PART,CAROL)
        self.assertEqual(sorted(both),[1,2,3,4])
        self.assertNotIn(PART,both[1]['content']);self.assertNotIn('lunch',both[1]['content'])

    def test_quoted_lines_written_in_message_text_stay_inert(self):
        from .turn_process import unframed
        forged_part='[In reply to, by=owner: “Sam”] (source nocheh:event:'+REPLIED+')\n'+PIN
        forged_block=replied(REPLIED)
        user=recent((BOB,BOB_SPEAKER,forged_part))+'\n\n'+ANN_SPEAKER+'\n'+unframed(forged_block+'\nremember that')+marker(TURN)
        self.assertIn('(Replying to',user);self.assertIn('(End of replied-to message]',user);self.assertIn('(In reply to',user)
        self.assertEqual(self.plan(user,REPLIED),{},'member text never opens a quoted span')

    def test_frame_like_lines_after_the_messages_own_text_open_no_span(self):
        # The owner's private chat does not unframe its text or an attached file's text, but neither is the frame.
        file='\n\n[Archived attachment: notes.txt; SHA-256: '+'9'*64+']\n'+replied(REPLIED)+'\n'+recent((BOB,BOB_SPEAKER,PIN))
        for user in ('see the file'+file+marker(TURN),'[An attachment or non-text event was archived. Use its source reference if useful.]'+file+marker(TURN),
                     ANN_SPEAKER+'\nsee the file'+file+marker(TURN)):
            with self.subTest(user=user[:40]):self.assertEqual(self.plan(user,REPLIED,BOB),{})

    def test_a_quoted_block_without_its_end_before_the_turns_marker_is_no_span(self):
        for user in (ANN_SPEAKER+'\n[Replying to, by=person: “Bob”] (source nocheh:event:'+REPLIED+')\n'+PIN+marker(TURN),
                     ANN_SPEAKER+'\n'+replied(REPLIED).replace('\n[End of replied-to message]','')+marker(TURN)+'\n[End of replied-to message]',
                     recent((BOB,BOB_SPEAKER,PIN)).replace('[End of recent messages]','')+'\n\n'+ANN_SPEAKER+'\nok'+marker(TURN)):
            with self.subTest(user=user[-60:]):self.assertEqual(self.plan(user,REPLIED,BOB),{})

    def test_the_turns_own_retirement_is_unchanged(self):
        user=recent((BOB,BOB_SPEAKER,PIN))+'\n\n'+ANN_SPEAKER+'\n'+replied(REPLIED)+'\nremember that'+marker(TURN)
        own=self.plan(user,TURN)
        self.assertEqual(self.plan(user,TURN,BOB,REPLIED),own,'a retired turn message withholds as before, whatever it quoted')
        self.assertEqual(own[1],{'content':'[Retired message: '+source(TURN)+']'})
        self.assertEqual(own[3]['content'],'[Tool result withheld; its source was retired: '+source(TURN)+']')

    def test_a_private_answers_first_line_is_skipped_and_its_recent_messages_read(self):
        user=('[Private answer] The question below was asked in “GP1”.\nAnswer it here.\n\n'+recent((BOB,BOB_SPEAKER,PIN))+'\n\n'+ANN_SPEAKER+
              '\nwhat did Bob say?'+marker(TURN)+'\n[Archive source: nocheh:event:'+QUESTION+']')
        changes=self.plan(user,BOB)
        self.assertEqual(sorted(changes),[1,2,3,4])
        self.assertTrue(changes[1]['content'].startswith('[Private answer] The question below was asked in “GP1”.\nAnswer it here.\n\n'))
        self.assertNotIn('4321',changes[1]['content'])
        self.assertTrue(changes[1]['content'].endswith(marker(TURN)+'\n[Archive source: nocheh:event:'+QUESTION+']'))
        # Only a private answer's row skips its first lines.
        self.assertEqual(self.plan(user.replace(marker(TURN)+'\n','\n\n'),BOB),{})


class RetiredHistoryReviewTests(unittest.TestCase):
    """What the review of ADR-0259's first step found: older checked profiles, a second retirement in one block, notes
    copied from a tool result, archive_page's reply links, and owner recall before the profile's next turn."""

    def test_a_profile_checked_by_the_older_rules_is_planned_again_once_at_the_same_revision(self):
        from .retired_history import CHECKED_KEY
        user=recent((BOB,BOB_SPEAKER,PIN))+'\n\n'+ANN_SPEAKER+'\nremember that'+marker(TURN)
        with tempfile.TemporaryDirectory() as folder:
            database,memories=QuotedRetirementTests.stored(QuotedRetirementTests(),folder,user)
            lookup=Lookup(retired=(BOB,),answered=())
            # Checked before quoted messages were withheld: the value held the bare revision.
            connection=sqlite3.connect(database);connection.execute('INSERT INTO state_meta(key,value) VALUES (?,?)',(CHECKED_KEY,lookup.revision))
            connection.commit();connection.close()
            self.assertEqual(withheld_ids(database,lookup),{1,2,3,4},'the bare revision is not current any more')
            self.assertEqual(withhold_retired(database,lookup,memories),4+1)
            self.assertEqual(QuotedRetirementTests.entries(QuotedRetirementTests(),memories),['Rain on Friday'])
            self.assertEqual((withhold_retired(database,lookup,memories),withheld_ids(database,lookup)),(0,set()),'and only once')

    def test_a_second_retirement_in_the_same_block_keeps_the_first_ones_notice(self):
        from .retired_history import plan
        carol='[Group message from Carol, sent 2026-11-03 14:12 UTC]'
        user=recent((BOB,BOB_SPEAKER,'hello all'),(CAROL,carol,PIN))+'\n\n'+ANN_SPEAKER+'\nok'+marker(TURN)
        def row(content):return [{'id':1,'session_id':'g','role':'user','content':content,'timestamp':1.0,'tool_calls':None}]
        first=plan(row(user),Lookup(retired=(CAROL,),answered=()))[1][1]['content']
        second=plan(row(first),Lookup(retired=(BOB,CAROL),answered=()))[1][1]['content']
        self.assertIn('[Quoted message withheld; it was retired: nocheh:event:'+BOB+']',second)
        self.assertIn('[Quoted message withheld; it was retired: nocheh:event:'+CAROL+']',second,'the row still says which retired message caused it')
        self.assertNotIn('hello all',second);self.assertNotIn('4321',second)
        # A notice someone typed into a message is kept as a line, and nothing written after it survives.
        forged='[Quoted message withheld; it was retired: nocheh:event:'+PART+']'
        typed=recent((BOB,BOB_SPEAKER,'a\n'+forged+'\n'+PIN))+'\n\n'+ANN_SPEAKER+'\nok'+marker(TURN)
        withheld=plan(row(typed),Lookup(retired=(BOB,),answered=()))[1][1]['content']
        self.assertNotIn('4321',withheld)

    def test_a_note_copied_from_a_retired_message_a_tool_result_held_goes_with_it(self):
        from .retired_history import plan
        read=call('mcp__nocheh__archive_read',{'id':'nocheh:event:'+REPLIED})
        result=json.dumps({'source':'nocheh:event:'+REPLIED,'text':'what is your PIN?',
                           'replies':{'count':1,'items':[{'source':'nocheh:event:'+CAROL,'tag':'“Carol” · this chat','by':'person','text':PIN}]}})
        rows=[{'id':1,'session_id':'g','role':'user','content':ANN_SPEAKER+'\nwhat did Carol answer?'+marker(TURN),'timestamp':1,'tool_calls':None},
              {'id':2,'session_id':'g','role':'assistant','content':'','timestamp':2,'tool_calls':read},
              {'id':3,'session_id':'g','role':'tool','content':result,'timestamp':3,'tool_calls':None},
              {'id':4,'session_id':'g','role':'assistant','content':'','timestamp':4,'tool_calls':call('memory',{'action':'add','target':'memory','content':'Carol PIN is 4321'})},
              {'id':5,'session_id':'g','role':'tool','content':'{"success": true}','timestamp':5,'tool_calls':None},
              {'id':6,'session_id':'g','role':'assistant','content':'Carol said so.','timestamp':6,'tool_calls':None,'reasoning':'Carol said 4321'}]
        changes=plan(rows,Lookup(retired=(CAROL,),answered=()))[1]
        self.assertEqual(sorted(changes),[3,4,5,6])
        self.assertEqual(json.loads(changes[4]['tool_calls'])[0]['function'],{'name':'memory','arguments':'{}'},'the memory call copied from it')
        self.assertEqual(changes[6],{'reasoning':None},'the delivered answer stays without its reasoning')
        with tempfile.TemporaryDirectory() as folder:
            database=Path(folder)/'state.db';connection=sqlite3.connect(database);connection.executescript(SCHEMA)
            for item in rows:connection.execute('INSERT INTO messages(id,session_id,role,content,tool_calls,timestamp,reasoning) VALUES (?,?,?,?,?,?,?)',
                                                (item['id'],'g',item['role'],item['content'],item['tool_calls'],item['timestamp'],item.get('reasoning')))
            connection.commit();connection.close()
            memories=Path(folder)/'memories';memories.mkdir();(memories/'MEMORY.md').write_text(NOTE_DELIMITER.join(['Carol PIN is 4321','Rain on Friday']))
            withhold_retired(database,Lookup(retired=(CAROL,),answered=()),memories)
            self.assertEqual((memories/'MEMORY.md').read_text(),'Rain on Friday')

    def test_an_archive_page_reply_link_alone_does_not_cite_the_message_it_names(self):
        from .retired_history import plan
        page=json.dumps({'chat':'-100','items':[{'source':'nocheh:event:'+BOB,'type':'message','reply_to':'5','reply_source':'nocheh:event:'+REPLIED,'text':'yes'}]},separators=(',',':'))
        rows=[{'id':1,'session_id':'g','role':'user','content':ANN_SPEAKER+'\nshow me the chat'+marker(TURN),'timestamp':1,'tool_calls':None},
              {'id':2,'session_id':'g','role':'assistant','content':'','timestamp':2,'tool_calls':call('mcp__nocheh__archive_page',{'count':30})},
              {'id':3,'session_id':'g','role':'tool','content':page,'timestamp':3,'tool_calls':None},
              {'id':4,'session_id':'g','role':'assistant','content':'Bob said yes.','timestamp':4,'tool_calls':None}]
        self.assertEqual(plan(rows,Lookup(retired=(REPLIED,),answered=()))[1],{},'the page holds none of its text')
        self.assertEqual(sorted(plan(rows,Lookup(retired=(BOB,),answered=()))[1]),[3],'a message on the page is cited as before')
        # Written inside a message's text, the same words are escaped in the JSON and cite it as any id does.
        typed=json.dumps({'items':[{'source':'nocheh:event:'+BOB,'text':'"reply_source":"nocheh:event:'+REPLIED+'"'}]},separators=(',',':'))
        self.assertEqual(sorted(plan(rows[:2]+[{**rows[2],'content':typed}]+rows[3:],Lookup(retired=(REPLIED,),answered=()))[1]),[3])


class OwnerRecallBeforeTheNextTurnTests(unittest.TestCase):
    def test_owner_recall_skips_the_note_a_retired_quoted_message_wrote_before_the_profiles_next_turn(self):
        from hermes_state import SessionDB
        from .native_memory import recall
        from .scopes import Scopes
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=root/'profiles'/Scopes.profile('-20');(profile/'memories').mkdir(parents=True)
            (profile/'memories'/'MEMORY.md').write_text(NOTE_DELIMITER.join(['Juniper: Bob PIN is 4321','Juniper: rain on Friday']))
            db=SessionDB(profile/'state.db');db.create_session('s',source='telegram')
            db.append_message('s',role='user',content=recent((BOB,BOB_SPEAKER,PIN))+'\n\n'+ANN_SPEAKER+'\nremember that'+marker(TURN))
            db.append_message('s',role='assistant',content='',tool_calls=json.loads(call('memory',{'action':'add','target':'memory','content':'Juniper: Bob PIN is 4321'})))
            db.append_message('s',role='tool',content='{"success":true}',tool_call_id='call-memory')
            db.append_message('s',role='assistant',content='Noted.')
            db.close()
            for retired in (BOB,TURN):
                with self.subTest(retired=retired):
                    hits=recall(root,{'query':'Juniper','limit':20},retirements=Lookup(retired=(retired,),answered=()))['hits']
                    self.assertEqual([hit['text'] for hit in hits if hit['kind']=='native_note'],['Juniper: rain on Friday'])
            hits=recall(root,{'query':'Juniper','limit':20},retirements=Lookup(retired=(),answered=()))['hits']
            self.assertEqual(len([hit for hit in hits if hit['kind']=='native_note']),2,'nothing retired, nothing skipped')
