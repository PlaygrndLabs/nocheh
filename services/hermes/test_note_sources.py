import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import note_sources as sources
from .note_sources import key

REVIEW,OTHER,EVENT='a'*64,'b'*64,'c'*64
FORWARD={'by':'review','review':OTHER}
DAY=1_794_096_000  # 2026-11-08 UTC


def write(profile,memory=(),user=()):
    notes=Path(profile)/'memories';notes.mkdir(parents=True,exist_ok=True)
    (notes/'MEMORY.md').write_text('\n§\n'.join(memory));(notes/'USER.md').write_text('\n§\n'.join(user))


def stored(profile):
    return json.loads((Path(profile)/sources.SIDECAR).read_text())


class Counted:
    """The steps counted for the owner's notice, as (kind, done or failed)."""
    def __enter__(self):
        self.seen=[]
        self.patches=[patch('services.hermes.usage.note_done',lambda kind,*a,**k:self.seen.append((kind,'done'))),
                      patch('services.hermes.usage.note_failed',lambda kind,*a,**k:self.seen.append((kind,'failed')))]
        for item in self.patches:item.start()
        return self.seen
    def __exit__(self,*args):
        for item in self.patches:item.stop()


class RecordTests(unittest.TestCase):
    def test_the_record_lives_outside_every_folder_a_turn_can_write(self):
        from .isolated_profile import DATA_DIRS
        self.assertNotIn(sources.SIDECAR,DATA_DIRS)
        self.assertFalse(any(sources.SIDECAR.startswith(name+'/') for name in DATA_DIRS))

    def test_a_run_records_the_notes_it_added_by_their_text_and_drops_those_gone(self):
        with tempfile.TemporaryDirectory() as folder:
            write(folder,['Kept note.','Gone note.'])
            before=sources.entries(folder)
            sources.save(folder,{key('memory','Kept note.'):{'origins':[FORWARD],'more':0,'at':'2026-11-01'},
                                 key('memory','Gone note.'):{'origins':[FORWARD],'more':0,'at':'2026-11-01'}})
            write(folder,['Kept note.','New note.'],['About Alice.'])
            with Counted() as seen:
                self.assertEqual(sources.record(folder,before,sources.entries(folder),{'by':'review','review':REVIEW},ops=[],now=DAY),2)
            self.assertEqual(seen,[('record','done')])
            entries=stored(folder)['entries']
            self.assertEqual(set(entries),{key('memory','Kept note.'),key('memory','New note.'),key('user','About Alice.')})
            self.assertEqual(entries[key('memory','Kept note.')]['origins'],[FORWARD])
            self.assertEqual(entries[key('memory','New note.')],{'origins':[{'by':'review','review':REVIEW}],'more':0,'at':'2026-11-08'})
            # The same text in the other file is another note.
            self.assertNotEqual(key('memory','About Alice.'),key('user','About Alice.'))

    def test_a_note_rewritten_through_its_operation_keeps_the_sources_it_had(self):
        old='Alice forwarded: the meeting moved to Tuesday at the office.'
        for op,made in (({'action':'replace','target':'memory','old_text':'meeting moved','content':'Meeting is Tuesday.'},'Meeting is Tuesday.'),
                        ({'action':'patch','target':'memory','old_text':'at the office','content':'online'},'Alice forwarded: the meeting moved to Tuesday online.')):
            with self.subTest(action=op['action']),tempfile.TemporaryDirectory() as folder:
                records={key('memory',old):{'origins':[FORWARD],'more':0,'at':None}}
                found=sources.inherited({'memory':[old,'Other note.'],'user':[]},{'memory':[made,'Other note.'],'user':[]},records,[op])
                self.assertEqual(found,{key('memory',made):[FORWARD]})

    def test_without_the_operations_every_removed_note_passes_its_sources_on(self):
        records={key('memory','Old one.'):{'origins':[FORWARD],'more':0,'at':None}}
        found=sources.inherited({'memory':['Old one.','Stays.'],'user':[]},{'memory':['Stays.','Fresh one.'],'user':[]},records,None)
        self.assertEqual(found,{key('memory','Fresh one.'):[FORWARD]})
        # A removed note with no record passes on not recorded.
        found=sources.inherited({'memory':['Old one.'],'user':[]},{'memory':['Fresh one.'],'user':[]},{},None)
        self.assertEqual(found,{key('memory','Fresh one.'):[{'by':'unknown'}]})

    def test_rewording_a_note_without_an_operation_does_not_wash_its_source_away(self):
        # An added note that shares a long run of text, a distinctive token or its whole text with an earlier note keeps
        # that note's sources, unless the earlier note reads as the owner's own.
        forwarded='Alice says the new office door code works from Monday onwards for everyone.'
        records={key('memory',forwarded):{'origins':[FORWARD],'more':0,'at':None},
                 key('memory','Contact bob.example@mail.test about it.'):{'origins':[FORWARD],'more':0,'at':None},
                 key('memory','Owner likes the code works from Monday onwards for everyone.'):{'origins':[{'by':'review','review':REVIEW}],'more':0,'at':None}}
        before={'memory':[forwarded,'Contact bob.example@mail.test about it.','Owner likes the code works from Monday onwards for everyone.'],'user':['Moved here.']}
        cases=[('THE CODE WORKS FROM MONDAY ONWARDS FOR EVERYONE, per a note.',[FORWARD]),
               ('Write to bob.example@mail.test first.',[FORWARD]),
               ('A short new fact.',[])]
        for text,expected in cases:
            with self.subTest(text=text):
                found=sources.inherited(before,{**before,'memory':[*before['memory'],text]},records,[],trusted=frozenset({key('memory',before['memory'][2])}))
                self.assertEqual(found,{key('memory',text):expected})
        # A short note moved whole to the other file, in other case and spacing, is still that note.
        found=sources.inherited({'memory':['Short one.'],'user':[]},{'memory':[],'user':['short  ONE.']},{key('memory','Short one.'):{'origins':[FORWARD],'more':0,'at':None}},[])
        self.assertEqual(found,{key('user','short  ONE.'):[FORWARD]})

    def test_a_note_keeps_ten_sources_and_counts_the_rest_as_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            many=['Old note number %d with words.'%i for i in range(12)]
            write(folder,many)
            sources.save(folder,{key('memory',text):{'origins':[{'by':'review','review':('%02x'%(i+16))*32}],'more':0,'at':None} for i,text in enumerate(many)})
            before=sources.entries(folder);write(folder,['One merged note.'])
            sources.record(folder,before,sources.entries(folder),{'by':'review','review':REVIEW},ops=None,now=DAY)
            entry=stored(folder)['entries'][key('memory','One merged note.')]
            self.assertEqual(len(entry['origins']),10);self.assertEqual(entry['more'],3)
            self.assertEqual(entry['origins'][0],{'by':'review','review':REVIEW})
            records=sources.load(folder)
            self.assertEqual(sources.note(records,'memory','One merged note.')['more'],3)
            self.assertEqual(sources._origins(records,key('memory','One merged note.'))[-1],{'by':'unknown'})

    def test_a_note_that_could_not_be_read_before_or_after_is_not_recorded(self):
        with tempfile.TemporaryDirectory() as folder:
            write(folder,['Note.'])
            with Counted() as seen:
                self.assertEqual(sources.record(folder,None,sources.entries(folder),{'by':'review','review':REVIEW}),0)
            self.assertEqual(seen,[('read','failed')])
            self.assertFalse((Path(folder)/sources.SIDECAR).exists())
            # Hermes's own strict reading: bytes that are not UTF-8 make the file unreadable.
            (Path(folder)/'memories'/'USER.md').write_bytes(b'\xff\xfe broken')
            self.assertIsNone(sources.entries(folder))

    def test_a_sidecar_that_is_not_one_reads_as_no_records_and_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/sources.SIDECAR
            good={'origins':[{'by':'turn','event':EVENT,'channel':'telegram','at':'2026-11-08','reads':['forward'],'complete':True}],'more':0,'at':'2026-11-08'}
            path.write_text(json.dumps({'version':1,'entries':{key('memory','a'):good,'short':good,
                key('memory','b'):{'origins':[{'by':'review','review':REVIEW,'note':'extra'}],'more':0},
                key('memory','c'):{'origins':[{'by':'turn','event':EVENT,'channel':'email','at':'2026-11-08','reads':[],'complete':True}]},
                key('memory','d'):{'origins':[{'by':'turn','event':EVENT,'channel':'telegram','at':'2026-11-08','reads':['owner'],'complete':True}]},
                key('memory','e'):{'origins':[],'more':0}}}))
            self.assertEqual(sources.load(folder),{key('memory','a'):good})
            for value in ('[]','{"version":2,"entries":{}}','not json'):
                path.write_text(value)
                with Counted() as seen:self.assertEqual(sources.load(folder),{})
                self.assertEqual(seen,[('sidecar','failed')])
            path.unlink();(Path(folder)/'elsewhere.json').write_text(json.dumps({'version':1,'entries':{}}))
            path.symlink_to(Path(folder)/'elsewhere.json')
            with Counted() as seen:self.assertEqual(sources.load(folder),{})
            self.assertEqual(seen,[('sidecar','failed')])
            with self.assertRaises(ValueError):sources.save(folder,{})


