"""Talk while it works (ADR-0299): a later message in a chat joins the turn already running there.

Hermes's own steer (``AIAgent.steer`` with a ticket) hands the message to the running agent, which reads it after its
current tool step and answers both in one reply. A message the agent did not read before it finished runs as its own
turn right after, as before, so every message is answered once and in order.

Three parts share the plain line protocol on the turn's stdin: the request line first, then one ``{"steer","ticket"}``
line per joined message. ``Steering`` is the parent's side of one running turn, on the agent's event loop. ``Feed`` is
the child's side: it reads stdin straight from its file descriptor, so a reader left waiting never holds a lock the
interpreter needs at exit."""
import json
import os
import re
import threading
from services.durable import canonical

TICKET=re.compile(r'[a-f0-9]{64}')
LIMIT=2*1024*1024


class Steering:
    """The parent's side of one running turn's steer channel. Offers wait until the turn's process is there, then go to
    its stdin in the order they came. Once the turn ends it says which of them it read (`close`); any other was not, and
    runs as its own turn."""
    def __init__(self,identity):
        self.identity,self.write,self.waiting,self.offered,self.closed,self.joined=identity,None,[],[],False,frozenset()

    def offer(self,ticket,text):
        if self.closed or not TICKET.fullmatch(ticket) or not isinstance(text,str) or not text.strip():return False
        line=canonical({'steer':text,'ticket':ticket})
        if len(line)>LIMIT:return False
        self.offered.append(ticket)
        if self.write is None:self.waiting.append(line)
        else:self._send(line)
        return True

    def _send(self,line):
        try:self.write(line+b'\n')
        except Exception:self.write=None

    def attach(self,write):
        """The turn's process is running: what was offered so far goes to it now."""
        if self.closed:return
        self.write=write
        for line in self.waiting:self._send(line)
        self.waiting=[]

    def close(self,joined=()):
        """The turn ended. Only offers it read, as its result names them, joined it; nothing is offered after this."""
        self.closed,self.write,self.waiting=True,None,[]
        self.joined=frozenset(ticket for ticket in joined if ticket in self.offered) if isinstance(joined,(list,tuple)) else frozenset()


class Feed:
    """The child's stdin as lines, read from its file descriptor without Python's buffered reader."""
    def __init__(self,fd=0):self.fd,self.buffer=fd,b''

    def line(self,limit=LIMIT):
        while b'\n' not in self.buffer:
            if len(self.buffer)>limit:raise ValueError('turn_size_limit')
            chunk=os.read(self.fd,65536)
            if not chunk:
                line,self.buffer=self.buffer,b''
                return line
            self.buffer+=chunk
        line,_,self.buffer=self.buffer.partition(b'\n')
        if len(line)>limit:raise ValueError('turn_size_limit')
        return line


class Steers:
    """The child's side: joined messages go to the agent as Hermes steers while its conversation runs. Hermes reads a
    steer after the newest tool result, so one is handed over only once the agent has run a tool in this turn; before
    that, Hermes would place it among older history. One that comes after the conversation ended is not taken, and
    neither is any after it, so the messages a turn read are always the first ones offered. At the end, a message the
    agent never read is withdrawn and only the ones it read are named."""
    def __init__(self,feed,poll=.02):
        self.feed,self.poll,self.lock,self.agent=feed,poll,threading.Lock(),None
        self.pending,self.taken,self.closed,self.working=[],[],False,False
        self.ended=threading.Event()

    def start(self,agent):
        self.agent=agent
        threading.Thread(target=self._read,name='nocheh-steers',daemon=True).start()
        threading.Thread(target=self._hand_over,name='nocheh-steers-hand-over',daemon=True).start()

    def _read(self):
        while not self.ended.is_set():
            try:
                raw=self.feed.line()
                if not raw:return
                value=json.loads(raw)
            except Exception:return
            if (not isinstance(value,dict) or set(value)!={'steer','ticket'} or not isinstance(value['ticket'],str)
                    or not TICKET.fullmatch(value['ticket']) or not isinstance(value['steer'],str)):return
            with self.lock:
                if self.closed:return
                self.pending.append((value['ticket'],value['steer']))

    def _hand_over(self):
        while not self.ended.wait(self.poll):
            with self.lock:
                if self.closed:return
                # Read only: whether Hermes is running the turn's tools now (run_agent._execute_tool_calls).
                self.working=self.working or getattr(self.agent,'_executing_tools',False) is True
                if not self.working:continue
                for ticket,text in self.pending:
                    if self.agent.steer(text,ticket=ticket):self.taken.append(ticket)
                self.pending=[]

    def finish(self):
        """The tickets the agent read, in order; every other one is taken back out of the agent."""
        with self.lock:
            self.closed=True;self.ended.set();self.pending=[]
            return [ticket for ticket in self.taken if not self.agent.withdraw_steer(ticket)]
