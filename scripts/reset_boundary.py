"""Bind the one-attempt Telegram backlog operation to the verified fresh baseline."""
from . import reset_baseline, reset_protocol, reset_quiescence


def discard_backlog(journal, preflight, token, *, runner=reset_baseline.run,
                    environment=None, command=None, transport=None):
    """Advance only ``telegram_boundary`` after rechecking every empty store.

    The reset journal owns the one-attempt reservation. A lost response remains
    uncertain and this function never retries the transport call.
    """
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (7, 8) or
            journal.value['steps'][6]['step'] != 'empty_baseline' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_telegram_boundary_phase_required')
    observed = None

    def assert_clean():
        nonlocal observed
        observed = reset_baseline.verify(journal, preflight, runner=runner,
                                         environment=environment, command=command)

    def read_generation():
        nonlocal observed
        if observed is None:
            assert_clean()
        generation = observed['generation']; observed = None
        return generation

    result = journal.telegram_boundary(token, assert_clean, read_generation, transport)
    return {'phase': 'telegram_boundary', **result, 'runtime_activated': False}
