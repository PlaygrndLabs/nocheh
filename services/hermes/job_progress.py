"""A background job run's progress, from Hermes's own plugin hooks: the tokens of each model call, the calls that
reported none, and the to-do list. It does nothing unless a background turn binds it (assistant_turn.run).

Each counted call writes one progress line with the run's totals so far; turn_process relays the lines to the job's
heartbeat, where Nocheh prices them at the job's frozen rates. Nothing reaches a running sealed turn, so the turn gives
the cost notice itself, priced the same way (runCost in src/stores/background-jobs.ts, test/run-cost-examples.json).
"""
import json
import math
import re
import threading
import time

from .usage import _count

# A call that reported no usage is priced as one that read 100,000 prompt tokens and wrote 8,000: deliberately high.
UNKNOWN_INPUT,UNKNOWN_OUTPUT=100000,8000
BUCKETS=('input_tokens','output_tokens','cache_read_tokens','cache_write_tokens')
FIELDS=BUCKETS+('calls',)
TODO_ITEMS,TODO_CONTENT,TODO_STATUS,TODO_SECONDS=50,200,20,60
# One progress line, UTF-8 with its newline.
LINE_BYTES=65536
NOTICE_SHARE=0.8
COST_NOTICE=('[SYSTEM NOTICE — cost budget nearly used] This job has used about 80% of its cost limit. '
             'Stop new discovery now and write the final report from what you have.')
_LOCK=threading.Lock()
_RUN=None


def _number(value):return type(value) in (int,float) and math.isfinite(value)


def priced(rates):return isinstance(rates,dict) and _number(rates.get('input')) and _number(rates.get('output'))


def run_cost(rates,tokens,unknown_calls):
    """USD at the job's frozen rates; the twin of runCost in src/stores/background-jobs.ts (test/run-cost-examples.json)."""
    if not priced(rates):return 0.0
    i,o=rates['input'],rates['output']
    request=rates['request'] if _number(rates.get('request')) else 0
    read=rates['cache_read'] if _number(rates.get('cache_read')) else i
    write=rates['cache_write'] if _number(rates.get('cache_write')) else i
    t=tokens or {'input_tokens':0,'output_tokens':0,'cache_read_tokens':0,'cache_write_tokens':0,'calls':0}
    blind=t['calls']>0 and t['input_tokens']+t['cache_read_tokens']+t['cache_write_tokens']==0
    counted=0 if blind else (t['input_tokens']*i+t['output_tokens']*o+t['cache_read_tokens']*read+t['cache_write_tokens']*write)/1e6+t['calls']*request
    return counted+(unknown_calls+(t['calls'] if blind else 0))*((UNKNOWN_INPUT*i+UNKNOWN_OUTPUT*o)/1e6+request)


def run_tokens(usage):
    """A run's token buckets and calls from Hermes's usage (usage.combine), or None when it reported none."""
    return {field:_count(usage.get(field)) for field in FIELDS} if isinstance(usage,dict) else None


def merge(a,b):
    """Bucketwise larger of two counts; either may be None."""
    if a is None or b is None:return a if b is None else b
    return {field:max(_count(a.get(field)),_count(b.get(field))) for field in FIELDS}


# JSON can carry a lone surrogate, which no UTF-8 line can, and NUL, which no jsonb can; json.loads joins every valid pair.
_UNSAFE=re.compile('[\x00\ud800-\udfff]')


def todo_list(items):
    """A to-do list as a job keeps it, bounded and storable; None when it is not a list."""
    if not isinstance(items,list):return None
    text=lambda value,length:_UNSAFE.sub('\ufffd',str(value))[:length]
    return [{'content':text(item.get('content',''),TODO_CONTENT),'status':text(item.get('status',''),TODO_STATUS)}
            for item in items[:TODO_ITEMS] if isinstance(item,dict)]


def progress_line(value,size):
    """A turn's progress line, checked strictly before it is relayed: its counts and to-do list, else the turn's output is invalid."""
    whole=lambda number,top:type(number) is int and 0<=number<top
    item=lambda entry:(isinstance(entry,dict) and set(entry)=={'content','status'} and isinstance(entry['content'],str)
                       and isinstance(entry['status'],str) and len(entry['content'])<=TODO_CONTENT and len(entry['status'])<=TODO_STATUS)
    if (size>LINE_BYTES or not isinstance(value,dict) or set(value)-{'todo'}!={'event','tokens','unknown_calls'} or value['event']!='progress'
            or not isinstance(value['tokens'],dict) or set(value['tokens'])!=set(FIELDS) or not all(whole(value['tokens'][field],10**12) for field in FIELDS)
            or not whole(value['unknown_calls'],10**6+1)
            or 'todo' in value and not (isinstance(value['todo'],list) and len(value['todo'])<=TODO_ITEMS and all(map(item,value['todo'])))):
        raise RuntimeError('assistant_output_invalid')
    return {key:value[key] for key in ('tokens','unknown_calls','todo') if key in value}


