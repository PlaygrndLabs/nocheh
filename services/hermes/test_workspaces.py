"""Several workspaces on one machine (ADR-0245): names follow from the workspace name, and setup refuses overlaps."""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.operations.installation import configuration, workspaces

ROOT = Path(__file__).resolve().parents[2]
TUNNEL = 'eyJhIjoic3ludGhldGljLWFjY291bnQiLCJ0IjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwicyI6InN5bnRoZXRpYyJ9'


def running(project, labels=None, ports=(), folder='/synthetic/folder', service='nocheh-telegram', on=True):
    return {'State': {'Running': on},
            'Config': {'Labels': {'com.docker.compose.project': project, 'com.docker.compose.service': service,
                                  'com.docker.compose.project.working_dir': folder, **(labels or {})}},
            'HostConfig': {'PortBindings': {f'{port}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}] for port in ports}}}


class Machine(unittest.TestCase):
    """Temporary workspace folders and a temporary machine list; Docker shows `self.docker` and every port is free."""

    def setUp(self):
        self.home = tempfile.TemporaryDirectory(); self.addCleanup(self.home.cleanup)
        self.base = Path(self.home.name).resolve()
        self.docker = []
        for patcher in (patch.dict(os.environ, {'NOCHEH_WORKSPACES_FILE': str(self.base / 'machine/workspaces.json')}),
                        patch.object(workspaces, 'containers', side_effect=lambda: self.docker),
                        patch.object(workspaces, '_inspect', side_effect=lambda kind, ids: [] if kind else self.docker),
                        patch.object(workspaces, 'port_free', return_value=True)):
            patcher.start(); self.addCleanup(patcher.stop)

    def folder(self, name, workspace=None, **settings):
        """A workspace folder set up as `./bin/nocheh init [--workspace]` would, with optional saved settings."""
        root = self.base / name; state = root / 'data/local'; root.mkdir()
        with patch.object(configuration, 'INSTALLATION_ROOT', root), patch.object(configuration, 'DEFAULT_STATE', state):
            values = configuration.initialize(state, workspace)
            if settings: configuration.write_env(root / '.env', {**configuration.read_env(root / '.env'), **settings})
        return root

    def linked(self, main):
        """A session worktree of `main`, laid out as `git worktree add` does: a .git file naming its private folder."""
        private = main / '.git/worktrees/worktree'; private.mkdir(parents=True); (private / 'commondir').write_text('../..\n')
        worktree = self.base / 'worktree'; worktree.mkdir(); (worktree / '.git').write_text(f'gitdir: {private}\n')
        return worktree

    def claim(self, root, fresh=True):
        return workspaces.claim(root, fresh)

    def saved(self, root):
        return configuration.read_env(root / '.env')


class NamesTests(Machine):
    def test_personal_keeps_the_classic_names_and_a_named_workspace_gets_its_own(self):
        self.assertEqual(workspaces.identity({}), {
            'COMPOSE_PROJECT_NAME': 'nocheh', 'NOCHEH_AGENT_NETWORK': 'nocheh-agent', 'NOCHEH_MEMORY_NETWORK': 'nocheh-memory',
            'NOCHEH_HONCHO_DATABASE_VOLUME': 'nocheh_honcho_database', 'NOCHEH_HONCHO_REDIS_VOLUME': 'nocheh_honcho_redis',
            'NOCHEH_IMAGES': 'nocheh'})
        self.assertEqual(workspaces.identity({'NOCHEH_WORKSPACE': 'acme'})['NOCHEH_MEMORY_NETWORK'], 'nocheh-acme-memory')
        self.assertEqual(workspaces.ports({'NOCHEH_PORT': '8790'}), {'app': 8790, 'viewer': 8792, 'dashboard': 8793, 'admin': 8795})
        for bad in ('', 'Acme', '-acme', 'acme-', 'a' * 51, 'ac me', 'acme/x'):
            with self.assertRaises(workspaces.WorkspaceError): workspaces.check_name(bad)

    def test_compose_gets_every_name_from_the_workspace_and_ignores_a_stale_shell(self):
        root = self.folder('acme', 'acme', NOCHEH_PORT='8790')
        state = root / 'data/local'
        stale = {'COMPOSE_PROJECT_NAME': 'nocheh', 'NOCHEH_AGENT_NETWORK': 'nocheh-agent', 'NOCHEH_IMAGES': 'nocheh'}
        with patch.object(configuration, 'INSTALLATION_ROOT', root), patch.object(configuration, 'DEFAULT_STATE', state), \
                patch.dict(os.environ, stale), patch.object(configuration, 'running_development_source', return_value=None):
            env = configuration.compose_environment(state)
        self.assertEqual({key: env[key] for key in ('COMPOSE_PROJECT_NAME', 'NOCHEH_AGENT_NETWORK', 'NOCHEH_MEMORY_NETWORK', 'NOCHEH_IMAGES',
                                                  'NOCHEH_HONCHO_DATABASE_VOLUME', 'NOCHEH_DASHBOARD_PORT', 'NOCHEH_VIEWER_PORT', 'NOCHEH_NATIVE_ADMIN_PORT')},
                         {'COMPOSE_PROJECT_NAME': 'nocheh-acme', 'NOCHEH_AGENT_NETWORK': 'nocheh-acme-agent', 'NOCHEH_MEMORY_NETWORK': 'nocheh-acme-memory',
                          'NOCHEH_IMAGES': 'nocheh-acme', 'NOCHEH_HONCHO_DATABASE_VOLUME': 'nocheh-acme_honcho_database',
                          'NOCHEH_DASHBOARD_PORT': '8793', 'NOCHEH_VIEWER_PORT': '8792', 'NOCHEH_NATIVE_ADMIN_PORT': '8795'})

    def test_a_folder_keeps_its_name(self):
        root = self.folder('acme', 'acme')
        state = root / 'data/local'
        with patch.object(configuration, 'INSTALLATION_ROOT', root), patch.object(configuration, 'DEFAULT_STATE', state):
            configuration.initialize(state, 'acme')
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'already the workspace acme'):
                configuration.initialize(state, 'other')
            # Settings from before workspaces, with no name, are the personal workspace and keep their data.
            saved = configuration.read_env(root / '.env'); saved.pop('NOCHEH_WORKSPACE')
            saved.update(NOCHEH_HONCHO_DATABASE_VOLUME='nocheh_honcho_database', NOCHEH_HONCHO_REDIS_VOLUME='nocheh_honcho_redis')
            configuration.write_env(root / '.env', saved)
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'already the workspace personal'):
                configuration.initialize(state, 'acme')
            self.assertEqual(configuration.initialize(state)['NOCHEH_WORKSPACE'], 'personal')
        from tools.operations.installation.settings import EDITABLE
        self.assertNotIn('NOCHEH_WORKSPACE', EDITABLE)


class PortTests(unittest.TestCase):
    def test_a_listening_program_holds_its_port_but_a_just_closed_connection_does_not(self):
        with socket.socket() as server:
            # Docker's port listener sets SO_REUSEADDR, as Go's listeners do.
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0)); server.listen(); port = server.getsockname()[1]
            # The server side closes first, as a stopping stack does: its port is left in TIME_WAIT.
            client = socket.create_connection(('127.0.0.1', port), timeout=5); accepted, _ = server.accept()
            accepted.close(); client.recv(1); client.close()
            self.assertFalse(workspaces.port_free(port))
        self.assertTrue(workspaces.port_free(port))
        with socket.socket() as everywhere:
            everywhere.bind(('0.0.0.0', 0)); everywhere.listen()
            self.assertFalse(workspaces.port_free(everywhere.getsockname()[1]))


