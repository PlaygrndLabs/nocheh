import unittest
from unittest.mock import patch

from tools.operations.archive.knowledge import allowed_path
from tools.runtime.management import dispatch


class KnowledgeRouteTests(unittest.TestCase):
    def test_dashboard_proxy_forwards_memory_map_and_rejects_unowned_paths(self):
        path = '/v1/memory-map?after=&limit=180&q='
        with patch('tools.operations.archive.archive.API') as api:
            call = api.return_value.call
            call.return_value = {'nodes': []}
            self.assertEqual(dispatch({'operation': 'knowledge.api', 'path': path}), {'nodes': []})
            call.assert_called_once_with(path, None)
            with self.assertRaisesRegex(ValueError, 'knowledge_route_denied'):
                dispatch({'operation': 'knowledge.api', 'path': '/v1/memory-map/export'})
            call.assert_called_once()

    def test_owner_relations_routes_match_storage_api_without_accepting_neighbors(self):
        identity = 'a' * 64
        for path in (
            '/v1/memory-map?after=&limit=180&q=',
            '/v1/memory-access/settings',
            '/v1/memory-access/requests',
            f'/v1/memory-access/requests/{identity}/decide',
            '/v1/memory-access/grants',
            f'/v1/memory-access/grants/{identity}/revoke',
            '/v1/entities',
            '/v1/entities/suggestions',
            f'/v1/entities/claims/{identity}/correct',
            f'/v1/entities/{identity}',
            f'/v1/entities/{identity}/merge',
        ):
            with self.subTest(path=path):
                self.assertTrue(allowed_path(path))
        for path in (
            '/v1/memory-map/export',
            '/v1/memory-access/requests/not-an-id/decide',
            '/v1/memory-access/grants/all/revoke',
            '/v1/entities/claims/not-an-id/correct',
            f'/v1/entities/{identity}/delete',
            'https://example.test/v1/memory-map',
            '/v1/memory-map#other',
        ):
            with self.subTest(path=path):
                self.assertFalse(allowed_path(path))

    def test_owner_retirement_route_is_allowed_without_broadening_source_paths(self):
        source = 'a' * 64
        path = f'/v1/sources/{source}/retirement'
        self.assertTrue(allowed_path(path))
        self.assertFalse(allowed_path(path + '/history'))
        self.assertFalse(allowed_path(f'/v1/sources/not-an-id/retirement'))
        self.assertFalse(allowed_path('https://example.test' + path))


if __name__ == '__main__':
    unittest.main()
