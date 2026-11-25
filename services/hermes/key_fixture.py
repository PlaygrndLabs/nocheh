"""One-time key claims for the made-up passes the Hermes tests build (ADR-0305).

Every pass Nocheh mints is a one-time key: its own id (`jti`), the person it is for, its kind and the agent it was made for.
``keyed(claims)`` adds the ones a test did not set, as Nocheh would sign them for those claims: the person is the member
or the lane's member when the pass names one, else the owner; the kind follows the purpose and an ask about a member.
"""

JTI = 'e' * 32


def kind_of(claims):
    """The key kind Nocheh signs for these claims when the test names none."""
    purpose = claims.get('purpose', 'assistant')
    if purpose == 'memory-review': return 'review'
    if purpose == 'filter': return 'filter'
    if claims.get('member_read') is not None: return 'member_ask'
    return 'turn'


def keyed(claims, kind=None, **changes):
    """`claims` with the key claims they lack; `changes` overrides any claim afterwards (None removes it)."""
    person = claims.get('member') or claims.get('lane') or 'owner'
    value = {'jti': JTI, 'person': person, 'key_kind': kind or kind_of(claims), 'agent': 'hermes', **claims}
    for key, changed in changes.items():
        if changed is None: value.pop(key, None)
        else: value[key] = changed
    return value
