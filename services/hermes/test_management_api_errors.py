import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from tools.runtime.management import dispatch


def refused(code, status=409):
    body = json.dumps({'error': code}).encode() if code is not None else b'not json'
    return HTTPError('http://storage.invalid/v1', status, 'refused', {}, io.BytesIO(body))


class ManagementApiErrorTests(unittest.TestCase):
    def test_a_memory_refusal_reaches_the_dashboard_by_its_code(self):
        with patch('tools.operations.archive.archive.API') as api:
            api.return_value.call.side_effect = refused('memory_engine_unsupported')
            with self.assertRaisesRegex(ValueError, '^memory_engine_unsupported$'):
                dispatch({'operation': 'memory.api', 'path': '/v1/memory/longterm/retry-failed', 'body': {}})

    def test_an_unreadable_refusal_is_named_unavailable(self):
        with patch('tools.operations.archive.archive.API') as api:
            api.return_value.call.side_effect = refused(None, 502)
            with self.assertRaisesRegex(ValueError, '^memory_operation_unavailable$'):
                dispatch({'operation': 'memory.api', 'path': '/v1/memory/longterm', 'body': None})

    def test_a_route_outside_memory_is_refused_before_any_call(self):
        with patch('tools.operations.archive.archive.API') as api:
            with self.assertRaisesRegex(ValueError, '^memory_route_denied$'):
                dispatch({'operation': 'memory.api', 'path': '/v1/memory/honcho', 'body': None})
            api.assert_not_called()


if __name__ == '__main__':
    unittest.main()