class LookupTests(unittest.TestCase):
    def test_storage_labels_the_notes_in_batches_with_the_profile_chat(self):
        with tempfile.TemporaryDirectory() as folder:
            texts=['Note %d.'%i for i in range(60)]
            write(folder,texts,['About Alice. nocheh:event:'+EVENT])
            sent=[]
            def post(body):
                sent.append(body)
                return {item['key']:{'from':'nocheh','label':'Nocheh\'s note'} for item in body['notes']}
            with Counted() as seen:labels=sources.lookup(folder,sources.entries(folder),'chat-family',post)
            self.assertEqual([len(body['notes']) for body in sent],[50,11]);self.assertEqual({body['space'] for body in sent},{'chat-family'})
            self.assertEqual(len(labels),61);self.assertEqual(seen,[('lookup','done')])
            user=next(item for body in sent for item in body['notes'] if item['key']==key('user','About Alice. nocheh:event:'+EVENT))
            self.assertEqual(user,{'key':key('user','About Alice. nocheh:event:'+EVENT),'origins':[{'by':'unknown'}],'more':0,'cites':[EVENT]})

    def test_a_failed_or_odd_answer_never_labels_a_note_as_anyones(self):
        with tempfile.TemporaryDirectory() as folder:
            write(folder,['First.','Second.','Third.'])
            found=sources.entries(folder)
            def broken(body):raise OSError('down')
            with Counted() as seen:labels=sources.lookup(folder,found,None,broken)
            self.assertEqual(set(map(json.dumps,labels.values())),{json.dumps(sources.UNAVAILABLE)});self.assertEqual(seen,[('lookup','failed')])
            odd={key('memory','First.'):{'from':'owner','label':'bad line'},key('memory','Second.'):{'from':'everyone','label':'x'},
                 key('memory','Third.'):{'from':'owner','label':'the owner\'s own messages','extra':1}}
            labels=sources.lookup(folder,found,None,lambda body:odd)
            self.assertEqual(labels[key('memory','First.')],sources.UNAVAILABLE);self.assertEqual(labels[key('memory','Second.')],sources.UNAVAILABLE)
            self.assertEqual(labels[key('memory','Third.')],{'from':'owner','label':'the owner\'s own messages'})

    def test_a_note_citing_many_messages_says_it_cites_more(self):
        cites=[('%02x'%i)*32 for i in range(25)]
        value=sources.note({},'memory',' '.join('nocheh:event:'+cite for cite in cites))
        self.assertEqual(len(value['cites']),20);self.assertTrue(value['more_cites'])


