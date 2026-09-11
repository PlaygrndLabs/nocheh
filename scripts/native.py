"""Local native administration, shared by CLI and the Nocheh owner API."""
import argparse
import json
import urllib.request
import urllib.error
from urllib.parse import urlencode
from .configuration import load, native_admin_port


def call(state, path, body=None, method=None, revision=None):
    import os
    token = load(state)['SERVICE_TOKEN']
    port = int(os.environ.get('NOCHEH_NATIVE_ADMIN_PORT') or native_admin_port(state))
    headers = {'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'}
    if revision: headers['If-Match'] = '"' + revision + '"'
    request = urllib.request.Request(f'http://127.0.0.1:{port}' + path, headers=headers,
        data=None if body is None else json.dumps(body).encode(), method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try: code = json.load(error).get('error', 'native_administration_unavailable')
        except Exception: code = 'native_administration_unavailable'
        allowed = {'configuration_conflict', 'profile_scope_denied', 'invalid_preference',
                   'unsupported_preference', 'managed_operation_unavailable', 'setting_managed_by_nocheh'}
        raise ValueError(code if code in allowed or isinstance(code,str) and code.startswith(('cron_','invalid_cron_')) else 'native_administration_unavailable') from None


def main(state, command, args):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('show', 'set', 'inherit', 'profiles', 'status'))
    parser.add_argument('key', nargs='?'); parser.add_argument('value', nargs='?')
    parser.add_argument('--profile'); parser.add_argument('--job'); parser.add_argument('--revision')
    options = parser.parse_args(args)
    query = urlencode({k:v for k,v in {'profile': options.profile, 'job': options.job}.items() if v})
    path = ('/api/nocheh/preferences' if options.profile and not options.job else '/api/nocheh/policy') if command == 'policy' else '/api/config'
    if options.action in ('profiles', 'status'): path = '/api/' + options.action
    path += '?' + query
    current = call(state, path)
    if options.action in ('set', 'inherit'):
        if command != 'policy': parser.error('Use policy set/inherit for revision-checked preference writes.')
        if not options.key or (options.action == 'set' and options.value is None): parser.error('Provide a preference key and value.')
        value = None
        if options.action == 'set':
            try: value = json.loads(options.value)
            except json.JSONDecodeError: value = options.value
        current = call(state, path, {'changes': {options.key:value}, 'revision': options.revision or current['revision']}, 'PUT')
    print(json.dumps(current, ensure_ascii=False, indent=2))
    return 0
