"""Development reloads watch what each service runs: a build's ready marker, or a folder below dist/."""

from pathlib import Path
import tempfile
import unittest

from tools.development.dev_reload import snapshot


class DevReloadSnapshotTests(unittest.TestCase):
    def test_watched_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary) / 'app/dist'
            (dist / 'src').mkdir(parents=True)
            (dist / 'node_modules').mkdir()
            (dist / 'src/host.js').write_text('1')
            (dist / 'node_modules/x.js').write_text('1')
            marker = dist / '.dev-ready'
            marker.write_text('1\n')
            # A folder that is itself dist/ is watched; generated folders inside it are not.
            self.assertEqual([path for path, *_ in snapshot([dist])], [str(dist / 'src/host.js')])
            # A file named as a root is watched whatever its suffix, so each finished build restarts the service once.
            before = snapshot([marker])
            self.assertEqual([path for path, *_ in before], [str(marker)])
            marker.write_text('22\n')
            self.assertNotEqual(snapshot([marker]), before)
            # A marker that does not exist yet is simply not there.
            self.assertEqual(snapshot([Path(temporary) / 'missing']), ())


if __name__ == '__main__':
    unittest.main()
