"""Nocheh's data tools reach Hermes through its own MCP client, connected per turn with the turn's credential."""
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from . import mcp_fixture
from .assistant_turn import ALLOWED_TOOLS, DATA_TOOLS, TURN_TOOLSETS, UnexpectedProfileTool, connect_data_tools, disconnect_data_tools, \
    install_tool_search_policy, verify_profile_tools


class DataToolTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(install_tool_search_policy())

    def definitions(self):
        from model_tools import get_tool_definitions
        return {item['function']['name'] for item in get_tool_definitions(enabled_toolsets=TURN_TOOLSETS, quiet_mode=True)}

    def test_a_turn_connects_with_its_own_credential_held_only_in_memory(self):
        credential = 'turn.synthetic-claims.synthetic-signature'
        deadline = time.time() + 300
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HERMES_HOME': home}):
            with mcp_fixture.connected(credential=credential, deadline=deadline) as endpoint:
                self.assertEqual(DATA_TOOLS, mcp_fixture.NAMES)
                self.assertTrue(DATA_TOOLS <= self.definitions())
                self.assertTrue(any(thread.name == 'mcp-event-loop' for thread in threading.enumerate()))
                # The connection never touches disk or the environment: only its requests carry the credential.
                self.assertFalse(any(credential in value for value in os.environ.values()))
                for path in Path(home).rglob('*'):
                    if path.is_file():
                        self.assertNotIn(credential.encode(), path.read_bytes(), path.name)
            # No preflight probe or event stream: a stateless endpoint answers only these.
            self.assertEqual([request['method'] for request in endpoint.requests], ['initialize', 'notifications/initialized', 'tools/list'])
            self.assertEqual({(request['authorization'], request['deadline']) for request in endpoint.requests},
                             {('Bearer ' + credential, str(int(deadline)))})
            # Disconnected with the turn: no tool stays and Hermes's MCP loop has stopped, so the process can end.
            self.assertFalse(self.definitions() & DATA_TOOLS)
            self.assertFalse(any(thread.name == 'mcp-event-loop' for thread in threading.enumerate()))

    def test_a_turn_without_every_data_tool_or_with_another_one_does_not_run(self):
        with mcp_fixture.Endpoint(tools=mcp_fixture.TOOLS[:-1]) as endpoint, patch.dict(os.environ, {'ARCHIVE_URL': endpoint.url}):
            try:
                with self.assertRaisesRegex(RuntimeError, 'data_tools_unavailable'):
                    connect_data_tools('turn.synthetic', time.time() + 120)
            finally:
                disconnect_data_tools()
        # A tool the turn does not know of fails the turn's exact allow-list.
        with mcp_fixture.connected(tools=mcp_fixture.TOOLS + ('owner_settings',)):
            names = self.definitions()
        self.assertIn('mcp__nocheh__owner_settings', names)
        with self.assertRaises(UnexpectedProfileTool) as caught:
            verify_profile_tools(names - {'skill_manage'}, ALLOWED_TOOLS)
        self.assertEqual(caught.exception.names, ['mcp__nocheh__owner_settings'])


if __name__ == '__main__':
    unittest.main()