SCHEMA='''CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
 tool_calls TEXT, tool_name TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0, timestamp REAL NOT NULL DEFAULT 0);'''


def memory_call(**arguments):
    return json.dumps([{'id':'call','type':'function','function':{'name':'memory','arguments':json.dumps(arguments)}}])


class TurnTests(unittest.TestCase):
    def database(self,folder,rows):
        path=Path(folder)/'native-state'/'state.db';path.parent.mkdir(parents=True,exist_ok=True)
        connection=sqlite3.connect(path);connection.executescript(SCHEMA)
        for row in rows:connection.execute('INSERT INTO messages(session_id,role,content,tool_calls,tool_name,_compressed_summary) VALUES(?,?,?,?,?,?)',
                                           (row.get('session','s'),row['role'],row.get('content'),row.get('tool_calls'),row.get('tool_name'),row.get('summary',0)))
        connection.commit();connection.close();return path

    def test_a_turn_reads_what_its_tools_returned_before_its_last_memory_call(self):
        with tempfile.TemporaryDirectory() as folder:
            path=self.database(folder,[
                {'role':'user','content':'[Archived attachment: report.pdf] old turn before the compaction'},
                {'role':'user','content':'summary','summary':1},
                {'role':'user','content':'[Forwarded: from a channel] earlier in this session'},
                {'role':'user','content':'[Recent messages in this group] another session','session':'other'}])
            last=sources.last_message(path)
            connection=sqlite3.connect(path)
            for role,content,calls,name in (('user','current request',None,None),
                    ('tool','hits','', 'mcp__nocheh__archive_search'),('tool','memory','', 'mcp__nocheh__memory_search'),
                    ('tool','tasks','','mcp__nocheh__tasks'),('tool','page','','web_extract'),
                    ('assistant','',memory_call(action='replace',target='user',old_text='old',content='new'),None),
                    ('tool','after the last memory call','','mcp__nocheh__notion'),('assistant','done',None,None)):
                connection.execute('INSERT INTO messages(session_id,role,content,tool_calls,tool_name) VALUES(?,?,?,?,?)',('s',role,content,calls,name))
            connection.commit();connection.close()
            reads,ops,ok=sources.turn_reads(path,'s',last,{'files':[{'kind':'document'}]})
            self.assertTrue(ok)
            self.assertEqual(reads,['file','forward','archive','other'])
            self.assertEqual(ops,[{'action':'replace','target':'user','old_text':'old','content':'new'}])
            # A turn whose newest message could not be read before reads as incomplete.
            self.assertEqual(sources.turn_reads(path,'s',None,{}),([],None,False))

    def test_a_turn_origin_names_its_message_channel_day_and_reads(self):
        origin=sources.turn_origin({'event_id':EVENT,'channel':'browser'},['web','owner','past'],True,now=DAY)
        self.assertEqual(origin,{'by':'turn','event':EVENT,'channel':'browser','at':'2026-11-08','reads':['web','past'],'complete':True})
        self.assertTrue(sources.valid(origin))
        self.assertEqual(sources.turn_origin({'event_id':'not-an-id'},[],True),{'by':'unknown'})
        self.assertEqual(sources.turn_origin({'event_id':EVENT,'channel':'email'},[],True),{'by':'unknown'})

    def test_after_a_turn_its_new_note_is_recorded_and_a_failed_turn_is_incomplete(self):
        for result,complete in (({'state':'done'},True),({'state':'failed'},False),(None,False)):
            with self.subTest(result=result),tempfile.TemporaryDirectory() as folder:
                write(folder,['Old.']);self.database(folder,[])
                watch=sources.before(folder,'chat-family',Path(folder)/'native-state'/'state.db')
                self.assertEqual(watch['last'],0)
                write(folder,['Old.','Learned today.'])
                sources.after_turn(folder,{'event_id':EVENT,'channel':'telegram','forwarded':None},'s',watch,result)
                origin=stored(folder)['entries'][key('memory','Learned today.')]['origins'][0]
                self.assertEqual((origin['by'],origin['event'],origin['complete']),('turn',EVENT,complete))

    def test_a_run_that_could_not_take_the_lock_records_nothing_as_anyones(self):
        import fcntl
        with tempfile.TemporaryDirectory() as folder:
            write(folder,['Old.'])
            original=sources.held
            with open(Path(folder)/'.memory.lock','a') as other,Counted() as seen:
                fcntl.flock(other,fcntl.LOCK_EX)
                # A writer holds the notes lock past the wait.
                with patch.object(sources,'held',lambda profile,seconds=0:original(profile,0)),patch.object(sources,'lookup',return_value={}):
                    watch=sources.before(folder,'chat-family')
                self.assertIsNone(watch['before'])
                fcntl.flock(other,fcntl.LOCK_UN)
            self.assertIn(('lock','failed'),seen)
            write(folder,['Old.','New.'])
            with Counted() as seen:sources.after(folder,watch,{'by':'review','review':REVIEW},[])
            self.assertEqual(seen,[('read','failed')])
            self.assertFalse((Path(folder)/sources.SIDECAR).exists())



if __name__=='__main__':unittest.main()
