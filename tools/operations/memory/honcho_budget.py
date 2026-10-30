"""Owner-facing Honcho budget summary and revision-checked changes: the memory search
spending limit and the optional monthly thinking limit."""
from services.honcho.meter import Ledger, Rejected
from tools.operations.memory.honcho_setup import PROVIDER_STATE, state_for


def view(provider_state=PROVIDER_STATE):
    return Ledger(state_for(provider_state)/'ledger/budget.sqlite').summary()


def update(request, provider_state=PROVIDER_STATE, connection=None):
    # One change per request: the spending limit in cents, or the thinking limit (None turns it off).
    if not isinstance(request,dict) or set(request) not in ({'limit_cents','expected_revision','operation_id'},
                                                            {'reasoning_limit','expected_revision','operation_id'}):
        raise ValueError('invalid_budget_request')
    if connection is None:
        from tools.operations.archive.archive import API
        connection=API().call('/v1/memory/honcho')['connection']
    if not connection.get('attached') or not connection.get('verified'):
        raise ValueError('honcho_budget_requires_accepted_memory')
    ledger=Ledger(state_for(provider_state)/'ledger/budget.sqlite')
    try:
        if 'reasoning_limit' in request:
            ledger.set_reasoning_limit(request['reasoning_limit'],request['expected_revision'],request['operation_id'])
        else:ledger.set_monthly_limit(request['limit_cents'],request['expected_revision'],request['operation_id'])
    except Rejected as error:raise ValueError(str(error)) from None
    return ledger.summary()
