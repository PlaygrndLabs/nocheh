import json
import unittest
from .compare import score
from .control import ROOT


class EvaluationTests(unittest.TestCase):
    def test_scores_answer_and_source_separately(self):
        question={'answer':'Maple','sources':['fixture:S3']}
        self.assertEqual(score('Maple',question),{'answer_match':True,'source_match':False})
        self.assertEqual(score('Cedar [fixture:S3]',question),{'answer_match':False,'source_match':True})
        self.assertEqual(score('Maple [fixture:S3]',question),{'answer_match':True,'source_match':True})

    def test_dataset_is_synthetic_and_all_citations_exist(self):
        data=json.loads((ROOT/'experiments/honcho/dataset.json').read_text())
        self.assertIs(data['synthetic_only'],True)
        sources={m['source'] for m in data['messages']}
        self.assertEqual(len(sources),len(data['messages']))
        for question in data['questions']: self.assertTrue(set(question['sources'])<=sources)
