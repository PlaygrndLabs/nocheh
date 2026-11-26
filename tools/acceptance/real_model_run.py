"""One real-model test run on a synthetic Nocheh (test plan step 4).

It starts a fresh synthetic installation from the checkout, the same way the full tester does, connects the fake
Telegram, and runs the memory checks (model_rehearsal.py) with one cheap model behind the fixture's model relay, then,
with --bench, the persian-agent-bench attack cases (bench_run.py). The relay refuses every call once the run has spent
the cap. The fixture is removed afterwards unless --keep is given.

    python3 -m tools.acceptance.real_model_run --upstream <private provider file> [--bench <checkout>] [--build] [--keep]

The provider file is the owner's, mode 0600 and outside tracked source (model_rehearsal.read_upstream). Nothing of the
owner's live installation is read or changed.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from tools.acceptance.full_test import IMAGES, LATER_IMAGES, build_images, free_port, remove_fixture, step
from tools.acceptance.model_rehearsal import read_upstream
from tools.paths import ROOT


def latest_observations(directory):
    found = sorted(directory.glob('quality-*/observations.json'))
    return json.loads(found[-1].read_text()) if found else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--upstream', required=True, type=Path, help='The owner\'s private provider file.')
    parser.add_argument('--model', default='claude-haiku-5-5', help='The one model that answers every call of the run.')
    parser.add_argument('--spend-cap', default='5', help='Dollars; every call past it is refused.')
    parser.add_argument('--build', action='store_true', help='Build the checkout\'s images under :tester tags first and test those')
    parser.add_argument('--keep', action='store_true', help='Leave the fixture running afterwards')
    parser.add_argument('--skip-fresh', action='store_true', help='Leave out the fresh-session variant of each memory case')
    parser.add_argument('--skip-memory', action='store_true', help='Only switch the relay on, without the memory checks')
    parser.add_argument('--bench', type=Path, help='A persian-agent-bench checkout: run its attack cases after the memory checks')
    args = parser.parse_args()
    try:
        upstream = read_upstream(args.upstream)
    except (OSError, ValueError) as error:
        parser.error(str(error) if isinstance(error, ValueError) else 'upstream_file_unreadable')
    directory = (ROOT/'data/acceptance/results'/('real-'+time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))).resolve()
    directory.parent.mkdir(parents=True, exist_ok=True)
    log = directory.parent/(directory.name+'.log')
    images = {role: image for role, image in IMAGES.items()}
    steps = []
    if args.build:
        built, tags = build_images(log)
        steps += built
        images.update(tags)
    if all(row['passed'] for row in steps):
        steps.append(step('start_synthetic_nocheh', [sys.executable, 'tools/acceptance/rehearsals/installation-rehearsal.py', '--directory',
                          str(directory), '--keep', '--preview-port', str(free_port())]
                          + [value for role in IMAGES if role not in LATER_IMAGES for value in ('--'+role+'-image', images[role])], log))
    if all(row['passed'] for row in steps):
        steps.append(step('connect_fake_telegram', [sys.executable, '-m', 'tools.acceptance.telegram_rehearsal', '--directory', str(directory),
                                                    '--miniapp-image', images['miniapp']], log))
    if all(row['passed'] for row in steps):
        # The memory checks switch the relay on; --skip-memory stops them after that, before any question.
        steps.append(step('memory_checks', [sys.executable, '-m', 'tools.acceptance.model_rehearsal', '--directory', str(directory),
                                            '--upstream', str(upstream), '--model', args.model, '--spend-cap', args.spend_cap]
                          + (['--skip-fresh'] if args.skip_fresh else []) + (['--relay-only'] if args.skip_memory else []), log))
    relay_on = (directory/'compose.before-model.json').exists()
    if args.bench and relay_on:
        # A failed memory check does not stop the benchmark: the relay is on and the spend cap still holds.
        steps.append(step('persian_agent_bench', [sys.executable, '-m', 'tools.acceptance.bench_run', '--directory', str(directory),
                                                  '--bench', str(args.bench.resolve()), '--model', args.model], log))
    observed = latest_observations(directory) if directory.exists() else None
    found = sorted(directory.glob('bench-*/bench-run.json')) if directory.exists() else []
    report = {'steps': steps, 'directory': str(directory), 'log': str(log),
              'memory': observed and {'summary': observed.get('summary'),
                                      'checks': [{key: row.get(key) for key in ('case', 'verdict', 'reasons', 'error')} for row in observed['cases']]},
              'bench': json.loads(found[-1].read_text()) if found else None}
    if directory.exists() and (directory/'compose.json').exists() and relay_on:
        from tools.acceptance.model_rehearsal import Fixture
        try:
            report['spend_dollars'] = Fixture(directory).stats().get('spend_dollars')
        except Exception as error:
            report['spend_dollars'] = 'unknown:' + type(error).__name__
    if directory.exists():
        (directory/'real-model-run.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    fixture = directory/'fixture.json'
    if not args.keep and fixture.exists():
        remove_fixture(json.loads(fixture.read_text())['project'], directory, log)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0 if all(row['passed'] for row in steps) else 1


if __name__ == '__main__':
    raise SystemExit(main())