class FolderTests(Machine):
    def test_commands_from_a_folder_without_settings_leave_it_alone(self):
        from tools.cli import main
        personal = self.folder('nocheh'); self.claim(personal)
        worktree = self.base / 'worktree'; state = worktree / 'data/local'; worktree.mkdir()
        with patch.object(configuration, 'INSTALLATION_ROOT', worktree), patch.object(configuration, 'DEFAULT_STATE', state), \
                patch.object(main, 'INSTALLATION_ROOT', worktree), patch.object(main, 'STATE', state), \
                patch.object(main, 'DEFAULT_STATE', state), patch.object(workspaces, 'revision', return_value='0000000'):
            self.assertEqual(main.workspace_command('workspaces', []), 0)
            # A new workspace never lands next to a session worktree, and update needs to know which ones.
            self.assertEqual(main.workspace_command('workspace', ['new', 'acme']), 1)
            self.assertEqual(main.workspace_command('update', []), 1)
        self.assertFalse((worktree / '.env').exists())
        self.assertEqual([name for name, _, _ in workspaces.listed()], ['personal'])

    def test_a_session_worktree_belongs_to_its_main_checkout(self):
        main = self.base / 'main'; main.mkdir(); worktree = self.linked(main)
        self.assertEqual(workspaces.main_checkout(worktree), main.resolve())
        self.assertIsNone(workspaces.main_checkout(main))
        self.assertIsNone(workspaces.main_checkout(self.base / 'missing'))
        if shutil.which('git'):
            git = ['git', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com']
            alone = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0'}
            real = self.base / 'real'
            for command in (['init', '-q', str(real)], ['-C', str(real), 'commit', '-q', '--allow-empty', '-m', 'start'],
                            ['-C', str(real), 'worktree', 'add', '-q', '--detach', str(self.base / 'session')]):
                subprocess.run([*git, *command], check=True, env=alone)
            self.assertEqual(workspaces.main_checkout(self.base / 'session'), real.resolve())
            self.assertIsNone(workspaces.main_checkout(real))

    def test_a_test_run_from_a_worktree_uses_its_workspace_images(self):
        from tools.cli import main
        acme = self.folder('nocheh-acme', 'acme'); self.claim(acme)
        worktree = self.linked(acme)
        with tempfile.TemporaryDirectory() as folder, patch.object(main, 'INSTALLATION_ROOT', worktree), \
                patch.object(configuration, 'running_development_source', return_value=None):
            configuration.initialize(Path(folder))
            self.assertEqual(main.test_environment(Path(folder), 'nocheh-test-synthetic')['NOCHEH_IMAGES'], 'nocheh-acme')

    def test_a_session_worktree_setting_itself_up_stays_with_its_workspace(self):
        from tools.cli import main
        acme = self.folder('nocheh-acme', 'acme'); self.claim(acme); worktree = self.linked(acme); state = worktree / 'data/local'
        with patch.object(configuration, 'INSTALLATION_ROOT', worktree), patch.object(configuration, 'DEFAULT_STATE', state), \
                patch.object(main, 'INSTALLATION_ROOT', worktree), \
                patch.object(configuration, 'running_development_source', return_value=None):
            # What status, logs or build do first in a folder without settings.
            configuration.initialize(state)
            saved = configuration.read_env(worktree / '.env')
            self.assertEqual((saved['NOCHEH_WORKSPACE'], saved['COMPOSE_PROJECT_NAME'], saved['NOCHEH_IMAGES']),
                             ('acme', 'nocheh-acme', 'nocheh-acme'))
            with tempfile.TemporaryDirectory() as folder:
                configuration.initialize(Path(folder))
                self.assertEqual(main.test_environment(Path(folder), 'nocheh-test-synthetic')['NOCHEH_IMAGES'], 'nocheh-acme')
        # It never starts a second acme stack.
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'name acme is already used'):
            self.claim(worktree, fresh=False)

    def test_the_dashboard_container_keeps_a_rehearsal_on_the_images_it_started_with(self):
        # The container mounts a session worktree, but not the main checkout its .git file points to.
        worktree = self.base / 'worktree'; worktree.mkdir(); (worktree / '.git').write_text('gitdir: /not/mounted\n')
        rehearsal = self.base / 'rehearsal'
        with patch.object(configuration, 'INSTALLATION_ROOT', worktree), patch.object(configuration, 'DEFAULT_STATE', worktree / 'data/local'), \
                patch.object(configuration, 'running_development_source', return_value=None):
            configuration.initialize(rehearsal)
            with patch.dict(os.environ, {'NOCHEH_CONTAINER': '1', 'NOCHEH_IMAGES': 'nocheh-acme'}):
                self.assertEqual(configuration.compose_environment(rehearsal)['NOCHEH_IMAGES'], 'nocheh-acme')
            with patch.dict(os.environ, {'NOCHEH_IMAGES': 'nocheh-acme'}):
                self.assertEqual(configuration.compose_environment(rehearsal)['NOCHEH_IMAGES'], 'nocheh', 'a shell export never counts')

    def test_a_new_folder_that_cannot_join_keeps_no_settings_and_can_still_be_named(self):
        from tools.cli import main
        personal = self.folder('nocheh'); self.claim(personal)
        clone = self.base / 'clone'; state = clone / 'data/local'; clone.mkdir()
        with patch.object(configuration, 'INSTALLATION_ROOT', clone), patch.object(configuration, 'DEFAULT_STATE', state), \
                patch.object(main, 'INSTALLATION_ROOT', clone), patch.object(main, 'STATE', state):
            configuration.initialize(state)
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'name personal is already used(.|\n)*Nothing was saved'):
                main.claim_folder(True)
            self.assertFalse((clone / '.env').exists())
            configuration.initialize(state, 'acme')
            self.assertEqual(main.claim_folder(True)['workspace'], 'acme')

    def test_a_broken_port_in_another_workspace_names_that_folder(self):
        personal = self.folder('nocheh'); self.claim(personal)
        acme = self.folder('nocheh-acme', 'acme'); self.claim(acme)
        configuration.write_env(acme / '.env', {**self.saved(acme), 'NOCHEH_PORT': '87x0'})
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'nocheh-acme/.env: NOCHEH_PORT .87x0. is not a port number'):
            self.claim(personal, fresh=False)
        self.assertIn('is not a port number', workspaces.show(personal))

    def test_a_rehearsal_state_runs_its_checkout_workspace_images(self):
        acme = self.folder('nocheh-acme', 'acme'); worktree = self.linked(acme)
        for checkout in (acme, worktree):
            rehearsal = self.base / ('rehearsal-' + checkout.name)
            with patch.object(configuration, 'INSTALLATION_ROOT', checkout), patch.object(configuration, 'DEFAULT_STATE', checkout / 'data/local'), \
                    patch.object(configuration, 'running_development_source', return_value=None):
                configuration.initialize(rehearsal)
                self.assertEqual(configuration.compose_environment(rehearsal)['NOCHEH_IMAGES'], 'nocheh-acme')
                # Images a state names itself stay, and the folder's own state keeps its own.
                configuration.write_env(rehearsal / '.env', {**configuration.read_env(rehearsal / '.env'), 'NOCHEH_IMAGES': 'nocheh'})
                self.assertEqual(configuration.compose_environment(rehearsal)['NOCHEH_IMAGES'], 'nocheh')
        personal = self.folder('nocheh')
        with patch.object(configuration, 'INSTALLATION_ROOT', personal), patch.object(configuration, 'DEFAULT_STATE', personal / 'data/local'), \
                patch.object(configuration, 'running_development_source', return_value=None):
            self.assertEqual(configuration.compose_environment(personal / 'data/local')['NOCHEH_IMAGES'], 'nocheh')

    def test_a_rehearsal_state_may_still_name_its_project_in_the_shell(self):
        root = self.folder('nocheh'); rehearsal = self.base / 'rehearsal'
        with patch.object(configuration, 'INSTALLATION_ROOT', root), patch.object(configuration, 'DEFAULT_STATE', root / 'data/local'), \
                patch.object(configuration, 'running_development_source', return_value=None):
            configuration.initialize(rehearsal)
            with patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'nocheh-rehearsal'}):
                env = configuration.compose_environment(rehearsal)
                self.assertEqual((env['COMPOSE_PROJECT_NAME'], env['NOCHEH_AGENT_NETWORK']), ('nocheh-rehearsal', 'nocheh-rehearsal-agent'))
                # The workspace folder itself never follows the shell.
                self.assertEqual(configuration.compose_environment(root / 'data/local')['COMPOSE_PROJECT_NAME'], 'nocheh')


