"""The tester's fake connected services (tools/acceptance/github_mock.py, tools/acceptance/connectors_mock.py).

A connection talks to its fake only in a fixture installation (NOCHEH_INSTALLATION_FIXTURE=1) and only when its address
variable holds the fake's exact address. Requests there are plain http, without proxies or redirects.
"""
import json
import os
import urllib.error
import urllib.request

HOST = 'http://model-fixture:8317'


def on(variable, address):
    """Whether this installation is the tester's fixture and `variable` names the fake at `address`."""
    return os.environ.get('NOCHEH_INSTALLATION_FIXTURE') == '1' and os.environ.get(variable) == address


class Refuse(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def request(url, body=None, headers=None):
    """A GET or, with a body, a JSON POST to a fake. Answers (content, lowercased headers); raises
    RuntimeError('remote_unauthorized') on 401 and RuntimeError('remote_response_rejected') on any other error status."""
    data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    sent = {**(headers or {}), **({} if data is None else {'Content-Type': 'application/json'})}
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), Refuse).open(urllib.request.Request(url, data=data, headers=sent), timeout=15) as response:
            content = response.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024: raise RuntimeError('remote_response_limit')
            return content, {key.lower(): value for key, value in response.getheaders()}
    except urllib.error.HTTPError as error:
        raise RuntimeError('remote_unauthorized' if error.code == 401 else 'remote_response_rejected') from None


def opener(fake):
    """An opener for a connection's own urllib calls: the fake's plain one, or the system's proxies."""
    if fake: return urllib.request.build_opener(urllib.request.ProxyHandler({}), Refuse)
    return urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
