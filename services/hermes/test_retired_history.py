import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from .retired_history import ANSWER_WITHHELD, NOTE_DELIMITER, SUMMARY_WITHHELD, TOOL_WITHHELD, USER_WITHHELD, withheld_ids, withhold_retired

FACT='Synthetic Kite Juniper'
PRIVATE,QUESTION,UNRELATED='a'*64,'b'*64,'c'*64
OTHER_SOURCE='d'*64

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


def call(name,arguments):
    return json.dumps([{'id':'call-'+name,'type':'function','function':{'name':name,'arguments':json.dumps(arguments)}}])


class Lookup:
    """Storage's answer: the private message and the later answer repeating it are retired."""
    def __init__(self,retired=(PRIVATE,),answered=(PRIVATE,QUESTION),revision='1:2026-10-10'):
        self.retired,self.answered,self.revision,self.calls=set(retired),set(answered),revision,[]

    def __call__(self,event_ids):
        self.calls.append(list(event_ids))
        return {'revision':self.revision,'retired':sorted(self.retired&set(event_ids)),'answered':sorted(self.answered&set(event_ids))}


class RetiredHistoryTests(unittest.TestCase):
    def history(self,folder):
        """A private chat whose earlier turns stated and then repeated a fact."""
        database=Path(folder)/'native-state'/'state.db';database.parent.mkdir()
        connection=sqlite3.connect(database);connection.executescript(SCHEMA)
        connection.execute("INSERT INTO sessions(id,title,title_source) VALUES ('private','Kite named "+FACT+"','llm'),('renamed','Owner title','user')")
        rows=[
            ('private','user','[CONTEXT SUMMARY]: earlier small talk.',None,None,1.0,1),
            ('private','user','My kite is named '+FACT+'.'+marker(PRIVATE),None,None,2.0,0),
            ('private','assistant','',call('memory',{'content':'Kite: '+FACT}),None,2.1,0),
            ('private','tool','{"success": true, "entry": "Kite: '+FACT+'"}',None,'call-memory',2.2,0),
            ('private','assistant','Noted, your kite is '+FACT+'.',None,None,2.3,0),
            ('private','user','What is my kite called?'+marker(QUESTION),None,None,3.0,0),
            ('private','assistant','',call('nocheh_archive_search',{'query':'kite'}),None,3.1,0),
            ('private','tool',json.dumps({'results':[{'id':PRIVATE,'text':'My kite is named '+FACT}]}),None,'call-nocheh_archive_search',3.2,0),
            ('private','assistant','It is '+FACT+'.',None,None,3.3,0),
            ('private','user','[CONTEXT SUMMARY]: the kite is '+FACT+'.',None,None,3.5,1),
            ('private','user','Will it rain?'+marker(UNRELATED),None,None,4.0,0),
            ('private','assistant','',call('nocheh_archive_search',{'query':'rain'}),None,4.1,0),
            ('private','tool',json.dumps({'results':[{'id':OTHER_SOURCE,'text':'Rain on Friday'}]}),None,'call-nocheh_archive_search',4.2,0),
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
            self.assertEqual(after[2]['content'],USER_WITHHELD+marker(PRIVATE))
            self.assertEqual(json.loads(after[3]['tool_calls'])[0]['function'],{'name':'memory','arguments':'{}'})
            self.assertEqual((after[4]['content'],after[5]['content'],after[8]['content'],after[9]['content']),
                             (TOOL_WITHHELD,ANSWER_WITHHELD,TOOL_WITHHELD,ANSWER_WITHHELD))
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

    def test_retiring_only_the_message_keeps_its_delivered_answer_without_reasoning(self):
        with tempfile.TemporaryDirectory() as folder:
            database=self.history(folder)
            withhold_retired(database,Lookup(answered=()))
            after={row['id']:row for row in self.rows(database)}
            self.assertEqual(after[2]['content'],USER_WITHHELD+marker(PRIVATE))
            self.assertEqual((after[4]['content'],after[8]['content']),(TOOL_WITHHELD,TOOL_WITHHELD),
                             'tool work for and results citing the retired message are withheld')
            self.assertEqual(after[5]['content'],'Noted, your kite is '+FACT+'.','an unretired reply remains its own source')
            self.assertIsNone(after[5]['reasoning'])
            self.assertEqual(after[9]['content'],'It is '+FACT+'.')

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
            self.assertEqual(withhold_retired(database,Lookup(answered=()),notes),6+4,'six history rows and four note entries')
            self.assertEqual(self.entries(notes,'MEMORY.md'),[rain],'the retired turn\'s memory write and a citing entry are removed')
            self.assertEqual(self.entries(notes,'USER.md'),['Prefers Persian replies'])
            self.assertEqual((notes/'MEMORY.md.bak.1700000000').read_text(),'','Hermes\' drift backup is a copy too')
            self.assertFalse([path for path in notes.iterdir() if path.name.startswith('.mem_')])
            # A note written after the last check is checked on the next turn without rereading history.
            (notes/'MEMORY.md').write_text(NOTE_DELIMITER.join([rain,'Kite again (nocheh:event:'+PRIVATE+')']))
            lookup=Lookup(answered=())
            self.assertEqual(withhold_retired(database,lookup,notes),1)
            self.assertEqual(self.entries(notes,'MEMORY.md'),[rain]);self.assertEqual(lookup.calls,[[PRIVATE,UNRELATED]])

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