class ClaimTests(Machine):
    def test_a_second_workspace_gets_the_next_free_ports_and_both_are_listed(self):
        personal = self.folder('nocheh')
        self.assertEqual(self.claim(personal)['dashboard'], 'http://127.0.0.1:8783/')
        acme = self.folder('nocheh-acme', 'acme')
        self.assertEqual(self.claim(acme), {'workspace': 'acme', 'folder': str(acme), 'project': 'nocheh-acme',
                                            'dashboard': 'http://127.0.0.1:8793/'})
        self.assertEqual(self.saved(acme)['NOCHEH_PORT'], '8790')
        self.assertEqual(self.saved(acme)['NOCHEH_HONCHO_DATABASE_VOLUME'], 'nocheh-acme_honcho_database')
        # Saved, so a plain `docker compose` in that folder reaches acme; personal needs none (`name: nocheh`).
        self.assertEqual((self.saved(acme)['COMPOSE_PROJECT_NAME'], self.saved(acme)['NOCHEH_IMAGES']), ('nocheh-acme', 'nocheh-acme'))
        self.assertNotIn('COMPOSE_PROJECT_NAME', self.saved(personal))
        self.assertEqual({name: str(folder) for name, folder, _ in workspaces.listed()}, {'personal': str(personal), 'acme': str(acme)})
        listed = json.loads((self.base / 'machine/workspaces.json').read_text())
        self.assertEqual(listed['workspaces'], {'acme': {'folder': str(acme)}, 'personal': {'folder': str(personal)}})
        self.assertEqual(oct((self.base / 'machine/workspaces.json').stat().st_mode & 0o777), '0o600')
        # Claiming again changes nothing, and a port a program holds moves only a new workspace.
        self.claim(personal, fresh=False); self.claim(acme, fresh=False)
        third = self.folder('nocheh-beta', 'beta')
        with patch.object(workspaces, 'port_free', side_effect=lambda port: port not in (8800, 8803)):
            self.claim(third)
        self.assertEqual(self.saved(third)['NOCHEH_PORT'], '8810')

    def test_overlaps_with_another_workspace_are_refused(self):
        token = '1000001:synthetic-secret'
        personal = self.folder('nocheh', TELEGRAM_BOT_TOKEN=token, NOCHEH_MINI_APP_URL='https://one.example.com',
                               CLOUDFLARE_TUNNEL_TOKEN=TUNNEL)
        self.claim(personal)
        cases = (({'NOCHEH_PORT': '8780'}, 'already uses ports 8780'),
                 ({'TELEGRAM_BOT_TOKEN': '1000001:another-secret'}, 'this Telegram bot'),
                 ({'NOCHEH_MINI_APP_URL': 'https://ONE.example.com/', 'CLOUDFLARE_TUNNEL_TOKEN': 'x' * 40}, 'mini app address one.example.com'),
                 ({'NOCHEH_MINI_APP_URL': 'https://two.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': TUNNEL}, 'this Cloudflare tunnel'),
                 ({'NOCHEH_HONCHO_STATE_DIR': str(personal / 'data/local/honcho')}, 'memory engine files'))
        for number, (settings, message) in enumerate(cases):
            other = self.folder(f'other-{number}', f'other{number}', **{'NOCHEH_PORT': '8790', **settings})
            with self.assertRaisesRegex(workspaces.WorkspaceError, message):
                self.claim(other, fresh=False)
        self.assertEqual([name for name, _, _ in workspaces.listed()], ['personal'])
        # A second folder may never take a name in use, even a fresh one.
        twin = self.folder('twin')
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'name personal is already used'):
            self.claim(twin)

    def test_a_copied_env_is_refused(self):
        acme = self.folder('nocheh-acme', 'acme')
        saved = self.saved(acme); saved.update(NOCHEH_HONCHO_DATABASE_VOLUME='nocheh_honcho_database', NOCHEH_MEMORY_NETWORK='nocheh-memory')
        configuration.write_env(acme / '.env', saved)
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'NOCHEH_MEMORY_NETWORK, NOCHEH_HONCHO_DATABASE_VOLUME. It looks copied'):
            self.claim(acme)

    def test_a_moved_or_renamed_folder_drops_out_of_the_list(self):
        personal, acme = self.folder('nocheh'), self.folder('nocheh-acme', 'acme')
        self.claim(personal); self.claim(acme)
        shutil.rmtree(acme)
        self.assertEqual([name for name, _, _ in workspaces.listed()], ['personal'])
        # Its name and ports are free again.
        again = self.folder('elsewhere', 'acme')
        self.assertEqual(self.claim(again)['dashboard'], 'http://127.0.0.1:8793/')

    def test_docker_shows_what_another_stack_holds(self):
        personal = self.folder('nocheh', TELEGRAM_BOT_TOKEN='1000001:synthetic-secret')
        # The same project from another folder: a second clone without a name would take over that stack.
        clone = self.folder('clone')
        self.docker = [running('nocheh', folder=str(clone), service='nocheh-app')]
        with self.assertRaisesRegex(workspaces.WorkspaceError, f'already runs the nocheh stack from {clone}'):
            self.claim(personal, fresh=False)
        self.docker = [running('nocheh', folder=str(personal), service='nocheh-app', ports=(8780,))]
        self.claim(personal, fresh=False)
        # Containers left by a folder that moved away, that now holds another workspace, or by a session worktree
        # are Compose's to replace.
        for gone in (self.base / 'moved-away', self.folder('nocheh-beta', 'beta'), self.linked(personal)):
            self.docker = [running('nocheh', folder=str(gone), service='nocheh-app', on=False)]
            self.claim(personal, fresh=False)
        # A folder whose .env cannot be read may still be this workspace.
        (clone / '.env').write_text((clone / '.env').read_text() * 2)
        self.docker = [running('nocheh', folder=str(clone), service='nocheh-app')]
        with self.assertRaisesRegex(workspaces.WorkspaceError, f'from {clone}, whose .env cannot be read'):
            self.claim(personal, fresh=False)
        # A running stack of another project with this bot, or on these ports, even one not on the list.
        self.docker = [running('nocheh-other', {'com.nocheh.bot-id': '1000001'})]
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'nocheh-other stack already uses this Telegram bot'):
            self.claim(personal, fresh=False)
        self.docker = [running('nocheh-other', {'com.nocheh.bot-id': '1000001'}, on=False)]
        self.claim(personal, fresh=False)
        # A stack with Telegram off polls no bot; one Nocheh cannot tell apart might poll this one.
        self.docker = [running('nocheh-restored', {'com.nocheh.bot-id': ''})]
        self.claim(personal, fresh=False)
        for labels in ({}, {'com.nocheh.bot-id': 'unknown'}):
            self.docker = [running('nocheh-other', labels)]
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'nocheh-other stack runs a Telegram bot Nocheh cannot tell apart'):
                self.claim(personal, fresh=False)
        self.docker = [running('fixture', ports=(8783,), service='web')]
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'fixture stack already uses port 8783'):
            self.claim(personal, fresh=False)
        # A published range counts whole.
        self.docker = [running('fixture', ports=('8781-8784',), service='web')]
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'fixture stack already uses ports 8782, 8783'):
            self.claim(personal, fresh=False)
        # A fresh workspace moves away from them instead.
        acme = self.folder('nocheh-acme', 'acme')
        self.docker = [running('fixture', ports=(8793,), service='web')]
        self.assertEqual(self.claim(acme)['dashboard'], 'http://127.0.0.1:8803/')

    def test_a_network_or_volume_of_another_project_is_refused(self):
        personal = self.folder('nocheh')
        def inspect(kind, ids):
            if kind == 'network' and ids == ['nocheh-memory']: return [{'Labels': {'com.docker.compose.project': 'nocheh-old'}}]
            return [] if kind else self.docker
        with patch.object(workspaces, '_inspect', side_effect=inspect):
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'network nocheh-memory belongs to the nocheh-old stack'):
                self.claim(personal)

    def test_settings_refuse_a_bot_another_workspace_holds(self):
        personal = self.folder('nocheh', TELEGRAM_BOT_TOKEN='1000001:synthetic-secret')
        self.claim(personal)
        acme = self.folder('nocheh-acme', 'acme'); self.claim(acme)
        values = {**configuration.DEFAULTS, **self.saved(acme)}
        with patch.object(configuration, 'INSTALLATION_ROOT', acme):
            workspaces.check_settings(values, values)
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'personal .* already uses this Telegram bot'):
                workspaces.check_settings({**values, 'TELEGRAM_BOT_TOKEN': '1000001:another-secret'}, values)
            workspaces.check_settings({**values, 'TELEGRAM_BOT_TOKEN': '1000002:synthetic-secret'}, values)
            # Inside the dashboard container only Docker is in reach: a running stack's label.
            with patch.dict(os.environ, {'NOCHEH_CONTAINER': '1'}):
                workspaces.check_settings({**values, 'TELEGRAM_BOT_TOKEN': '1000001:another-secret'}, values)
                self.docker = [running('nocheh', {'com.nocheh.bot-id': '1000001'})]
                with self.assertRaisesRegex(workspaces.WorkspaceError, 'nocheh stack already uses this Telegram bot'):
                    workspaces.check_settings({**values, 'TELEGRAM_BOT_TOKEN': '1000001:another-secret'}, values)
                # Turning Telegram on with that bot is checked too; turning it off never is.
                held = {**values, 'TELEGRAM_BOT_TOKEN': '1000001:another-secret', 'TELEGRAM_ENABLED': 'false'}
                with self.assertRaisesRegex(workspaces.WorkspaceError, 'already uses this Telegram bot'):
                    workspaces.check_settings({**held, 'TELEGRAM_ENABLED': 'true'}, held)
                workspaces.check_settings(held, {**held, 'TELEGRAM_ENABLED': 'true'})
                # A tunnel Nocheh cannot tell apart might be this one.
                self.docker = [running('nocheh', {}, service='nocheh-tunnel')]
                tunnel = {**values, 'NOCHEH_MINI_APP_URL': 'https://acme.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': TUNNEL}
                with self.assertRaisesRegex(workspaces.WorkspaceError, 'runs a Cloudflare tunnel Nocheh cannot tell apart'):
                    workspaces.check_settings(tunnel, values)
        from tools.operations.installation import mini_app
        self.assertEqual([mini_app.environment({'TELEGRAM_BOT_TOKEN': '1000001:synthetic-secret', 'TELEGRAM_ENABLED': enabled})['NOCHEH_POLLED_BOT_ID']
                          for enabled in ('true', 'false')], ['1000001', ''])


