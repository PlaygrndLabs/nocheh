import json
import os
import socket
import threading
import time
import unittest

from .steering import Feed,Steering,Steers
from .security_launcher import Inlet,steer_line

ONE,TWO,THREE,FOUR='1'*64,'2'*64,'3'*64,'4'*64


def line(text,ticket):return json.dumps({'steer':text,'ticket':ticket}).encode()+b'\n'


class Agent:
    """Hermes's own steer buffer, as the pinned agent keeps it (agent.interrupt_control)."""
    def __init__(self):
        from agent.interrupt_control import InterruptControlMixin
        class Native(InterruptControlMixin):pass
        self.native=Native();self.native._pending_steer=None;self.native._pending_steer_lock=threading.Lock();self._executing_tools=False
    def steer(self,text,ticket=None):return self.native.steer(text,ticket=ticket)
    def withdraw_steer(self,ticket):return self.native.withdraw_steer(ticket)
    def drain(self):return self.native._drain_pending_steer()
    def pending(self):return self.native._pending_steer


class SteeringTests(unittest.TestCase):
    def test_offers_wait_for_the_turn_then_go_in_order_and_only_read_ones_join(self):
        steering=Steering('who');sent=[]
        self.assertTrue(steering.offer(ONE,'first'));self.assertTrue(steering.offer(TWO,'second'))
        self.assertFalse(steering.offer('not-a-ticket','third'));self.assertFalse(steering.offer(THREE,'  '))
        self.assertEqual(sent,[],'nothing goes before the turn runs')
        steering.attach(sent.append)
        self.assertEqual([json.loads(value) for value in sent],[{'steer':'first','ticket':ONE},{'steer':'second','ticket':TWO}])
        self.assertTrue(steering.offer(THREE,'third'));self.assertEqual(json.loads(sent[-1])['ticket'],THREE)
        steering.close([ONE,FOUR])
        self.assertEqual(steering.joined,{ONE},'only offers the turn names, and only ones offered to it')
        self.assertFalse(steering.offer(FOUR,'late'),'nothing joins a turn that ended')
        steering=Steering('who');steering.offer(ONE,'first');steering.close('malformed')
        self.assertEqual(steering.joined,frozenset())

    def test_a_broken_stdin_drops_later_offers_without_failing(self):
        steering=Steering('who')
        def broken(value):raise BrokenPipeError()
        steering.attach(broken);self.assertTrue(steering.offer(ONE,'first'));self.assertTrue(steering.offer(TWO,'second'))
        steering.close([]);self.assertEqual(steering.joined,frozenset())


class FeedTests(unittest.TestCase):
    def test_the_request_line_then_steers_then_the_end(self):
        read,write=os.pipe()
        os.write(write,b'{"request":1}\n'+line('first',ONE)+b'{"tail":');os.write(write,b'1}');os.close(write)
        feed=Feed(read)
        self.assertEqual(json.loads(feed.line()),{'request':1})
        self.assertEqual(json.loads(feed.line())['ticket'],ONE)
        self.assertEqual(feed.line(),b'{"tail":1}','the last line needs no newline')
        self.assertEqual(feed.line(),b'');os.close(read)

    def test_a_line_over_the_limit_is_refused(self):
        read,write=os.pipe();os.write(write,b'x'*40+b'\n');os.close(write)
        with self.assertRaisesRegex(ValueError,'turn_size_limit'):Feed(read).line(10)
        os.close(read)


class SteersTests(unittest.TestCase):
    def until(self,condition):
        for _ in range(400):
            if condition():return
            time.sleep(.005)
        self.fail('condition not reached')

    def test_the_agent_reads_joined_messages_and_one_it_never_read_goes_back(self):
        read,write=os.pipe();self.addCleanup(os.close,read)
        agent=Agent();steers=Steers(Feed(read));steers.start(agent)
        os.write(write,line('first',ONE)+line('second',TWO))
        self.until(lambda:len(steers.pending)==2);time.sleep(.05)
        self.assertEqual(steers.taken,[],'nothing goes to the agent before it runs a tool in this turn')
        agent._executing_tools=True
        self.until(lambda:steers.taken==[ONE,TWO]);agent._executing_tools=False
        self.assertEqual(agent.drain(),'first\nsecond','Hermes reads both after its tool step')
        os.write(write,line('third',THREE));self.until(lambda:steers.taken==[ONE,TWO,THREE])
        self.assertEqual(steers.finish(),[ONE,TWO],'the one it never read is not answered by this turn')
        self.assertIsNone(agent.pending(),'and leaves the agent')
        os.write(write,line('late',FOUR));time.sleep(.05)
        self.assertEqual(steers.taken,[ONE,TWO,THREE],'nothing joins after the conversation ended')
        os.close(write)

    def test_a_malformed_line_ends_joining(self):
        read,write=os.pipe();self.addCleanup(os.close,read)
        agent=Agent();agent._executing_tools=True;steers=Steers(Feed(read));steers.start(agent)
        os.write(write,line('first',ONE)+b'{"steer":"x","ticket":"short"}\n'+line('third',THREE));os.close(write)
        self.until(lambda:steers.taken==[ONE]);time.sleep(.05)
        self.assertEqual(steers.taken,[ONE]);self.assertEqual(steers.finish(),[],'a message the agent never read never joins')
        self.assertIsNone(agent.pending())

    def test_a_turn_that_never_ran_a_tool_takes_no_message(self):
        read,write=os.pipe();self.addCleanup(os.close,read);self.addCleanup(os.close,write)
        agent=Agent();steers=Steers(Feed(read));steers.start(agent)
        os.write(write,line('first',ONE));self.until(lambda:len(steers.pending)==1)
        self.assertEqual(steers.finish(),[]);agent._executing_tools=True;time.sleep(.05)
        self.assertEqual((steers.taken,agent.pending()),([],None),'its message runs on its own')


class InletTests(unittest.TestCase):
    def test_lines_wait_for_the_container_and_none_go_after_the_turn(self):
        inlet=Inlet('a'*32);ours,theirs=socket.socketpair();self.addCleanup(ours.close);self.addCleanup(theirs.close)
        self.assertTrue(inlet.send(b'one\n'))
        inlet.connect(ours);self.assertTrue(inlet.send(b'two\n'))
        theirs.settimeout(1);received=b''
        while received.count(b'\n')<2:received+=theirs.recv(64)
        self.assertEqual(received,b'one\ntwo\n')
        inlet.close();self.assertFalse(inlet.send(b'three\n'))

    def test_only_a_well_formed_message_becomes_a_line(self):
        self.assertEqual(json.loads(steer_line({'steer':'hello','ticket':ONE,'nonce':'x','archive_credential':'y'})),{'steer':'hello','ticket':ONE})
        for value in ({'steer':'','ticket':ONE},{'steer':'hi','ticket':'1'},{'steer':5,'ticket':ONE},[]):
            with self.subTest(value=value):self.assertIsNone(steer_line(value))
