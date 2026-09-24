"""The trusted detector prompt must distinguish ordinary markers from credentials."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from .subscription import CODEX_BASE_URL, DetectorContractError, SubscriptionCredentials, detect_literals


class DetectorTests(unittest.TestCase):
    def test_harmless_marker_is_not_described_as_a_credential(self):
        credentials=SubscriptionCredentials('synthetic-token')
        response=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"literals":[]}'))])
        with patch('integrations.hermes.subscription._call_subscription',return_value=response) as call:
            self.assertEqual(detect_literals('My test marker is blue kite.',credentials,'model'),[])
        system,user=call.call_args.args[2]
        self.assertIn('test marker',system['content'])
        self.assertIn('explicitly used for authentication',system['content'])
        self.assertEqual(user['content'],'My test marker is blue kite.')

    def test_explicit_password_still_masks_and_unmatched_literal_fails_closed(self):
        credentials=SubscriptionCredentials('synthetic-token',CODEX_BASE_URL)
        valid=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"literals":["juniper-ONLY-7642"]}'))])
        with patch('integrations.hermes.subscription._call_subscription',return_value=valid):
            self.assertEqual(detect_literals('Password: juniper-ONLY-7642',credentials,'model'),['juniper-ONLY-7642'])
        invalid=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"literals":["not-present"]}'))])
        with patch('integrations.hermes.subscription._call_subscription',return_value=invalid):
            with self.assertRaises(DetectorContractError):
                detect_literals('Password: juniper-ONLY-7642',credentials,'model')


if __name__=='__main__':unittest.main()