class CommandsTests(Machine):
    def calls(self, results=None):
        calls = []
        def run(command, **options):
            calls.append((command, options))
            return SimpleNamespace(returncode=(results or {}).get(command[-1], 0))
        return calls, run

    def git(self, branch='main', dirty=''):
        def fake(folder, *arguments, check=True):
            answers = {'branch': branch, 'status': dirty, 'rev-parse': 'abc1234', 'remote': 'https://example.com/nocheh.git'}
            return SimpleNamespace(returncode=0, stdout=answers.get(arguments[0], '') + '\n')
        return patch.object(workspaces, 'git', side_effect=fake)

    def test_update_restarts_only_running_stacks_with_their_own_command(self):
        personal, acme, beta = self.folder('nocheh'), self.folder('nocheh-acme', 'acme'), self.folder('nocheh-beta', 'beta')
        for root in (personal, acme, beta): self.claim(root)
        self.docker = [running('nocheh', {'com.nocheh.runtime-mode': 'source-watched'}, service='nocheh-app'),
                       running('nocheh-acme', service='nocheh-app')]
        calls, run = self.calls(); said = []
        with self.git(), patch.dict(os.environ, {'NOCHEH_STATE_DIR': '/elsewhere', 'COMPOSE_PROJECT_NAME': 'nocheh'}):
            self.assertEqual(workspaces.update(['personal', 'acme', 'beta'], personal, run, said.append), 0)
        pulls = [command for command, _ in calls if 'pull' in command]
        self.assertEqual(len(pulls), 3)
        ups = [(command, options) for command, options in calls if command[-1] == 'up']
        self.assertEqual([command for command, _ in ups], [[str(acme / 'bin/nocheh'), 'up']])
        self.assertEqual(ups[0][1]['cwd'], acme)
        self.assertNotIn('NOCHEH_STATE_DIR', ups[0][1]['env']); self.assertNotIn('COMPOSE_PROJECT_NAME', ups[0][1]['env'])
        self.assertIn('make dev reloads it', said[0]); self.assertIn('restarted', said[1]); self.assertIn('Not running', said[2])

    def test_update_skips_a_folder_off_main_or_with_changes(self):
        personal = self.folder('nocheh'); self.claim(personal)
        for branch, dirty, message in (('topic', '', 'on topic, not main'), ('main', ' M src/x.ts', 'not committed')):
            calls, run = self.calls(); said = []
            with self.git(branch, dirty):
                self.assertEqual(workspaces.update(['personal'], personal, run, said.append), 1)
            self.assertEqual(calls, []); self.assertIn(message, said[0])
        with self.assertRaisesRegex(workspaces.WorkspaceError, 'No workspace named nope'):
            workspaces.update(['nope'], personal)

    def test_new_copies_this_folder_and_sets_up_the_new_workspace(self):
        personal = self.folder('nocheh'); self.claim(personal)
        calls, run = self.calls()
        with self.git():
            target = workspaces.create('acme', personal, run=run)
            self.assertEqual(target, self.base / 'nocheh-acme')
            self.assertEqual([command for command, _ in calls], [
                ['git', 'clone', '--quiet', '--branch', 'main', str(personal), str(target)],
                ['git', '-C', str(target), 'remote', 'set-url', 'origin', 'https://example.com/nocheh.git'],
                ['git', '-C', str(target), 'config', 'core.hooksPath', 'tools/development/git-hooks'],
                [str(target / 'bin/nocheh'), 'init', '--workspace', 'acme']])
            # Names that tests, fixtures and restores make for themselves stay theirs.
            for reserved in ('test', 'restore-1', 'restored', 'installation-0123456789ab', 'dev'):
                with self.assertRaisesRegex(workspaces.WorkspaceError, 'keeps the name'):
                    workspaces.create(reserved, personal, run=run)
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'workspace personal already exists'):
                workspaces.create('personal', personal, run=run)
            (self.base / 'busy').mkdir(); (self.base / 'busy/file').write_text('x')
            with self.assertRaisesRegex(workspaces.WorkspaceError, 'not empty'):
                workspaces.create('beta', personal, self.base / 'busy', run=run)


