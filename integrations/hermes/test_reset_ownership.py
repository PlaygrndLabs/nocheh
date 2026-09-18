import copy
import tempfile
import unittest
import uuid
from pathlib import Path

from scripts import reset_files, reset_inventory, reset_ownership


class ResetOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root / 'state'; self.state.mkdir()
        self.memory = self.root / 'memory'; self.memory.mkdir()
        self.restores = self.state / 'admin/restores'; self.restores.mkdir(parents=True)
        self.external = self.root / 'data/backups'; self.external.mkdir(parents=True)
        self.owned = self.external / 'owned-backup'; self.owned.mkdir(); (self.owned / 'source').write_text('private source')
        self.foreign = self.external / 'foreign-backup'; self.foreign.mkdir(); (self.foreign / 'sentinel').write_text('unrelated')
        self.restore = self.restores / 'old-restore'; self.restore.mkdir(); (self.restore / 'content').write_text('private restore')
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'executable': False,
            'content_copied': False, 'blockers': [], 'installation': {'state': str(self.state), 'memory_state': str(self.memory)},
            'paths': [reset_inventory.entry(self.restores, 'review_restore', 'review')],
            'external_archives': [reset_inventory.entry(self.external, 'review_archive', 'review')]}

    def reviewed(self):
        review = reset_ownership.prepare(self.preflight)
        for root in review['roots']:
            for row in root['entries']:
                row['disposition'] = ('preserve-unrelated' if row['path'] == str(self.foreign)
                                      else 'erase-installation-owned')
        return review

    def test_every_exact_item_requires_a_disposition_and_scopes_erasure(self):
        draft = reset_ownership.prepare(self.preflight)
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            reset_ownership.validate(self.preflight, draft)
        reviewed = reset_ownership.validate(self.preflight, self.reviewed())
        self.assertEqual(reviewed['items'], 3); self.assertEqual(len(reviewed['erase']), 2)
        plan = reset_files.freeze(self.preflight, [], self.reviewed())
        reset_files.erase(plan, lambda: None)
        self.assertFalse(self.owned.exists()); self.assertFalse(self.restore.exists())
        self.assertEqual((self.foreign / 'sentinel').read_text(), 'unrelated')
        self.assertTrue(self.external.exists()); self.assertTrue(self.restores.exists())

    def test_added_replaced_or_forged_items_fail_before_deletion(self):
        review = self.reviewed()
        (self.external / 'late').write_text('new')
        with self.assertRaisesRegex(ValueError, 'incomplete|identity_changed'):
            reset_ownership.validate(self.preflight, review)
        (self.external / 'late').unlink()
        prior = self.root / 'prior-owned'; self.owned.rename(prior); self.owned.mkdir()
        with self.assertRaisesRegex(ValueError, 'identity_changed'):
            reset_ownership.validate(self.preflight, review)
        self.owned.rmdir(); prior.rename(self.owned)
        forged = copy.deepcopy(review); forged['roots'][0]['entries'][0]['path'] = str(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'identity_changed'):
            reset_ownership.validate(self.preflight, forged)
        self.assertTrue((self.owned / 'source').exists())

    def test_absent_review_root_is_bound_and_new_content_requires_new_review(self):
        missing = self.root / 'data/exports'
        self.preflight['external_archives'].append(reset_inventory.entry(missing, 'review_archive', 'review'))
        review = self.reviewed(); reset_ownership.validate(self.preflight, review)
        missing.mkdir(); (missing / 'later').write_text('new')
        with self.assertRaisesRegex(ValueError, 'identity_changed'):
            reset_ownership.validate(self.preflight, review)

    def test_symlink_item_is_deleted_as_a_link_without_following_target(self):
        link = self.external / 'owned-link'; link.symlink_to(self.foreign, target_is_directory=True)
        self.preflight['external_archives'] = [reset_inventory.entry(self.external, 'review_archive', 'review')]
        review = self.reviewed()
        for row in review['roots'][0]['entries']:
            row['disposition'] = 'preserve-unrelated' if row['path'] == str(self.foreign) else 'erase-installation-owned'
        reviewed = reset_ownership.validate(self.preflight, review)
        reset_files.erase(reset_files.freeze(self.preflight, [], review), lambda: None)
        self.assertFalse(link.exists()); self.assertEqual((self.foreign / 'sentinel').read_text(), 'unrelated')


if __name__ == '__main__': unittest.main()
