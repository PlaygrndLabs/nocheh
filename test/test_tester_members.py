"""The full tester sets members up the way the dashboard's Members page does, through the owner's Members routes, and
never asks for a group switch the owner's Rule 1 refuses: a new switch that is on needs Telegram to have shown the person
in that group, so the tester only ever writes off switches or flips existing ones."""
import unittest

from tools.acceptance.telegram_scenarios import Fixture, Scenarios

GROUP, OTHER, THIRD = '-10042', '-10043', 'd4'*32
LISTED = [{'chat_id': GROUP, 'title': 'Synthetic Forum -10042', 'state': 'active'},
          {'chat_id': OTHER, 'title': 'Synthetic Forum -10043', 'state': 'active'},
          {'chat_id': THIRD, 'title': 'Synthetic Forum -10045', 'state': 'active'}]
PERMISSIONS = {'talk': True, 'jobs': True, 'post': True, 'tools': True, 'tasks': 'write', 'private_chat': True}


class FakeFixture:
    """Chat ids by Telegram id: a group known before the new chat ids keeps its stored value."""
    def chat(self, app_id, topic=None, seconds=60):
        return {-10042: GROUP, -10043: OTHER, -10045: THIRD}[app_id]


def scenarios(members):
    """Scenarios whose Members routes answer from `members`, recording each request."""
    found = Scenarios(FakeFixture(), None)
    calls = []

    def members_api(path='', body=None, allow_error=False, signed_in=False):
        calls.append((path, body))
        if body is None:
            return {'revision': 1, 'daily_messages': 200, 'groups': LISTED, 'members': members, 'people': []}
        return {'revision': 2, 'member': {'id': 'e5'*32, 'state': 'active', 'groups': [], 'permissions': PERMISSIONS}}
    found.members_api = members_api
    return found, calls


def member(person, groups, **permissions):
    return {'id': 'f6'*32, 'account_id': 'a7'*32, 'telegram_id': str(person), 'state': permissions.pop('state', 'active'),
            'permissions': {**PERMISSIONS, **permissions}, 'groups': groups}


def row(chat, on, telegram='in'):
    return {'chat_id': chat, 'title': None, 'state': 'active', 'on': on, 'telegram': telegram, 'new': False}


class TesterMembers(unittest.TestCase):
    def test_a_new_member_is_added_by_telegram_id_with_unticked_groups_off(self):
        found, calls = scenarios([])
        found.add_member(778, (-10042, -10043))
        (path, body), = [call for call in calls if call[1] is not None]
        self.assertEqual(path, '')
        self.assertEqual(body['telegram_id'], '778')
        self.assertEqual(body['groups'], {GROUP: True, OTHER: True, THIRD: False})

    def test_an_existing_member_gets_only_what_differs_and_no_new_on_switch(self):
        # GROUP has no row (on), OTHER a row that is off, THIRD no row; jobs and the state were changed by an earlier run.
        found, calls = scenarios([member(778, [row(GROUP, True), row(OTHER, False)], jobs=False, state='paused')])
        found.add_member(778, (-10042, -10043))
        (path, body), = [call for call in calls if call[1] is not None]
        self.assertEqual(path, '/'+'f6'*32)
        # OTHER's existing row is switched on, THIRD gets an off row; GROUP, already on, is not sent, so no new on row.
        self.assertEqual(body['changes'], {'jobs': True, 'state': 'active', 'groups': {OTHER: True, THIRD: False}})

    def test_a_member_already_as_wanted_sends_nothing(self):
        found, calls = scenarios([member(779, [row(GROUP, True), row(OTHER, False), row(THIRD, False, None)])])
        found.set_members({779: (-10042,)})
        self.assertEqual([call for call in calls if call[1] is not None], [])

    def test_a_change_names_groups_by_telegram_id(self):
        found, calls = scenarios([])
        found.change_member(member(778, [row(OTHER, True)]), groups={-10043: False}, post=False)
        (path, body), = [call for call in calls if call[1] is not None]
        self.assertEqual(body['changes'], {'post': False, 'groups': {OTHER: False}})


class KeptFixture(FakeFixture):
    """A fixture kept between runs: its message ids keep counting, as Telegram's update ids do."""
    def __init__(self):
        self.next_id = 1000

    def ids(self):
        self.next_id += 10
        return self.next_id

    message = Fixture.message


class TesterFixedReplies(unittest.TestCase):
    """The bot answers someone who may not talk in a group at most once a UTC day per person and group, and keeps that in
    its spool. A scenario that waits for that reply asks as someone new to the fixture, so a second run on a kept fixture
    the same day still gets one."""

    def refused_people(self, found, scenario):
        """Who a scenario waits for a fixed reply from, with every call to the fixture and the Members routes stubbed."""
        asked = []
        listed = lambda person: {'telegram_id': str(person), 'state': 'active', 'groups': []}
        found.not_allowed_reply = lambda update, topic, chat=-10042: asked.append((update['message']['from']['id'], chat))
        found.refused_quietly = found.turn = found.gate = found.wait = found.nothing_restarted = found.members_allowed = lambda *args, **kwargs: None
        found.service_starts = dict
        found.add_member = lambda person, groups: listed(person)
        found.member_item = listed
        found.change_member = lambda item, groups=None, **changes: item
        found.remove_member = lambda item: None
        getattr(found, scenario)()
        return asked

    def test_each_run_waits_for_a_fixed_reply_from_someone_new(self):
        from tools.acceptance.product_scenarios import ProductScenarios
        kept = KeptFixture()
        for scenario in ('participant_not_permitted', 'granted_participant', 'member_switched_off_in_a_group'):
            first, second = (self.refused_people(ProductScenarios(kept, None), scenario) for _ in range(2))
            with self.subTest(scenario):
                self.assertEqual((len(first), len(second)), (1, 1))
                self.assertNotEqual(first[0][0], second[0][0], 'the second run on the kept fixture asks as someone else')


if __name__ == '__main__':
    unittest.main()
