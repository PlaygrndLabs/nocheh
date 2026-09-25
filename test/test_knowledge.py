import unittest

from scripts.knowledge import allowed_path


class KnowledgeRouteTests(unittest.TestCase):
    def test_owner_retirement_route_is_allowed_without_broadening_source_paths(self):
        source = 'a' * 64
        path = f'/v1/sources/{source}/retirement'
        self.assertTrue(allowed_path(path))
        self.assertFalse(allowed_path(path + '/history'))
        self.assertFalse(allowed_path(f'/v1/sources/not-an-id/retirement'))
        self.assertFalse(allowed_path('https://example.test' + path))


if __name__ == '__main__':
    unittest.main()