@unittest.skipUnless(shutil.which('docker'), 'Compose CLI unavailable')
class ComposeTests(Machine):
    def test_two_workspaces_render_apart(self):
        rendered = {}
        for name, workspace, port in (('nocheh', None, '8780'), ('nocheh-acme', 'acme', '8790')):
            root = self.folder(name, workspace, NOCHEH_PORT=port, TELEGRAM_BOT_TOKEN=f'{port}01:synthetic-secret', TELEGRAM_ENABLED='true',
                               NOCHEH_MINI_APP_URL=f'https://{name}.example.com', CLOUDFLARE_TUNNEL_TOKEN=TUNNEL if workspace else 'x' * 40)
            state = root / 'data/local'
            with patch.object(configuration, 'INSTALLATION_ROOT', root), patch.object(configuration, 'DEFAULT_STATE', state), \
                    patch.object(configuration, 'running_development_source', return_value=None):
                env = configuration.compose_environment(state)
            command = ['docker', 'compose', '--env-file', str(root / '.env'), '-f', str(ROOT / 'docker-compose.yml'),
                       '--profile', 'honcho', '--profile', 'tools', '--profile', 'miniapp', 'config', '--format', 'json']
            rendered[name] = json.loads(subprocess.check_output(command, env=env, text=True, stderr=subprocess.PIPE, timeout=60))
        personal, acme = rendered['nocheh'], rendered['nocheh-acme']
        def facts(manifest):
            services = manifest['services']
            return {'project': manifest['name'],
                    'images': sorted({service['image'] for service in services.values()
                                      if service['image'].startswith('nocheh') and '-honcho' not in service['image']}),
                    'networks': sorted(network.get('name') for network in manifest['networks'].values()),
                    'volumes': sorted(volume.get('name') for volume in manifest['volumes'].values()),
                    'ports': sorted(int(port['published']) for service in services.values() for port in service.get('ports', [])),
                    'bot': services['nocheh-telegram']['labels']['com.nocheh.bot-id'],
                    'turns': services['hermes-agent-sb']['environment']['NOCHEH_TURN_IMAGE'],
                    'boxes': services['hermes-agent-sb']['environment']['NOCHEH_BOX_IMAGE'],
                    'tools': services['nocheh-executor']['environment']['NOCHEH_TOOLS_IMAGE']}
        self.assertEqual(facts(personal), {
            'project': 'nocheh',
            'images': ['nocheh-hermes:local', 'nocheh-management:local', 'nocheh-miniapp:local', 'nocheh-services:local', 'nocheh-store-postgres:local'],
            'networks': ['nocheh-agent', 'nocheh-memory', 'nocheh_default', 'nocheh_honcho-egress', 'nocheh_honcho-isolated', 'nocheh_miniapp', 'nocheh_workflows'],
            'volumes': ['nocheh_honcho_database', 'nocheh_honcho_redis', 'nocheh_postgres_data'],
            'ports': [8780, 8782, 8783, 8785], 'bot': '878001',
            'turns': 'nocheh-hermes:local', 'boxes': 'nocheh-box:local', 'tools': 'nocheh-tools:local'})
        self.assertEqual(facts(acme), {
            'project': 'nocheh-acme',
            'images': ['nocheh-acme-hermes:local', 'nocheh-acme-management:local', 'nocheh-acme-miniapp:local', 'nocheh-acme-services:local',
                       'nocheh-acme-store-postgres:local'],
            'networks': ['nocheh-acme-agent', 'nocheh-acme-memory', 'nocheh-acme_default', 'nocheh-acme_honcho-egress', 'nocheh-acme_honcho-isolated',
                         'nocheh-acme_miniapp', 'nocheh-acme_workflows'],
            'volumes': ['nocheh-acme_honcho_database', 'nocheh-acme_honcho_redis', 'nocheh-acme_postgres_data'],
            'ports': [8790, 8792, 8793, 8795], 'bot': '879001',
            'turns': 'nocheh-acme-hermes:local', 'boxes': 'nocheh-acme-box:local', 'tools': 'nocheh-acme-tools:local'})
        self.assertEqual(acme['services']['nocheh-tunnel']['labels'],
                         {'com.nocheh.tunnel-id': '00000000-0000-4000-8000-000000000001', 'com.nocheh.mini-app-host': 'nocheh-acme.example.com'})
        # A test run's project names its own networks and memory volumes, so its `down --volumes` removes only its own.
        import tools.cli.main as cli
        acme_root = self.base / 'nocheh-acme'
        with tempfile.TemporaryDirectory() as folder, patch.object(cli, 'INSTALLATION_ROOT', acme_root):
            state = Path(folder)
            configuration.initialize(state)
            with patch.object(configuration, 'running_development_source', return_value=None):
                env = cli.test_environment(state, 'nocheh-test-synthetic')
            command = configuration.compose_command(state, 'nocheh-test-synthetic') + [
                '-f', str(ROOT / 'deploy/acceptance/test-compose.yml'), '--profile', 'honcho', 'config', '--format', 'json']
            test = json.loads(subprocess.check_output(command, env=env, text=True, stderr=subprocess.PIPE, timeout=60))
        self.assertEqual(sorted(volume['name'] for volume in test['volumes'].values()),
                         ['nocheh-test-synthetic_honcho_database', 'nocheh-test-synthetic_honcho_redis', 'nocheh-test-synthetic_postgres_data'])
        self.assertEqual(sorted(network['name'] for network in test['networks'].values() if network['name'].endswith(('agent', 'memory'))),
                         ['nocheh-test-synthetic-agent', 'nocheh-test-synthetic-memory'])
        self.assertEqual(test['services']['nocheh-app']['image'], 'nocheh-acme-services:dev')
        # Every bind mount of the second workspace stays in its own folder or its pinned source.
        for service in acme['services'].values():
            for mount in service.get('volumes', []):
                if mount['type'] == 'bind' and mount['source'] != '/var/run/docker.sock':
                    self.assertFalse(mount['source'].startswith(str(self.base / 'nocheh') + '/'), mount['source'])



class DockerTests(unittest.TestCase):
    def test_a_container_removed_while_listed_leaves_the_others(self):
        found = [{'Id': 'still-here'}]
        done = SimpleNamespace(returncode=1, stdout=json.dumps(found), stderr='error: no such object: gone')
        with patch.object(workspaces.subprocess, 'run', return_value=done):
            self.assertEqual(workspaces._inspect(None, ['still-here', 'gone']), found)
        with patch.object(workspaces.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='')):
            self.assertEqual(workspaces._inspect(None, ['gone']), [])
        with patch.object(workspaces.subprocess, 'run', side_effect=FileNotFoundError('docker')):
            self.assertEqual(workspaces._inspect('volume', ['nocheh_honcho_redis']), [])


if __name__ == '__main__':
    unittest.main()
