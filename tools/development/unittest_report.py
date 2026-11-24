"""Run one folder's Python unit tests and write which failed, for tools/development/check_all.py.

    python -m tools.development.unittest_report --out result.json --start services/hermes [--top .]
    python -m tools.development.unittest_report --out result.json --modules services.honcho.test_meter ...

A module that cannot be imported counts as one failed test named after the module.
"""
import argparse
import json
import sys
import time
import unittest


class Result(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.failed = []

    def note(self, test, error):
        name = test.id()
        if name.startswith('unittest.loader._FailedTest.'):
            name = 'import ' + name.removeprefix('unittest.loader._FailedTest.')
        kind, value = error[0], error[1]
        self.failed.append({'test': name, 'error': (kind.__name__ + ': ' + str(value).split('\n')[0])[:300]})

    def addError(self, test, error):
        super().addError(test, error)
        self.note(test, error)

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.note(test, error)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.failed.append({'test': test.id(), 'error': 'unexpected success'})

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is not None:
            self.note(subtest, error)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--out', required=True)
    parser.add_argument('--start', help='Folder to discover test_*.py in')
    parser.add_argument('--top', default='.', help='Top-level folder for discovery')
    parser.add_argument('--modules', nargs='*', default=[], help='Test modules to load by name instead')
    args = parser.parse_args()
    loader = unittest.TestLoader()
    suite = (loader.discover(args.start, pattern='test_*.py', top_level_dir=args.top) if args.start
             else loader.loadTestsFromNames(args.modules))
    started = time.monotonic()
    result = unittest.TextTestRunner(resultclass=Result, verbosity=1, stream=sys.stderr).run(suite)
    with open(args.out, 'w') as output:
        json.dump({'ran': result.testsRun, 'skipped': len(result.skipped), 'failed': result.failed,
                   'seconds': round(time.monotonic() - started)}, output, indent=1)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
