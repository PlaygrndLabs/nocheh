import unittest
from unittest.mock import patch
from . import timing


class TimingTests(unittest.TestCase):
    def test_only_allowlisted_numeric_measurements_survive(self):
        self.assertEqual(timing.safe({'total':{'ms':42,'calls':1},'prompt':'private','memory_recall':{'ms':'credential','calls':1},'bootstrap':{'ms':True,'calls':1}}),{'total':{'ms':42,'calls':1}})
        self.assertEqual(timing.safe({'total':{'ms':-1,'calls':1}}),{})
        self.assertEqual(timing.safe({'total':{'ms':1,'calls':1,'content':'private'}}),{})
        timing.reset()
        with patch.object(timing,'perf_counter',side_effect=[1,1.5]):
            with self.assertRaisesRegex(RuntimeError,'synthetic'):
                with timing.measure('context_prepare'):raise RuntimeError('synthetic')
        self.assertEqual(timing.safe(timing.VALUES),{'context_prepare':{'ms':500,'calls':1}})
        with self.assertRaises(ValueError):timing.record('private prompt',0)
        timing.reset()
