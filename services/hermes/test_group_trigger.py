import os
import unittest
from unittest.mock import patch

from services.hermes.group_trigger import DEFAULT_NAMES, addressed, names, reply_mode


class GroupTriggerTests(unittest.TestCase):
    def test_only_a_message_that_addresses_the_bot_starts_a_group_turn(self):
        bot = dict(username='nocheh_bot', names=['Nocheh', 'نوچه'])
        check = lambda facts, text: addressed(facts, text, bot['username'], bot['names'])
        self.assertFalse(check({'direct': False, 'handles': []}, 'Who wants lunch?'), 'a question for the whole group')
        self.assertFalse(check({'direct': False, 'handles': ['ali_k']}, '@ali_k are you coming?'), 'a question for one person')
        self.assertFalse(check({'direct': False, 'handles': []}, 'I asked Nocheh yesterday'), 'talking about the bot is not addressing it')
        self.assertFalse(check({'direct': False, 'handles': []}, 'Nochehs everywhere'), 'the name must be a whole word')
        self.assertFalse(check(None, 'Who wants lunch?'), 'missing facts never address the bot')
        self.assertTrue(check({'direct': True, 'handles': []}, 'yes'), 'a reply to the bot or a tap on its name')
        self.assertTrue(check({'direct': False, 'handles': ['nocheh_bot']}, 'lunch @Nocheh_Bot?'))
        for text in ('Nocheh, who wants lunch?', 'nocheh what do you think', '  Nocheh?', 'نوچه، نظرت چیست؟', 'نوچه‌جان کمک کن'):
            self.assertTrue(check({'direct': False, 'handles': []}, text), text)
        self.assertFalse(addressed({'direct': False, 'handles': ['nocheh_bot']}, 'Hi', None, []), 'an unknown username matches nothing')
        self.assertFalse(addressed({}, 'Nocheh, hi', 'other_bot', ['Helper']), 'an owner who removed a name is obeyed')
        self.assertFalse(addressed({}, 'Helper2 hi', 'other_bot', ['Helper']))
        self.assertFalse(addressed({'direct': 'true', 'handles': 'nocheh_bot'}, None, 'nocheh_bot', ['Nocheh']), 'malformed facts fail closed')

    def test_owner_settings_default_to_addressed_and_reject_malformed_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual((reply_mode(), names()), ('addressed', ['Nocheh', 'نوچه']), 'the product name addresses the bot by default')
        with patch.dict(os.environ, {'TELEGRAM_GROUP_REPLIES': 'all', 'TELEGRAM_BOT_NAMES': ' Helper , یاور ,'}):
            self.assertEqual((reply_mode(), names()), ('all', ['Helper', 'یاور']))
        with patch.dict(os.environ, {'TELEGRAM_BOT_NAMES': ''}):
            self.assertEqual(names(), [], 'the owner can remove every name')
        for key, bad in (('TELEGRAM_GROUP_REPLIES', 'mentions'), ('TELEGRAM_BOT_NAMES', ','.join(['n'] * 11)), ('TELEGRAM_BOT_NAMES', 'n' * 33)):
            with patch.dict(os.environ, {key: bad}), self.assertRaises(ValueError, msg=key):
                reply_mode(), names()

    def test_settings_validate_and_reach_the_hermes_service(self):
        import yaml
        from tools.operations.installation.configuration import DEFAULTS, ROOT, validate
        from tools.operations.installation.settings import EDITABLE
        compose = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())['services']['hermes']['environment']
        # Without a colon, Compose keeps an owner's empty list instead of restoring the defaults.
        self.assertEqual((compose['TELEGRAM_GROUP_REPLIES'], compose['TELEGRAM_BOT_NAMES']),
                         ('${TELEGRAM_GROUP_REPLIES:-addressed}', '${TELEGRAM_BOT_NAMES-'+DEFAULT_NAMES+'}'))
        self.assertEqual((DEFAULTS['TELEGRAM_GROUP_REPLIES'], DEFAULTS['TELEGRAM_BOT_NAMES']), ('addressed', DEFAULT_NAMES))
        self.assertLessEqual({'TELEGRAM_GROUP_REPLIES', 'TELEGRAM_BOT_NAMES'}, EDITABLE)
        base = {**DEFAULTS, 'NOCHEH_ARCHIVE_PASSWORD': 'a' * 64, 'NOCHEH_DERIVED_PASSWORD': 'b' * 64, 'NOCHEH_CONTROL_PASSWORD': 'c' * 64,
                'INNGEST_EVENT_KEY': 'd' * 64, 'INNGEST_SIGNING_KEY': 'e' * 64, 'INNGEST_POSTGRES_PASSWORD': 'f' * 64,
                'POSTGRES_PASSWORD': 'p' * 24, 'SERVICE_TOKEN': 's' * 24}
        validate(base)
        validate({**base, 'TELEGRAM_GROUP_REPLIES': 'all', 'TELEGRAM_BOT_NAMES': ''})
        for key, bad in (('TELEGRAM_GROUP_REPLIES', 'some'), ('TELEGRAM_BOT_NAMES', 'n' * 33)):
            with self.assertRaises(ValueError, msg=key):
                validate({**base, key: bad})


if __name__ == '__main__':
    unittest.main()
