"""Owner-facing Honcho embedding budget summary and revision-checked changes."""
from services.honcho.meter import Ledger, Rejected
from tools.operations.memory.honcho_setup import PROVIDER_STATE, state_for


def view(provider_state=PROVIDER_STATE):
    return Ledger(state_for(provider_state)/'ledger/budget.sqlite').summary()


def update(request, provider_state=PROVIDER_STATE, connection=None):
    if not isinstance(request,dict) or set(request)!={'limit_cents','expected_revision','operation_id'}:
        raise ValueError('invalid_budget_request')
    if connection is None:
        from tools.operations.archive.archive import API
        connection=API().call('/v1/memory/honcho')['connection']
    if not connection.get('attached') or not connection.get('verified'):
        raise ValueError('honcho_budget_requires_accepted_memory')
    ledger=Ledger(state_for(provider_state)/'ledger/budget.sqlite')
    try:ledger.set_monthly_limit(request['limit_cents'],request['expected_revision'],request['operation_id'])
    except Rejected as error:raise ValueError(str(error)) from None
    return ledger.summary()
