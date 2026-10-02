"""Real PostgreSQL recovery hashing under a bounded temporary-disk budget."""
import hashlib
import json
import os
import subprocess
import unittest
import uuid
from tools.operations.workflows.workflow_recovery import fingerprint_query,FINGERPRINT_FORMAT


@unittest.skipUnless(os.environ.get('NOCHEH_FINGERPRINT_FIXTURE_CONTAINER'),'synthetic PostgreSQL fixture required')
class FingerprintTests(unittest.TestCase):
    def setUp(self):
        self.container=os.environ['NOCHEH_FINGERPRINT_FIXTURE_CONTAINER']
        metadata=json.loads(subprocess.check_output(['docker','inspect',self.container],text=True))[0]
        labels=metadata['Config'].get('Labels',{})
        self.assertTrue(labels.get('com.docker.compose.project','').startswith('nocheh-release-check-'))
        self.assertEqual(labels.get('com.docker.compose.service'),'database')
        self.schema='fingerprint_'+uuid.uuid4().hex
        self.sql('CREATE SCHEMA '+self.schema)
        self.addCleanup(lambda:self.sql('DROP SCHEMA '+self.schema+' CASCADE'))

    def sql(self,query,options=''):
        return subprocess.run(['docker','exec','-i','-e','PGOPTIONS='+options,self.container,
            'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh'],
            input=query,text=True,capture_output=True,check=True).stdout

    def digest(self,table,options=''):
        raw=self.sql(fingerprint_query(self.schema+'.'+table,FINGERPRINT_FORMAT),options)
        self.assertTrue(all(len(line)==64 for line in raw.splitlines()))
        return hashlib.sha256(raw.encode()).hexdigest()

    def test_row_order_independence_multiplicity_values_and_timezone(self):
        self.sql(f"CREATE TABLE {self.schema}.a (value text, at timestamptz); "
                 f"INSERT INTO {self.schema}.a VALUES (NULL,'2026-01-01Z'),('','2026-01-01Z'),('雪','2026-01-01Z'); "
                 f"CREATE TABLE {self.schema}.b AS SELECT * FROM {self.schema}.a ORDER BY value DESC NULLS LAST")
        initial=self.digest('a')
        self.assertEqual(initial,self.digest('b','-c timezone=Asia/Tbilisi'))
        self.sql(f'INSERT INTO {self.schema}.b SELECT * FROM {self.schema}.a LIMIT 1')
        self.assertNotEqual(initial,self.digest('b'))
        self.sql(f"UPDATE {self.schema}.a SET value='changed' WHERE value IS NULL")
        self.assertNotEqual(initial,self.digest('a'))

    def test_large_rows_fit_a_small_sort_budget_and_old_format_still_has_original_semantics(self):
        self.sql(f'CREATE TABLE {self.schema}.large (id integer, payload text); '
                 f'INSERT INTO {self.schema}.large SELECT g,repeat(md5(g::text),4096) FROM generate_series(1,256) g')
        options='-c work_mem=64kB -c temp_file_limit=4096'
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.sql(fingerprint_query(self.schema+'.large','row-json-v1'),options)
        self.assertIn('temporary file size exceeds temp_file_limit',caught.exception.stderr)
        self.assertEqual(self.digest('large',options),self.digest('large'))
        self.sql(f'CREATE TABLE {self.schema}.small (id integer); INSERT INTO {self.schema}.small VALUES (2),(1),(1)')
        self.assertEqual(self.sql(fingerprint_query(self.schema+'.small','row-json-v1')),'{"id":1}\n{"id":1}\n{"id":2}\n')


if __name__=='__main__':unittest.main()
