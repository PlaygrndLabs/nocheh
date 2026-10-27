"""The owner's dashboard API in a kept fixture, through its localhost preview relay.

The tester signs in like the browser does: it opens the page, keeps the session
cookie and sends the page's CSRF token with every call. Only a fixture started
with --preview-port has the relay.
"""
import json
import re
import urllib.error
import urllib.request


def preview_port(manifest):
    ports = (manifest['services'].get('fixture-preview') or {}).get('ports') or []
    if not ports:
        raise ValueError('fixture_preview_required: start the fixture with --keep --preview-port')
    return int(ports[0]['published'])


class Dashboard:
    def __init__(self, fixture, port=None):
        self.origin = 'http://127.0.0.1:'+str(port or preview_port(fixture.manifest))
        page = urllib.request.urlopen(urllib.request.Request(self.origin+'/'), timeout=60)
        cookies = [value.split(';')[0] for value in page.headers.get_all('Set-Cookie') or [] if value.startswith('nocheh_session=')]
        csrf = re.search(r'window\.__NOCHEH_CSRF__=("[A-Za-z0-9_-]+")', page.read().decode())
        if not cookies or not csrf:
            raise ValueError('dashboard_session_unavailable')
        self.headers = {'cookie': cookies[0], 'x-nocheh-csrf': json.loads(csrf[1])}

    def call(self, method, path, body=None, raw=None, allow_error=False):
        data = raw if raw is not None else None if body is None else json.dumps(body).encode()
        headers = {**self.headers, **({'content-type': 'application/json'} if body is not None else {})}
        request = urllib.request.Request(self.origin+'/api/nocheh'+path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                status, text = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode()
            if not allow_error:
                raise AssertionError('dashboard_http_'+str(status)+':'+path+':'+text[:300]) from None
        value = json.loads(text) if text else None
        return {'status': status, 'body': value} if allow_error else value

    def get(self, path, **options):
        return self.call('GET', path, **options)

    def post(self, path, body, **options):
        return self.call('POST', path, body, **options)

    def put(self, path, raw, **options):
        return self.call('PUT', path, raw=raw, **options)
