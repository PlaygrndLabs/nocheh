import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.provider import monitoring


class MonitoringTests(unittest.TestCase):
    def test_a_failed_calls_exact_error_reaches_health_and_the_notice_from_the_usage_tracker(self):
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as state:
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            usage.record('memory_review', {'calls': 1}, 'synthetic-model', failed=True, reason='provider_error', cause='overloaded:529',
                         provider='anthropic', path=path, now=now.timestamp())
            usage.record('memory_review', {'calls': 1}, 'synthetic-model', provider='anthropic', path=path, now=now.timestamp())
            rows = monitoring.model_problems(state, now)
        self.assertEqual((rows[0]['causes'], rows[0]['why']), ({'provider_error:overloaded:529': 1}, '1 the provider was overloaded (HTTP 529)'))
        found = [problem for problem in problems.problems({}, rows, '2026-10-13') if problem['kind'] == 'model']
        self.assertEqual(problems.text(found[0], 1),
                         'Memory notes (synthetic-model): 1 model call failed today: 1 the provider was overloaded (HTTP 529).')
        self.assertEqual(found[0]['ok'], 1, 'the call that worked, so the notice can say when the model works again')

    def test_files_a_reader_could_not_write_reach_health_and_the_notice_as_one_line_each(self):
        import sqlite3
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as state:
            self.assertEqual(monitoring.reader_problems(state, now), [], 'like model calls, no tracker yet is nothing counted')
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            old = sqlite3.connect(str(path))
            old.execute(usage.SCHEMA)
            old.close()
            self.assertEqual(monitoring.reader_problems(state, now), [], 'a tracker from before the readers were counted')
            for failure in ('temp_full', 'temp_full', 'read_only'):
                usage.reader_failed('image', failure, path=path, now=now.timestamp())
            usage.reader_done('image', path=path, now=now.timestamp())
            usage.reader_done('voice', path=path, now=now.timestamp())
            usage.reader_failed('document', 'temp_full', path=path, now=now.timestamp() - 86400)
            rows = monitoring.reader_problems(state, now)
            models = monitoring.model_problems(state, now)
        self.assertEqual(rows, [{'day': '2026-10-13', 'reader': 'image', 'label': 'Images', 'failure': 'temp_full', 'failed': 2, 'ok': 1},
                                {'day': '2026-10-13', 'reader': 'image', 'label': 'Images', 'failure': 'read_only', 'failed': 1, 'ok': 1}],
                         'only today, only failures, and a reader with none has no row')
        self.assertEqual(models, [], 'no model call')
        found = problems.problems({'reader_problems': rows}, models, '2026-10-13')
        self.assertEqual([(problem['kind'], problem['count'], problem['ok']) for problem in found], [('reader', 2, 1), ('reader', 1, 1)])
        self.assertEqual(problems.text(found[1], 1),
                         'Images: 1 image couldn’t be read today because Hermes’s locked-down container refused a file write. '
                         'The originals are kept: Make a new version on a message’s page reads one again.')

    def test_notes_whose_source_was_not_recorded_and_memory_read_in_part_reach_the_notice(self):
        # ADR-0257: every failed step of telling where notes came from is one count, and each kind is one line.
        import sqlite3
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as state:
            self.assertEqual(monitoring.note_problems(state, now), [], 'no tracker yet is nothing counted')
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            old = sqlite3.connect(str(path))
            old.execute(usage.SCHEMA)
            old.close()
            self.assertEqual(monitoring.note_problems(state, now), [], 'a tracker from before notes were counted')
            for kind in ('lookup', 'lookup', 'record', 'restore'):
                usage.note_failed(kind, path=path, now=now.timestamp())
            usage.note_done('lookup', path=path, now=now.timestamp())
            usage.note_failed('memory_read', path=path, now=now.timestamp())
            usage.note_done('memory_read', path=path, now=now.timestamp())
            usage.note_done('memory_read', path=path, now=now.timestamp())
            usage.note_failed('read', path=path, now=now.timestamp() - 86400)
            usage.note_failed('elsewhere', path=path, now=now.timestamp())
            rows = monitoring.note_problems(state, now)
        self.assertEqual(rows, [{'day': '2026-10-13', 'kind': 'notes', 'failed': 4, 'ok': 1},
                                {'day': '2026-10-13', 'kind': 'memory_read', 'failed': 1, 'ok': 2}])
        found = problems.problems({'note_problems': rows}, [], '2026-10-13')
        self.assertEqual([(problem['kind'], problem['count'], problem['ok']) for problem in found], [('notes', 4, 1), ('memory_read', 1, 2)])
        # Each failed step counts, not each note, so a failure that comes back grows the count and reopens the line.
        self.assertEqual(problems.text(found[0], 1),
                         'Memory labels: telling where notes came from failed 4 times today. Notes written while it failed show '
                         '“Source not recorded” or a less exact source, and replies may have seen “source not available”. '
                         'The notes themselves are kept.')
        self.assertTrue(problems.text(dict(found[0], count=1), 1).startswith('Memory labels: telling where notes came from failed 1 time today.'))
        self.assertEqual(problems.text(found[1], 1),
                         'Long-term memory: Nocheh couldn’t read memory from your forwards and files, or your memory context, 1 time today; '
                         'replies used the rest of your memory.')
        self.assertIn('notes', problems.readable({'note_problems': rows}))
        # The stores count labelling notes and recall's ask of the owner's forwards and files, which Hermes never sees.
        stores = {'memory_problems': [{'day': '2026-10-13', 'kind': 'notes', 'done': 3, 'failed': 2},
                                      {'day': '2026-10-13', 'kind': 'memory_read', 'done': 1, 'failed': 1},
                                      {'day': '2026-10-12', 'kind': 'notes', 'done': 0, 'failed': 9},
                                      {'day': '2026-10-13', 'kind': 'elsewhere', 'done': 0, 'failed': 9},
                                      {'day': '2026-10-13', 'kind': 'notes', 'done': '1', 'failed': 1}]}
        with tempfile.TemporaryDirectory() as state:
            self.assertEqual(monitoring.note_problems(state, now, archive=stores),
                             [{'day': '2026-10-13', 'kind': 'note_labels', 'failed': 2, 'ok': 3},
                              {'day': '2026-10-13', 'kind': 'forwards_read', 'failed': 1, 'ok': 1}],
                             'the stores alone are counted with no tracker yet')
            self.assertEqual(monitoring.note_problems(state, now, archive={'unavailable': True}), [], 'stores unreachable')
            # Hermes's own steps and the stores' are lines of their own, each with only its own steps that worked.
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            usage.note_failed('read', path=path, now=now.timestamp())
            usage.note_done('record', path=path, now=now.timestamp())
            self.assertEqual(monitoring.note_problems(state, now, archive=stores),
                             [{'day': '2026-10-13', 'kind': 'notes', 'failed': 1, 'ok': 1},
                              {'day': '2026-10-13', 'kind': 'note_labels', 'failed': 2, 'ok': 3},
                              {'day': '2026-10-13', 'kind': 'forwards_read', 'failed': 1, 'ok': 1}])
            found = problems.problems({'note_problems': monitoring.note_problems(state, now, archive=stores)}, [], '2026-10-13')
            self.assertEqual([problems.text(problem, 1) for problem in found if problem['kind'] in ('note_labels', 'forwards_read')], [
                'Memory labels: looking up where notes came from failed 2 times today. Recall and the Notes page showed those '
                'notes as “source not available right now” or without their chat, and replies may have seen them without their '
                'chat. The notes and what was recorded about them are kept.',
                'Long-term memory: recall couldn’t ask your forwards and files 1 time today; it answered from the rest of your memory.'])

    def test_source_tags_the_stores_could_not_build_are_a_notice_line_of_their_own(self):
        """ADR-0261: a search hit or an opened original whose source tag could not be built read "source not available
        right now"; the stores count it as `source_tags`, a line apart from note labels."""
        from datetime import datetime, timezone
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        stores = {'memory_problems': [{'day': '2026-10-13', 'kind': 'source_tags', 'done': 1, 'failed': 3},
                                      {'day': '2026-10-13', 'kind': 'notes', 'done': 0, 'failed': 1}]}
        with tempfile.TemporaryDirectory() as state:
            rows = monitoring.note_problems(state, now, archive=stores)
        self.assertEqual(rows, [{'day': '2026-10-13', 'kind': 'note_labels', 'failed': 1, 'ok': 0},
                                {'day': '2026-10-13', 'kind': 'source_tags', 'failed': 3, 'ok': 1}])
        found = [problem for problem in problems.problems({'note_problems': rows}, [], '2026-10-13') if problem['kind'] == 'source_tags']
        self.assertEqual([problems.text(problem, 1) for problem in found], [
            'Memory labels: labelling where facts and search results came from failed 3 times today; those showed '
            '“source not available right now”. The messages and what was learned from them are kept.'])
        self.assertEqual(found[0]['ok'], 1, 'tags built after the failure, so the notice can say when labelling works again')
        self.assertIn('store_notes', problems.readable({'note_problems': rows, 'archive': stores}))

    def test_note_refs_the_stores_could_not_keep_are_a_notice_line_of_their_own(self):
        """ADR-0261: a turn's note refs that could not be kept leave its notes labelled but not openable by ref; the stores
        count it as `note_refs`, never as a note labels failure, whose line says the labels failed."""
        from datetime import datetime, timezone
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        stores = {'memory_problems': [{'day': '2026-10-13', 'kind': 'note_refs', 'done': 0, 'failed': 2}]}
        with tempfile.TemporaryDirectory() as state:
            rows = monitoring.note_problems(state, now, archive=stores)
        self.assertEqual(rows, [{'day': '2026-10-13', 'kind': 'note_refs', 'failed': 2, 'ok': 0}])
        found = [problem for problem in problems.problems({'note_problems': rows}, [], '2026-10-13') if problem['kind'] == 'note_refs']
        self.assertEqual([problems.text(problem, 1) for problem in found], [
            'Memory labels: note refs couldn’t be kept 2 times today; those notes went out with their sources named but could '
            'not be opened by ref. The notes are kept.'])
        self.assertIn('store_notes', problems.readable({'note_problems': rows, 'archive': stores}))

    def test_a_stores_step_that_works_after_its_failure_says_working_again(self):
        # ADR-0257: the stores write a step that worked only once their day holds a failure of its kind, so steady use
        # writes nothing. The merged line still clears on a step that works after the failure, and reopens on the next.
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now, day = datetime(2026, 10, 13, 12, tzinfo=timezone.utc), '2026-10-13'
        with tempfile.TemporaryDirectory() as state:
            def current(done, failed):
                rows = monitoring.note_problems(state, now, archive={'memory_problems': [{'day': day, 'kind': 'memory_read', 'done': done, 'failed': failed}]})
                return {problem['key']: problem for problem in problems.problems({'note_problems': rows}, [], day)}
            watch = problems._watch(current(0, 1)['forwards_read:' + day], 1)
            self.assertFalse(problems.cleared(watch, current(0, 1), set()), 'nothing has worked since')
            self.assertTrue(problems.cleared(watch, current(1, 1), set()), 'a step that worked after the failure')
            self.assertTrue(problems.back(watch, current(1, 2), set(), set()), 'a failure after it reopens the line')
            # A failure on Hermes's side alone is cleared only by Hermes's own steps: the stores write nothing that day.
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            usage.note_failed('lookup', path=path, now=now.timestamp())
            rows = monitoring.note_problems(state, now, archive={'memory_problems': []})
            hermes = problems._watch(problems.problems({'note_problems': rows}, [], day)[0], 1)
            self.assertFalse(problems.cleared(hermes, {problem['key']: problem for problem in problems.problems({'note_problems': rows}, [], day)}, set()))
            usage.note_done('lookup', path=path, now=now.timestamp())
            rows = monitoring.note_problems(state, now, archive={'memory_problems': []})
            self.assertTrue(problems.cleared(hermes, {problem['key']: problem for problem in problems.problems({'note_problems': rows}, [], day)}, set()))

    def test_status_reads_the_stores_label_failures_into_the_notes_line(self):
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        def call(route, timeout=None):
            if route != '/v1/status':
                raise ConnectionError('down')
            return {'archive': {}, 'memory_problems': [{'day': today, 'kind': 'notes', 'done': 5, 'failed': 2}]}
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            path = state / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            usage.note_failed('lookup', path=path)
            with patch.object(monitoring, 'load', return_value={}), patch.object(monitoring, 'compose', return_value=(['docker'], {})),\
                 patch.object(monitoring.subprocess, 'check_output', return_value=''), patch.object(monitoring, 'API') as api:
                api.return_value.call.side_effect = call
                result = monitoring.status(state)
        self.assertEqual(result['note_problems'], [{'day': today, 'kind': 'notes', 'failed': 1, 'ok': 0},
                                                   {'day': today, 'kind': 'note_labels', 'failed': 2, 'ok': 5}])
        found = problems.problems(result, [], today)
        self.assertEqual([(problem['kind'], problem['count']) for problem in found if problem['kind'] in ('notes', 'note_labels')],
                         [('notes', 1), ('note_labels', 2)])
        self.assertTrue({'notes', 'store_notes'} <= problems.readable(result))
        self.assertNotIn('store_notes', problems.readable({**result, 'archive': {'unavailable': True}}),
                         'the stores\' lines clear only on a check that read their counts')

    def test_a_step_that_works_on_one_side_never_clears_the_other_sides_failure(self):
        # Hermes and the stores count their own steps; each line clears only on its own side's step that worked.
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now, day = datetime(2026, 10, 13, 12, tzinfo=timezone.utc), '2026-10-13'
        with tempfile.TemporaryDirectory() as state:
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            def current(stores):
                rows = monitoring.note_problems(state, now, archive={'memory_problems': stores})
                return {problem['key']: problem for problem in problems.problems({'note_problems': rows}, [], day)}
            # A label lookup in the stores failed, then a Notes-page poll worked: its line clears.
            stores = [{'day': day, 'kind': 'notes', 'done': 0, 'failed': 1}]
            labels = problems._watch(current(stores)['note_labels:' + day], 1)
            stores[0]['done'] = 1
            self.assertTrue(problems.cleared(labels, current(stores), set()))
            # Hermes's sidecar breaks: its own line, which the stores' next poll that works does not clear.
            usage.note_failed('sidecar', path=path, now=now.timestamp())
            self.assertEqual({key for key in current(stores) if key.startswith(('notes:', 'note_labels:'))}, {'notes:' + day, 'note_labels:' + day})
            hermes = problems._watch(current(stores)['notes:' + day], 1)
            stores[0]['done'] = 2
            self.assertFalse(problems.cleared(hermes, current(stores), set()), 'the stores worked; Hermes still fails')
            self.assertFalse(problems.back(labels, current(stores), set(), set()), 'nor does Hermes reopen the stores\' line')
            usage.note_done('lookup', path=path, now=now.timestamp())
            self.assertTrue(problems.cleared(hermes, current(stores), set()), 'Hermes worked again')
            # Recall's ask of the forwards keeps failing in the stores while Hermes's turns read memory in full.
            asks = [{'day': day, 'kind': 'memory_read', 'done': 0, 'failed': 3}]
            forwards = problems._watch(current(asks)['forwards_read:' + day], 3)
            usage.note_failed('memory_read', path=path, now=now.timestamp())
            usage.note_done('memory_read', path=path, now=now.timestamp())
            self.assertFalse(problems.cleared(forwards, current(asks), set()), 'a turn read memory; recall\'s ask still fails')
            asks[0]['done'] = 1
            self.assertTrue(problems.cleared(forwards, current(asks), set()))

    def test_github_flags_come_from_the_app_file_without_its_key(self):
        from tools.operations.connections import secret_file
        pem='-----BEGIN RSA PRIVATE KEY-----\nMONITOR'+'x'*40+'\n-----END RSA PRIVATE KEY-----\n'
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with secret_file.locked(state,'github'):
                secret_file.write(state,'github',{'app':{'id':7,'slug':'nocheh-example','name':'Nocheh-example','account':'octo-example',
                                                         'account_type':'User','pem':pem,'connected_at':1},'reconnect':False,'listed':[],'listed_at':1})
            with patch.object(monitoring,'load',return_value={}),patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value=''),patch.object(monitoring.API,'call',side_effect=ConnectionError('down')):
                result=monitoring.status(state)
            self.assertEqual(result['github'],{'connected':True,'reconnect':False})
            self.assertNotIn('MONITOR',json.dumps(result))
            secret_file.path(state,'github').unlink()
            self.assertEqual(monitoring.github_flags(state),{'connected':False,'reconnect':False})

    def test_backups_reach_health_as_counts_and_codes_without_names(self):
        from tools.operations.installation import backup_schedule
        from tools.operations.installation.configuration import DEFAULTS
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            backup_schedule.record_backup(state,'running')
            backup_schedule.record_backup(state,'failed',error='backup_unsupported_link',path='hermes/private-name')
            with patch.object(monitoring,'load',return_value=dict(DEFAULTS)),patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value=''),patch.object(monitoring.API,'call',side_effect=ConnectionError('down')):
                result=monitoring.status(state)
        self.assertEqual((result['backups']['failed'],result['backups']['reason']),(1,'backup_unsupported_link'))
        self.assertNotIn('private-name',json.dumps(result))


    def test_partial_outage_retains_model_routes_and_safe_telegram_incident(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'telegram').mkdir();(state/'hermes').mkdir()
            # Hermes no longer polls: an incident it left behind is not the bot's.
            (state/'hermes/telegram-incident.json').write_text(json.dumps({'state':'failed','error_code':'invalid_token',
                'recorded_at':'2026-09-10T07:04:41Z'}))
            (state/'telegram/telegram-incident.json').write_text(json.dumps({'state':'failed','error_code':'telegram_network_error',
                'error_message':'private token must stay out','recorded_at':'2026-09-11T07:04:41Z'}))
            config={'TELEGRAM_ENABLED':'true','NOCHEH_PROVIDERS':json.dumps([{'id':'gateway','name':'Synthetic gateway','url':'https://gateway.example.test/v1'}]),
                    'NOCHEH_PROVIDER_KEYS':'{"gateway":"private-key"}','NOCHEH_REPLY_PROVIDER':'gateway','NOCHEH_MODEL':'synthetic-model',
                    'SERVICE_TOKEN':'private-service-token','AGENT_KEY':'private-agent-key-not-a-real-credential'}
            with patch.object(monitoring,'load',return_value=config),\
                 patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value='{"Service":"nocheh-telegram","State":"running","Health":"healthy"}\n'),\
                 patch.object(monitoring.API,'call',side_effect=ConnectionError('private failure')):
                result=monitoring.status(state)
            self.assertEqual(result['archive'],{'unavailable':True})
            routes={row['part']:row for row in result['routes']}
            self.assertEqual((routes['reply']['provider_name'],routes['reply']['model'],routes['reply']['configured']),('Synthetic gateway','synthetic-model',True))
            self.assertEqual((routes['memory']['provider'],routes['memory']['configured']),('',False))
            self.assertEqual(routes['embedding']['provider'],'openai')
            self.assertEqual(result['telegram_incident'],{'at':'2026-09-11T07:04:41Z','error_code':'telegram_network_error'})
            keys={row['name']:row for row in result['keys']}
            self.assertEqual((keys['SERVICE_TOKEN']['service'],keys['SERVICE_TOKEN']['present']),('Nocheh services',True))
            self.assertFalse(keys['INNGEST_SIGNING_KEY']['present'])
            # The agent login and Hermes's session token are listed by holder, never by value (ADR-0295).
            self.assertEqual((keys['AGENT_KEY']['service'],keys['AGENT_KEY']['present']),('Agent (Hermes)',True))
            self.assertEqual((keys['NOCHEH_HERMES_SESSION_TOKEN']['service'],keys['NOCHEH_HERMES_SESSION_TOKEN']['present']),('Hermes dashboard',False))
            self.assertIn('never given to the agent',keys['SERVICE_TOKEN']['usage'])
            self.assertTrue(all(row['usage'] for row in result['keys']))
            self.assertNotIn('private',json.dumps(result))
