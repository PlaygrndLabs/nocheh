"""The full tester: one command that checks every side of Nocheh without the owner.

It starts a separate synthetic copy of Nocheh (its own Compose project, volumes
and internal networks; no published port except a localhost dashboard relay),
connects the real Hermes Telegram adapter to a fake Telegram, then plays the
owner, group members and strangers: private messages, group posts, replies,
reactions, button presses, imports and dashboard pages. Hermes, Honcho, Inngest
and the stores are the real services; Telegram and the model are fake, and the
model follows an explicit script, so results repeat and nothing is spent.

The owner allowed this copy to run beside the live installation. It never reads
the live state, credentials or volumes.

    python3 -m tools.acceptance.full_test [--build] [--only NAME ...] [--keep]

The images are the installation's own by default. On a development machine
those can be older than the checkout, because the development stack runs its
own source-watched images; --build first builds the checkout's images under
separate `:tester` tags, so the run tests the current code and the live
images stay as they are.

Reports go to data/acceptance/results/full-<time>/report.md and result.json.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from tools.acceptance.owner_dashboard import FIXTURE_PASSWORD
from tools.paths import ROOT

IMAGES = {'services': 'nocheh-services:local', 'management': 'nocheh-management:local', 'postgres': 'nocheh-store-postgres:local',
          'native': 'nocheh-hermes:local', 'honcho': 'nocheh-honcho:a92650bc'}
BROWSER_IMAGE = 'nocheh-tester-browser:local'

# Plain-English names for the report, by scenario.
TITLES = {
    'reply_during_polling_reconnect': 'Replies survive Telegram reconnecting',
    'ordinary_private': 'Private chat reply', 'edit_is_silent': 'Edited message gets no new reply',
    'reaction_is_silent': 'A reaction gets no reply', 'general_after_topics': 'General topic reply',
    'burst_in_order': 'Quick group messages answered in order', 'private_burst_in_order': 'Quick private messages answered in order',
    'long_reply_chunks': 'Long answers split into Telegram-sized parts', 'intentional_silence': 'Nocheh can choose not to answer',
    'empty_answer_is_not_silence': 'A blank model answer is retried', 'private_fact_and_search': 'Search finds a private fact',
    'owner_private_context': 'Private chat remembers what you said', 'group_cannot_see_private': 'Groups never see private facts',
    'owner_recall': 'Long-term memory recall works', 'secret_is_guarded': 'Secrets never reach the model',
    'document_reply': 'A PDF is kept and read', 'action_approval': 'Approval from the dashboard sends once',
    'action_denial': 'A rejected message is never sent', 'group_current_action': 'Group post in the same topic',
    'schedule_fires_and_waits_for_review': 'Scheduled job waits for approval', 'participant_not_permitted': 'Stranger in a group',
    'group_answers_only_when_addressed': 'Groups: answers only when addressed', 'unselected_group': 'Groups not selected stay silent',
    'retirement_hides_fact': 'Hidden message leaves search', 'voice_is_transcribed': 'Voice notes are turned into text', 'photo_is_read': 'Photos are read for their text',
    'owner_directory_lists_conversations': 'Your chat list', 'unparseable_update_does_not_wedge_polling': 'A broken update does not stop Telegram',
    'telegram_refresh_names': 'Group names refresh', 'owner_freedom_executes_owner_requests': 'Setting: your private requests run without approval',
    'launcher_stop_mid_turn': 'Stopping mid-answer recovers', 'deleted_topic': 'A deleted topic does not leak elsewhere',
    'polling_outage': 'Telegram outage recovers', 'lost_send_response': 'A lost Telegram answer is not sent twice',
    'blocked_private_then_recovery': 'Blocked bot recovers', 'restart_preserves_receipts': 'Restart sends nothing twice',
    'granted_participant': 'Allowing and removing a member', 'storage_report': 'Storage report', 'stage_timings': 'Reply timings',
    'group_members': 'Set up allowed members', 'group_name_addresses': 'Groups: calling Nocheh by name',
    'unaddressed_messages_reach_next_reply': 'Groups: unaddressed messages inform the next reply',
    'typing_shows_while_working': 'Typing shows while Nocheh works',
    'not_allowed_person_gets_fixed_reply': 'People not allowed get the fixed reply',
    'menu_shown_to_nobody': 'Nobody sees a command menu', 'stranger_in_private_gets_one_reply': 'A stranger in private: one fixed reply, nothing else',
    'owner_private_card_and_approve': 'Approval card in private chat, Approve button',
    'owner_private_card_reject': 'Approval card, Reject button', 'same_group_post_goes_right_away': 'Post in your own group needs no approval',
    'member_cross_group_card_in_origin': 'Member reviews their own message to another group',
    'owner_reviews_when_member_not_allowed_there': 'You review a member\'s message to a group they are not in',
    'owner_from_group_to_own_private_chat': 'From a group to your private chat, no approval',
    'owner_from_group_to_other_group': 'From one group to another, card in your private chat',
    'hidden_message_keeps_the_chat': 'Hide and unhide keep the conversation', 'reaction_keeps_group_name': 'A reaction keeps the group name',
    'learning_reaches_honcho': 'Learning reaches Honcho', 'inbox_never_asks_about_the_owner': 'Inbox: one card per new person, none for you',
    'import_with_topics_files_and_learning': 'Telegram import with topics, files and learning',
    'tasks_from_chat_with_reminder': 'Tasks from chat, reminder, status and done', 'tasks_not_in_unrelated_group': 'Tasks stay private in groups', 'chat_is_read_in_order': 'A chat is read in order',
    'defaults_keep_history_and_notion_off': 'Defaults: history kept, Notion off',
    'settings_apply_is_followed_to_the_end': 'Settings: Save and apply finish, and a reload keeps following',
    'memory_search_model_change_rebuilds_memory': 'Changing the memory search model rebuilds memory',
    'no_lingering_isolated_turns': 'Nothing left running afterwards', 'dashboard_pages': 'Every dashboard page opens',
}


# Images --build makes from the checkout: (role, tag, docker build options). Honcho
# stays the installation's own pinned build; Nocheh's Honcho code is mounted.
BUILDS = [('services', 'nocheh-services:tester', ['--target', 'runtime']),
          ('management', 'nocheh-management:tester', ['--target', 'management']),
          ('postgres', 'nocheh-store-postgres:tester', ['--target', 'store-postgres']),
          ('native', 'nocheh-hermes:tester', ['-f', 'deploy/hermes.Dockerfile',
                                               '--build-context', 'hermes_source=data/compat/upstreams/hermes-agent'])]


def build_images(log):
    """Build the checkout's images under tester tags; the live tags are never touched."""
    ids = ['--build-arg', 'LOCAL_UID='+str(os.getuid()), '--build-arg', 'LOCAL_GID='+str(os.getgid())]
    steps = [step('build_'+role, ['docker', 'build', '-t', tag]+options+ids+['.'], log) for role, tag, options in BUILDS]
    steps.append(step('build_browser', ['docker', 'build', '-t', BROWSER_IMAGE, '-f', 'deploy/acceptance/browser.Dockerfile', 'deploy/acceptance'], log))
    return steps, {role: tag for role, tag, _ in BUILDS}


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def step(name, command, log):
    started = time.monotonic()
    print(json.dumps({'step': name, 'started': True}), flush=True)
    with log.open('a') as output:
        output.write('\n== '+name+'\n')
        output.flush()
        code = subprocess.call(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    seconds = round(time.monotonic()-started, 1)
    print(json.dumps({'step': name, 'exit': code, 'seconds': seconds}), flush=True)
    return {'step': name, 'passed': code == 0, 'seconds': seconds}


def dashboard_pages(fixture, report):
    """Open every page in the tester's browser on the fixture network."""
    manifest = json.loads((fixture/'compose.json').read_text())
    network = manifest['networks']['default']['name']
    port = int(manifest['services']['nocheh-dashboard']['environment'].get('NOCHEH_DASHBOARD_PORT') or 8783)
    out = report/'dashboard'
    out.mkdir(mode=0o777, exist_ok=True)
    out.chmod(0o777)
    # Chromium's crash reporter needs a writable home; the image is otherwise read-only.
    result = subprocess.run(['docker', 'run', '--rm', '--network', network, '--read-only', '--tmpfs', '/tmp', '--shm-size', '256m',
                             '-e', 'HOME=/tmp', '-e', 'XDG_CONFIG_HOME=/tmp/.config', '-e', 'XDG_CACHE_HOME=/tmp/.cache',
                             '-v', str(ROOT/'tools/acceptance/dashboard_pages.mjs')+':/tester/dashboard_pages.mjs:ro', '-v', str(out)+':/out',
                             BROWSER_IMAGE, '/tester/dashboard_pages.mjs', 'nocheh-dashboard', str(port), '/out', FIXTURE_PASSWORD],
                            capture_output=True, text=True)
    pages = json.loads((out/'dashboard-pages.json').read_text()) if (out/'dashboard-pages.json').exists() else []
    return {'scenario': 'dashboard_pages', 'passed': result.returncode == 0 and bool(pages) and all(row['passed'] for row in pages),
            'failed_pages': [row for row in pages if not row['passed']], 'error': result.stderr[-1500:] if result.returncode else None}


def write_report(directory, steps, scenarios):
    passed = [row for row in scenarios if row.get('passed')]
    failed = [row for row in scenarios if not row.get('passed')]
    revision = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip() or 'unknown'
    lines = ['# Nocheh full test', '', 'Revision: '+revision,
             'Date: '+time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()), '',
             f'**{len(passed)} passed, {len(failed)} failed** out of {len(scenarios)} checks. Telegram and the model are fake; Hermes, Honcho and Inngest are real.', '']
    broken = [row for row in steps if not row['passed']]
    if broken:
        lines += ['Setup steps that failed: '+', '.join(row['step'] for row in broken), '']
    if failed:
        lines += ['## Failed', '']
        for row in failed:
            gate = row.get('failed_gate') or {}
            detail = row.get('error') or ''
            if row.get('failed_pages'):
                detail = '; '.join(page['route']+': '+(', '.join(page['problems'][:2]) or 'heading '+str(page['heading'])) for page in row['failed_pages'][:8])
            lines.append('- **'+TITLES.get(row['scenario'], row['scenario'])+'** (`'+row['scenario']+'`): '+str(detail)[:400]
                         + (' Observed: '+json.dumps({k: v for k, v in gate.items() if k != 'gate'}, ensure_ascii=False)[:300] if len(gate) > 1 else ''))
        lines.append('')
    lines += ['## Passed', '']
    lines += ['- '+TITLES.get(row['scenario'], row['scenario'])+(f" ({row['seconds']} s)" if row.get('seconds') else '') for row in passed]
    (directory/'report.md').write_text('\n'.join(lines)+'\n')
    (directory/'result.json').write_text(json.dumps({'passed': not failed and not broken, 'steps': steps, 'scenarios': scenarios}, indent=2, ensure_ascii=False)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--only', nargs='*', help='Run only these scenarios (names from the report)')
    parser.add_argument('--skip-existing', action='store_true', help='Run only the product scenarios, not the original simulator list')
    parser.add_argument('--directory', type=Path, help='Reuse a kept fixture instead of starting a new one')
    parser.add_argument('--keep', action='store_true', help='Leave the fixture running afterwards for diagnosis')
    parser.add_argument('--build', action='store_true', help='Build the checkout\'s images under :tester tags first and test those')
    for role, image in IMAGES.items():
        parser.add_argument('--'+role+'-image', default=image)
    args = parser.parse_args()
    from tools.acceptance.product_scenarios import PRODUCT_ORDER, ProductScenarios
    from tools.acceptance.telegram_scenarios import ORDER, run
    order = args.only or ([] if args.skip_existing else ORDER)+PRODUCT_ORDER
    steps, fresh = [], args.directory is None
    directory = (args.directory or ROOT/'data/acceptance/results'/('full-'+time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))).resolve()
    log = (directory.parent if fresh else directory)/(directory.name+'.log' if fresh else 'full-test.log')
    if fresh:
        directory.parent.mkdir(parents=True, exist_ok=True)
    if fresh and args.build:
        built, tags = build_images(log)
        steps += built
        for role, tag in tags.items():
            setattr(args, role+'_image', tag)
    if fresh and all(row['passed'] for row in steps):
        steps.append(step('start_synthetic_nocheh', [sys.executable, 'tools/acceptance/rehearsals/installation-rehearsal.py', '--directory', str(directory),
                          '--keep', '--preview-port', str(free_port())]+[value for role in IMAGES for value in ('--'+role+'-image', getattr(args, role+'_image'))], log))
        if steps[-1]['passed']:
            steps.append(step('connect_fake_telegram', [sys.executable, '-m', 'tools.acceptance.telegram_rehearsal', '--directory', str(directory)], log))
    scenarios = []
    if all(row['passed'] for row in steps):
        summary, _ = run(directory, [name for name in order if name != 'dashboard_pages'], ProductScenarios)
        scenarios = summary['scenarios']
        if not args.only or 'dashboard_pages' in args.only:
            scenarios.append(dashboard_pages(directory, directory))
    directory.mkdir(parents=True, exist_ok=True)
    write_report(directory, steps, scenarios)
    if fresh and not args.keep and (directory/'compose.json').exists():
        project = json.loads((directory/'fixture.json').read_text())['project']
        subprocess.call(['docker', 'compose', '-p', project, '-f', str(directory/'compose.json'), 'down', '--volumes', '--remove-orphans'],
                        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for suffix in ('_honcho_database', '_honcho_redis'):
            subprocess.call(['docker', 'volume', 'rm', project+suffix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print((directory/'report.md').read_text(), flush=True)
    return 0 if json.loads((directory/'result.json').read_text())['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
