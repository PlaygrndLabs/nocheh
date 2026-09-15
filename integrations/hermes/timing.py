"""Allowlisted durations only; no content, URLs, credentials or exceptions."""
from contextlib import contextmanager
from time import perf_counter

PHASES={'bootstrap','memory_recall','history_prepare','agent_init','conversation','context_prepare','model_guard','total'}
VALUES={}


def reset():VALUES.clear()


def record(phase,started):
    if phase not in PHASES:raise ValueError('invalid_timing_phase')
    value=VALUES.setdefault(phase,{'ms':0,'calls':0})
    value['ms']+=max(0,round((perf_counter()-started)*1000));value['calls']+=1


@contextmanager
def measure(phase):
    started=perf_counter()
    try:yield
    finally:record(phase,started)


def safe(value):
    if not isinstance(value,dict):return {}
    return {key:dict(row) for key,row in value.items() if key in PHASES and isinstance(row,dict)
            and set(row)=={'ms','calls'} and all(type(row[k]) is int and 0<=row[k]<=86400000 for k in row)}
