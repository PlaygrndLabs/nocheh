import unittest
from scripts.services import describe


class ServiceCatalogTests(unittest.TestCase):
    def test_completed_init_and_optional_tools_are_not_failures(self):
        rows=[{'service':'inngest-db-init','state':'exited','exit_code':0},
              {'service':'honcho-deriver','state':'running','health':'unhealthy'},
              {'service':'nocheh-app','state':'running','health':'healthy'}]
        services={row['service']:row for row in describe(rows,{'NOCHEH_HONCHO_ENABLED':'true'})}
        self.assertEqual(services['inngest-db-init']['state'],'completed')
        self.assertEqual(services['pgweb-archive']['state'],'optional-stopped')
        self.assertEqual(services['honcho-deriver']['state'],'unhealthy')
        self.assertEqual(services['nocheh-app']['state'],'running')
        self.assertEqual(services['nocheh-dashboard']['location'],'host')
        self.assertEqual(services['inngest-server']['state'],'unhealthy')
        for row in services.values():self.assertTrue(row['tool'] and row['purpose'])