class _Progress:
    def __init__(self,emit,limits,clock):
        self.emit,self.clock=emit,clock
        self.rates,self.cap,self.prior=limits.get('rates'),limits.get('cost_limit_usd'),limits.get('prior_cost_usd')
        self.tokens=dict.fromkeys(FIELDS,0);self.unknown=0
        self.todo=None;self.sent=None;self.sent_at=None
        # The cost notice: None until due, then 'due' until the next tool result carries it, then 'given'.
        self.notice=None

    def todo_due(self,final):
        return self.todo is not None and self.todo!=self.sent and (final or self.sent_at is None or self.clock()-self.sent_at>=TODO_SECONDS)

    def line(self,final=False):
        """One line with the run's totals; the to-do list only when it changed, at most once a minute and at the end."""
        value={'event':'progress','tokens':dict(self.tokens),'unknown_calls':self.unknown}
        if self.todo_due(final):
            # Marked sent first, so a list that cannot be written never holds back the later lines' counts.
            todo=list(self.todo);self.sent,self.sent_at=self.todo,self.clock()
            # A list of escaped characters can pass the line's size: its last items wait for the report.
            while len(json.dumps({**value,'todo':todo},ensure_ascii=False).encode())+1>LINE_BYTES:todo.pop()
            value['todo']=todo
        self.emit(value)

    def call(self,usage):
        if isinstance(usage,dict) and _count(usage.get('input_tokens'))+_count(usage.get('cache_read_tokens'))+_count(usage.get('cache_write_tokens'))>0:
            for bucket in BUCKETS:self.tokens[bucket]+=_count(usage.get(bucket))
            self.tokens['calls']+=1
        else:self.unknown+=1
        if (self.notice is None and priced(self.rates) and self.cap is not None
                and self.prior+run_cost(self.rates,self.tokens,self.unknown)>=NOTICE_SHARE*self.cap):self.notice='due'
        self.line()


def bind(emit,limits,clock=time.monotonic):
    """Count this process's background run; once, before its agent is made."""
    global _RUN
    with _LOCK:
        if (_RUN is not None or not callable(emit) or not isinstance(limits,dict)
                or limits.get('cost_limit_usd') is not None and not _number(limits['cost_limit_usd']) or not _number(limits.get('prior_cost_usd'))):
            raise ValueError('invalid_background_run')
        _RUN=_Progress(emit,limits,clock)


def api_request(usage=None,**_):
    """post_api_request: one model call of the run."""
    if _RUN is None:return None
    try:
        with _LOCK:_RUN.call(usage)
    except Exception:pass
    return None


def auxiliary_call(usage=None,error=None,**_):
    """post_auxiliary_call: one helper call, such as compression or a title; a streamed one reports no usage. A failed attempt is not counted."""
    if _RUN is None or error is not None:return None
    try:
        with _LOCK:_RUN.call(usage)
    except Exception:pass
    return None


def tool_call(tool_name='',result=None,**_):
    """post_tool_call: the to-do list, from todo_list's own result, which always holds the whole list."""
    if _RUN is None or tool_name!='todo_list':return None
    try:
        with _LOCK:
            todo=todo_list(json.loads(result).get('todos')) if isinstance(result,str) else None
            if todo is not None and todo!=_RUN.todo:
                _RUN.todo=todo
                if _RUN.todo_due(False):_RUN.line()
    except Exception:pass
    return None


def tool_result(tool_name='',result=None,**_):
    """transform_tool_result: the due cost notice, once, on the newest tool result."""
    if _RUN is None:return None
    try:
        with _LOCK:
            if _RUN.notice=='due' and isinstance(result,str):
                _RUN.notice='given';return result+'\n\n'+COST_NOTICE
    except Exception:pass
    return None


def finish(result):
    """After the run: Hermes's summary at its iteration cap fires no hook, so it counts as one unknown call; then the last line."""
    if _RUN is None:return
    try:
        with _LOCK:
            if isinstance(result,dict) and str(result.get('turn_exit_reason') or '').startswith('max_iterations_reached'):_RUN.unknown+=1
            _RUN.line(final=True)
    except Exception:pass
