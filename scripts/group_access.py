"""Owner-managed per-group permission for starting Telegram assistant turns."""
import argparse
import json
import re

from .configuration import group_access, load
from .settings import apply, save, view


def main(state, argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('list', 'grant', 'deny', 'revoke'))
    parser.add_argument('group_id', nargs='?')
    parser.add_argument('user_id', nargs='?')
    parser.add_argument('--save-only', action='store_true', help='Save without applying to running services')
    args = parser.parse_args(argv)
    values = load(state)
    groups = [value.strip() for value in values['TELEGRAM_GROUP_IDS'].split(',') if value.strip()]
    access = group_access(values)
    if args.action == 'list':
        if args.user_id or args.save_only: parser.error('list accepts only an optional group ID')
        if args.group_id and args.group_id not in groups: parser.error('group is not selected')
        selected = [args.group_id] if args.group_id else groups
        for group in selected:
            rule = access.get(group, {'granted': [], 'denied': []})
            print(json.dumps({'group_id': group, 'owner_id': values['TELEGRAM_OWNER_ID'], **rule}, sort_keys=True))
        return 0
    if args.group_id not in groups: parser.error('group is not selected')
    if not args.user_id or not re.fullmatch(r'[1-9]\d{0,18}', args.user_id): parser.error('user ID must be a positive numeric Telegram ID')
    if args.user_id == values['TELEGRAM_OWNER_ID']: parser.error('owner access cannot be changed')
    rule = access.setdefault(args.group_id, {'granted': [], 'denied': []})
    for decision in ('granted', 'denied'):
        rule[decision] = sorted(set(rule[decision]) - {args.user_id})
    if args.action == 'grant': rule['granted'].append(args.user_id)
    if args.action == 'deny': rule['denied'].append(args.user_id)
    if not rule['granted'] and not rule['denied']: access.pop(args.group_id)
    save(state, {'TELEGRAM_GROUP_ACCESS': json.dumps(access, sort_keys=True, separators=(',', ':'))}, view(state)['revision'])
    if args.save_only:
        print('Saved. Run ./scripts/nocheh config apply to update running services.')
        return 0
    result = apply(state)
    if result['status'] != 'applied':
        print('Apply failed; previous running configuration restored.' if result['rolled_back'] else 'Apply failed; verify running services.')
        return 1
    print('Group access applied.')
    return 0
