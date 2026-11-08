"""No message the bot sends or edits shows a link preview: the native adapter's own sends and every raw Bot API call."""
import ast
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from telegram.ext import ExtBot
from telegram.request import BaseRequest
from gateway.config import PlatformConfig
from .assistant_gateway import AssistantGateway, adapter_config, committed_adapter_class
from .capture import canonical, captured_adapter_class

SERVICES = Path(__file__).resolve().parents[1]
TEXT_CALLS = {'send_message', 'edit_message_text'}  # Bot API text sends and edits; both take link_preview_options
WIRE_METHODS = {'sendMessage', 'editMessageText', 'sendRichMessage'}
OFF = {'is_disabled': True}


def unprotected(source):
    """Lines of text sends, edits and native adapters that would leave link previews on."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, 'id', None)
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        if name in TEXT_CALLS and 'link_preview_options' not in keywords:
            found.append(node.lineno)
        elif name in ('do_api_request', '_post') and node.args and getattr(node.args[0], 'value', None) in WIRE_METHODS:
            payload = keywords.get('api_kwargs')
            if not isinstance(payload, ast.Dict) or 'link_preview_options' not in [getattr(key, 'value', None) for key in payload.keys]:
                found.append(node.lineno)
        elif name == 'PlatformConfig':
            extra = keywords.get('extra')
            if not isinstance(extra, ast.Dict) or not any(getattr(key, 'value', None) == 'disable_link_previews' and getattr(value, 'value', None) is True
                                                         for key, value in zip(extra.keys, extra.values)):
                found.append(node.lineno)
        # The adapter Nocheh connects. (Hermes's own gateway runner, which Nocheh never starts, would build
        # the captured one from its profile's platforms.telegram settings instead.)
        elif (isinstance(node.func, ast.Call) and getattr(node.func.func, 'id', None) == 'committed_adapter_class'
              and not (node.args and isinstance(node.args[0], ast.Call) and getattr(node.args[0].func, 'id', None) == 'adapter_config')):
            found.append(node.lineno)
    return found


class Wire(BaseRequest):
    """Telegram at the HTTP boundary: records each method and its exact parameters."""
    def __init__(self):self.calls = []
    @property
    def read_timeout(self):return 1
    async def initialize(self):pass
    async def shutdown(self):pass
    async def do_request(self, url, method, request_data=None, **kwargs):
        name, data = url.rsplit('/', 1)[-1], request_data.parameters if request_data else {}
        if name == 'getMe':return 200, canonical({'ok': True, 'result': {'id': 123456, 'is_bot': True, 'first_name': 'Nocheh', 'username': 'nocheh_fixture_bot'}})
        if name not in ('sendMessage', 'editMessageText'):raise AssertionError('Unexpected Telegram method: ' + name)
        self.calls.append((name, data))
        if name == 'editMessageText':return 200, canonical({'ok': True, 'result': True})
        # Telegram refuses a button address it does not accept; the notice then goes without buttons.
        if '"url"' in json.dumps(data.get('reply_markup')):return 400, canonical({'ok': False, 'error_code': 400, 'description': 'Bad Request: wrong http url'})
        return 200, canonical({'ok': True, 'result': {'message_id': 40 + len(self.calls), 'date': 1700000000,
                                                      'chat': {'id': int(data['chat_id']), 'type': 'private'}, 'text': data['text']}})


class LinkPreviewTests(unittest.IsolatedAsyncioTestCase):
    def test_every_send_edit_and_adapter_in_the_services_turns_previews_off(self):
        self.assertEqual(unprotected('bot.send_message(1, "x")\nbot.edit_message_text("x", chat_id=1, message_id=2)\nPlatformConfig(enabled=True)\n'
                                     'bot.do_api_request("sendMessage", api_kwargs={})\ncommitted_adapter_class()(config)\n'), [1, 2, 3, 4, 5],
                         'the scan itself catches every kind of unprotected call')
        sites = 0
        for path in sorted(SERVICES.rglob('*.py')):
            if path.name.startswith('test_') or '__pycache__' in path.parts:continue
            source = path.read_text()
            self.assertEqual(unprotected(source), [], str(path.relative_to(SERVICES)) + ' sends or edits a message with link previews on')
            sites += sum(isinstance(node, ast.Call) and getattr(node.func, 'attr', None) in TEXT_CALLS for node in ast.walk(ast.parse(source)))
        self.assertGreaterEqual(sites, 5, 'the approval card, its settle edit, the refusal and both notice sends were scanned')

    async def test_cards_refusals_notices_and_native_replies_reach_telegram_without_previews(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'NOCHEH_SPOOL_DIR': folder + '/spool'}):
            os.environ.pop('NOCHEH_STORAGE_LAYOUT', None)
            root, wire = Path(folder), Wire()
            def adapter(config, kind=None):
                native = (kind or committed_adapter_class())(config)
                native._bot = ExtBot('123456:synthetic', request=wire, get_updates_request=Wire())
                return native
            gateway = AssistantGateway(root, root / 'spool', SimpleNamespace(enabled=True, owner='123', groups=['-20'], group_access={}),
                                       '123456:synthetic', 'synthetic', lambda:None)
            gateway.status, gateway.adapter, gateway.action_lock = 'connected', adapter(adapter_config('123456:synthetic')), asyncio.Lock()
            await gateway.adapter._bot.initialize()
            card = {'kind': 'card', 'id': 'a' * 64, 'chat_id': '123', 'text': 'Send “Member: hello https://example.test/a” to the team?',
                    'buttons': [['Approve', 'na' + 'a' * 56], ['Reject', 'nd' + 'a' * 56]]}
            self.assertEqual((await gateway.send_approval(card))['state'], 'done')
            settle = {key: value for key, value in card.items() if key != 'buttons'}
            self.assertEqual(await gateway.send_approval({**settle, 'kind': 'settle', 'text': card['text'] + '\n\nApproved.'}), {'state': 'done', 'edited': True})
            self.assertEqual(await gateway.send_refusal({'event_id': 'b' * 64, 'chat_id': '9', 'user_id': '9', 'message_id': '5', 'private': True,
                                                         'reply': 'Sorry, this is private. https://example.test/b'}), {'state': 'done'})
            self.assertEqual(await gateway.send_notice({'id': 'c' * 64, 'chat_id': '123', 'text': 'A problem: https://example.test/c',
                                                        'buttons': [{'text': 'Open', 'url': 'https://example.test/open'}]}), {'state': 'done'})
            # A cleared problem marks the notice in place, here losing its buttons.
            self.assertEqual(await gateway.send_notice({'id': 'c' * 64, 'chat_id': '123', 'text': '✅ A problem: https://example.test/c',
                                                        'edit': True}), {'state': 'done', 'edited': True})
            self.assertEqual({key: wire.calls[-1][1].get(key) for key in ('chat_id', 'message_id', 'reply_markup')},
                             {'chat_id': 123, 'message_id': 45, 'reply_markup': None}, 'the notice that went through, without its buttons')
            self.assertEqual(await gateway.send_action({'id': 'd' * 64, 'destination': '123', 'text': 'Member: hello https://example.test/d'}), {'state': 'done'})
            self.assertEqual([name for name, _ in wire.calls], ['sendMessage', 'editMessageText', 'sendMessage', 'sendMessage', 'sendMessage', 'editMessageText', 'sendMessage'],
                             'card, its settle edit, refusal, refused notice with buttons, notice without, its edit, native send')
            for name, data in wire.calls:
                self.assertEqual(data.get('link_preview_options'), OFF, name + ' left link previews on')
            # Hermes's own adapter leaves them on by default. Nocheh's turn them off whatever the settings, including
            # the captured one that services/hermes/__init__.py hands Hermes's own gateway runner.
            from plugins.platforms.telegram.adapter import TelegramAdapter
            plain = PlatformConfig(enabled=True, token='123456:synthetic', typing_indicator=False)
            for kind, previews in [(TelegramAdapter, None), (captured_adapter_class(), OFF), (committed_adapter_class(), OFF)]:
                wire.calls.clear()
                await adapter(plain, kind).send('123', 'Member: hello https://example.test/e')
                self.assertEqual([(name, data.get('link_preview_options')) for name, data in wire.calls], [('sendMessage', previews)], kind.__name__)


if __name__ == '__main__':
    unittest.main()
