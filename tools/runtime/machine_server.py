"""nocheh-machines: runs the commands of owner-approved jobs on the owner's machines over SSH.

Standard library only; started as ``python3 -m tools.runtime.container_service machines`` in the management image.
Every route except GET /health needs ``Authorization: Bearer $NOCHEH_MACHINE_TOKEN``, which only nocheh-app holds besides it;
without a token of at least 32 characters every route refuses with 503. Each machine's key, public key and trusted
host key live in /machines/<id>/ (key, key.pub, known_hosts); no route returns or logs a private key.

ssh runs with fixed options only: the request names a machine id, address, port and login, each checked against a
fixed pattern, never an option. The remote command prints a random marker and then execs bash with a fixed wrapper
(WRAP) and the script as one argument, with the job's tag (TAG) in its environment; what comes before the marker (shell
start-up noise, ssh's own warnings) is dropped and, when ssh ends before it, tells why the connection failed. POST /exec answers 502 {error} for such a
failure; once the marker came it answers 200 with frames, as tools/runtime/box_server.py does: b'O', a 4-byte length
and output bytes, then b'X', 4 and the exit code as a signed 4-byte int (124 at the time limit). A client that goes
away ends ssh. A machine whose key file is missing (keys are not in backups) answers machine_key_missing.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import select
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT=8789
ID=re.compile(r'[a-f0-9]{32}')
# A background job's id: the tag of the programs its commands start.
JOB=re.compile(r'[a-f0-9]{64}')
ADDRESS=re.compile(r'[A-Za-z0-9][A-Za-z0-9.:-]{0,252}')
LOGIN=re.compile(r'[a-z_][a-z0-9_-]{0,31}')
HOST_KEY=re.compile(r'SHA256:[A-Za-z0-9+/]{43}')
COMMENT=re.compile(r'[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}')
MAX_BODY=32<<20
MAX_SCRIPT=96<<10
MAX_STDIN=4<<20
# The remote command is one argument to the login's shell, and Linux allows one argument 128 KiB.
MAX_REMOTE=120<<10
# One answer's output frames, each with its 5-byte head, stay within this; then come the capped note and the exit code. The
# relay allows 8 MiB and 64 KiB in all, and output that comes a line at a time comes in as many frames.
MAX_OUTPUT=8<<20
CAPPED=b'\n[machine: output capped at 8 MiB]\n'
# Shell start-up noise before the marker; more than this and the remote shell is not answering as it should.
NOISE=64<<10
# Hermes stops a command at its own timeout first, and the machine at the same time limit (WRAP); nocheh-machines stops
# ssh a little later.
GRACE=5
# Something may still hold ssh's output after ssh ended; the reply ends this long after ssh does.
TAIL=.3
# Runs the script on the machine as `bash --norc -c WRAP nocheh <seconds> <-l or ''> <script>`, after the marker. sshd keeps a
# reply open until everything holding the command's output has closed it, so a program the script starts in the background
# without redirecting its output, such as Hermes's own background start, would hold the reply until the time limit. As in the
# box, the reply instead ends with the script's bash: its output (stdout and stderr, in order) goes through a private FIFO that
# a cat copies to the channel. The FIFO's private folder is removed once both ends are open, and the script's subshell tells
# its PID over the pipe that tells WRAP when cat ends (cat holds its write end as fd 4). Once the script's bash has ended,
# cat stops when it has copied everything (end of file, the only case it is not killed), or after 0.3 s while a program
# the script started still runs, or after at most 10 s when none does, which leaves time for output still on its way. Where coreutils'
# timeout exists (or gtimeout, its name from Homebrew on macOS), the script runs under `timeout -k 5`: at the time limit it
# ends the script and the programs it started, all in timeout's own process group (whose id is that PID), and the command
# ends with 124. Without that timeout, or without /proc for the PID hand-off (macOS), the cat gets 0.3 s; without mkfifo,
# mktemp or bash 4 the script runs as it did before, its programs holding the reply. First of all WRAP opens the job's marker
# file as fd 7 (see TAG), which the script and every program it starts inherit; where it cannot, nothing runs and the
# command ends with 125 and says why, since Stop could not find the job's programs. stdin and
# exit codes pass through. WRAP itself never prints (its stderr goes to /dev/null at once) and does not rely on set -e or
# set -u being off, which an exported SHELLOPTS could turn on. --norc: a bash that sshd started would read ~/.bashrc again,
# after the marker. The login's shell only parses `exec bash ... 'WRAP' ...`, so a dash or busybox login shell works too.
WRAP=b'''exec 8>&2 2>/dev/null
t= d= c= p= r=0 s=0 m=~/.nocheh/jobs
if ! { mkdir -p -m 700 "$m" && touch -- "$m/$NOCHEH_STARTED" && exec 7<"$m/$NOCHEH_STARTED"; }; then
echo "nocheh: cannot open $m/$NOCHEH_STARTED, which Stop needs to find this job's programs; nothing ran." >&8; exit 125
fi
find "$m" -type f -mtime +30 -exec rm -f {} + </dev/null >/dev/null
for x in timeout gtimeout; do if v=$($x --version) && [[ $v == *coreutils* ]]; then t="$x -k 5 $1"; break; fi; done
if ((BASH_VERSINFO[0]<4)) || ! d=$(mktemp -d "${TMPDIR:-/tmp}/nocheh.XXXXXXXXXX") || ! mkfifo -m 600 "$d/o"; then
if [ -n "$d" ]; then rm -rf -- "$d"; fi
exec $t bash --norc $2 -c "$3" 2>&8 8>&-
fi
exec 9>&1 3< <(echo $BASHPID; exec cat -- "$d/o" 4>&1 >&9 9>&- 8>&- </dev/null) 9>&-
read -r c <&3 || :
(echo $BASHPID 2>/dev/null >/proc/$c/fd/4; rm -rf -- "$d" 2>/dev/null; exec $t bash --norc $2 -c "$3") >"$d/o" 2>&1 3<&- 8>&- || r=$?
read -r -t 0.1 -u 3 p || :
read -r -t 0.3 -u 3 x || s=$?
if ((s>128)) && [ -n "$t" ] && [ -n "$p" ] && ! kill -0 -- -$p; then s=0; read -r -t 10 -u 3 x || s=$?; fi
if ((s!=1)); then kill -KILL $c || :; fi
exit $r
'''
# Connection tests get this long, cleanups CLEANING.
SHORT=30
CLEANING=60
# Multiplexed connections live in the container's own /tmp, one set per machine.
CONTROL=Path('/tmp')
# Every command of a job runs with TAG=<the job's id> in its environment and, from WRAP, with fd 7 open on the job's marker
# file (~/.nocheh/jobs/<the job's id>, kept 30 days); the programs it starts inherit both.
TAG='NOCHEH_STARTED'
# Ends the programs a job started as the login ($1 is the job's id), and nothing else the login runs: not the owner's own,
# since the login may be one the owner uses, nor what other jobs left. A program is the job's when it holds the job's marker
# open, carries its tag, or was started by one that does (see hits). Each way alone misses some: a program may close what it
# inherited, write a new name over its environment (redis, or Perl and Node programs that rename themselves), or keep its
# environment from being read (on macOS the system's own programs, such as sleep; on Linux an ssh-agent). On Linux it reads
# /proc; elsewhere (macOS) it asks `lsof` for the marker's holders and `ps -E` for tags, checking each process that shows
# the tag on its own. It first proves it can find a program by a marker: a `sleep` that holds a probe file open must be
# found, else it fails rather than claim it ended something. Up to five rounds end the programs started meanwhile; if the
# job's programs are still there after them it fails too. It ends after two rounds in a row find none. Lists reach awk
# through its environment, since BWK awk (macOS) refuses a newline in -v. bash 3.2 runs it as well.
CLEANUP=r'''exec 2>/dev/null </dev/null
j=$1 m=~/.nocheh/jobs u=$(id -un) proc=
[ -r /proc/$$/stat ] && proc=1
# The login's live processes, other than this shell, that are the job's: those that hold file $2 open, those that any of
# these started, and those with tag $1, unless a program of the login that shows its own environment without the tag is
# above them before init (launchd), a process of another user or one of the job's (such as a session manager that took the
# tag over and started them). A program whose environment cannot be read (on macOS the system's own, such as /bin/sh; on
# Linux one that wrote over it) shows none. Its text never spells out a tag it looks for, which it would then find in its
# own command line.
# Without /proc: the words of process $1's environment, one per line, which `ps -E` prints after its command line (none
# where the environment cannot be read); fails where ps answers otherwise. (It cuts by length: a pattern would take time
# that grows with the square of a long command line.)
vars() {
  local a b
  a=$(ps -ww -o command= -p "$1") && b=$(ps -E -ww -o command= -p "$1") && [ "${b:0:${#a}}" = "$a" ] || return 1
  printf '%s\n' "${b:${#a}}" | tr ' ' '\n'
}
# Whether process $1 carries tag $2 (0), only names it in its command line (1), or neither (2). ps takes as many words
# for the command line as the program had arguments, so where a program wrote a longer name over them (Node's
# process.title), the start of its environment shows in the command line: where the first word is not the program's
# name, the tag counts anywhere.
has() {
  local a b w c
  a=$(ps -ww -o command= -p "$1") && b=$(ps -E -ww -o command= -p "$1") || return 2
  printf '%s\n' "$b" | tr ' ' '\n' | grep -qxF -- "$2" || return 2
  if [ "${b:0:${#a}}" = "$a" ]; then printf '%s\n' "${b:${#a}}" | tr ' ' '\n' | grep -qxF -- "$2" && return 0; fi
  w=$(printf '%s\n' "$a" | awk 'NR==1 {print $1}') && c=$(ps -o ucomm= -p "$1" | awk 'NR==1 {sub(/[ \t]+$/, ""); print}') || return 2
  w=${w#-}; w=${w##*/}
  [ -n "$c" ] && [ "${w:0:${#c}}" = "$c" ] && return 1
  return 0
}
# Whether process $1 shows its own environment, without tag $2 anywhere in what ps -E prints.
shows() {
  local v
  v=$(vars "$1") && printf '%s\n' "$v" | grep -q '^[A-Za-z_][A-Za-z0-9_]*=' || return 1
  ! ps -E -ww -o command= -p "$1" | tr ' ' '\n' | grep -qxF -- "$2"
}
hits() {
  local tag=$1 file=$2 e d p f v w rest dirs all table= marked= tagged= plain=
  if [ -n "$proc" ]; then
    for e in /proc/[0-9]*; do
      p=${e#/proc/}
      [ "$p" != $$ ] && [ -O "$e" ] && read -r rest <"$e/stat" || continue
      rest=${rest##*) }; set -- $rest; dirs=$e w=
      # A program whose first thread ended while others run shows as a zombie; its threads hold its files and environment.
      if [ "$1" = Z ]; then [ "${18}" -gt 1 ] || continue; dirs=$(echo "$e"/task/*); fi
      table="$table$p $2
"
      for d in $dirs; do
        for f in "$d"/fd/*; do if [ "$f" -ef "$file" ]; then marked="$marked $p"; continue 3; fi; done
        while IFS= read -r -d '' v; do
          if [ "$v" = "$tag" ]; then tagged="$tagged $p"; continue 3; fi
          [ -n "$w" ] || case ${v%%=*} in "$v"|''|[0-9]*|*[!A-Za-z0-9_]*) ;; *) w=1;; esac
        done <"$d/environ"
      done
      [ -z "$w" ] || plain="$plain $p"
    done
  else
    marked=$(lsof -t -w -- "$file" | tr '\n' ' ')
    table=$(ps -x -U "$u" -o pid= -o ppid= -o stat=) && [ -n "$table" ] || return 1
    table=$(printf '%s\n' "$table" | awk '$3 !~ /^Z/ {print $1, $2}')
    # ps -E prints each command line, which may span lines, then the environment: each process that shows the tag is
    # checked on its own, and where one shows it nowhere, the line was another's: then every process is.
    all=
    for p in $(ps -E -ww -x -U "$u" -o pid= -o command= | awk -v t="$tag" '$1 ~ /^[0-9]+$/ {p=$1} {for (i=1; i<=NF; i++) if ($i==t) {print p; next}}'); do
      has "$p" "$tag"; case $? in 0) tagged="$tagged $p";; 2) all=1;; esac
    done
    if [ -n "$all" ]; then for p in $(printf '%s\n' "$table" | awk '{print $1}'); do ! has "$p" "$tag" || tagged="$tagged $p"; done; fi
    # Only the programs above one with the tag, up to the marker's holders and what they started, matter: each is asked
    # on its own whether it shows an environment.
    for p in $(printf '%s\n' "$table" | M=$marked T=$tagged awk '
      BEGIN {n=split(ENVIRON["M"], a, " "); for (i=1; i<=n; i++) k[a[i]]=1; n=split(ENVIRON["T"], a, " "); for (i=1; i<=n; i++) tg[a[i]]=1}
      NF>=2 {up[$1]=$2}
      END {do {more=0; for (p in up) if (!(p in k) && (up[p] in k)) {k[p]=1; more=1}} while (more)
           for (p in tg) if (!(p in k)) {q=p; for (n=0; n<64 && (q in up); n++) {q=up[q]; if (q==1 || !(q in up) || (q in k)) break; if (!(q in tg) && !(q in seen)) {seen[q]=1; print q}}}}'); do
      ! shows "$p" "$tag" || plain="$plain $p"
    done
  fi
  printf '%s\n' "$table" | M=$marked T=$tagged P=$plain awk -v me=$$ '
    function left(p,  q, n) {for (q=up[p]; n<64; n++) {if (q==1 || !(q in up) || (q in k)) return 1; if (q in pl) return 0; q=up[q]}; return 0}
    BEGIN {n=split(ENVIRON["M"], a, " "); for (i=1; i<=n; i++) mk[a[i]]=1; n=split(ENVIRON["T"], a, " "); for (i=1; i<=n; i++) tg[a[i]]=1
           n=split(ENVIRON["P"], a, " "); for (i=1; i<=n; i++) pl[a[i]]=1}
    NF>=2 && $1!=me {up[$1]=$2; id[++c]=$1}
    END {for (i=1; i<=c; i++) if (id[i] in mk) k[id[i]]=1
         do {more=0; for (i=1; i<=c; i++) {p=id[i]; if (!(p in k) && ((up[p] in k) || ((p in tg) && left(p)))) {k[p]=1; more=1}}} while (more)
         for (i=1; i<=c; i++) if (id[i] in k) print id[i]}'
}
mkdir -p -m 700 "$m" && : >"$m/probe-$$" && exec 6<"$m/probe-$$" || exit 3
sleep 60 >/dev/null & s=$!
exec 6<&-
case " $(hits "NOCHEH_PROBE=$$" "$m/probe-$$" | tr '\n' ' ') " in *" $s "*) ok=1;; *) ok=;; esac
kill -KILL $s; rm -f -- "$m/probe-$$"
[ -n "$ok" ] || exit 3
n=0 e=0
while :; do
  pids=$(hits "NOCHEH_STARTED=$j" "$m/$j") || exit 3
  if [ -n "$pids" ]; then
    [ $n -lt 5 ] || exit 4
    kill -KILL $pids; n=$((n+1)) e=0
  else
    # Done after two empty rounds a second apart: a program that left its parent during a round is found in the next.
    e=$((e+1)); if [ $e -ge 2 ]; then rm -f -- "$m/$j"; exit 0; fi
  fi
  sleep 1
done'''
REQUESTS={'/keys':('id','comment'),'/test':('id','address','port','login','host_key'),
          '/exec':('id','address','port','login','host_key','job','script','stdin','timeout','login_shell'),
          '/cleanup':('id','address','port','login','host_key','job'),'/forget':('id',),'/remove':('id',)}
KEYS=threading.Lock()


class Refused(Exception):
    def __init__(self,status,code):super().__init__(code);self.status,self.code=status,code


def environment():
    # ssh gets no token and no agent; HOME is the container's tmpfs.
    return {'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':os.environ.get('HOME','/tmp'),'LANG':'C.UTF-8'}


def raw(text):
    try:return text.encode('utf-8','surrogateescape')
    except UnicodeEncodeError:return text.encode('utf-8','replace')


def quote(data):return b"'"+data.replace(b"'",b"'\\''")+b"'"


def version():
    """ssh's version line, or None when ssh cannot run here: also when this uid has no passwd entry, which ssh -V says
    with exit 255 before its version."""
    try:
        result=subprocess.run(['ssh','-V'],env=environment(),stdin=subprocess.DEVNULL,capture_output=True,timeout=10)
        if result.returncode:return None
        return (result.stderr or result.stdout).decode('utf-8','replace').strip().splitlines()[0][:200] or None
    except (OSError,subprocess.SubprocessError,IndexError):return None


def fingerprints(path):
    """SHA256 fingerprints of the host keys a known_hosts file holds, written as ssh-keygen -l writes them."""
    try:lines=path.read_text(errors='replace').splitlines()
    except (FileNotFoundError,NotADirectoryError):return set()
    found=set()
    for line in lines:
        parts=line.split()
        if len(parts)<3 or parts[0].startswith(('#','@')):continue
        try:blob=base64.b64decode(parts[2],validate=True)
        except ValueError:continue
        found.add('SHA256:'+base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('='))
    return found


def line(text):
    """The last line ssh said before it gave up: short, printable, never key material."""
    lines=[re.sub(r'[^\x20-\x7e]','',value).strip() for value in text.decode('utf-8','replace').splitlines()]
    return next((value[:200] for value in reversed(lines) if value),'')


def failure(text,known):
    if b'Permission denied' in text:return 'machine_auth_failed'
    if b'REMOTE HOST IDENTIFICATION HAS CHANGED' in text or b'Host key verification failed' in text:
        return 'machine_host_key_changed' if known.exists() else 'machine_host_key_unknown'
    return 'machine_unreachable'


def target(value,exec_=False):
    """The machine a request names, checked: its patterns keep every value out of ssh's options."""
    ident,address,port,login=value.get('id'),value.get('address'),value.get('port'),value.get('login')
    if not (isinstance(ident,str) and ID.fullmatch(ident)):raise Refused(400,'invalid_machine_request')
    if 'address' not in value:return ident,None,None,None,None
    host_key=value.get('host_key')
    if (not isinstance(address,str) or not ADDRESS.fullmatch(address) or type(port) is not int or not 1<=port<=65535
            or not isinstance(login,str) or not LOGIN.fullmatch(login)
            or host_key is not None and not (isinstance(host_key,str) and HOST_KEY.fullmatch(host_key))
            or exec_ and host_key is None):raise Refused(400,'invalid_machine_request')
    return ident,address,port,login,host_key


def job_of(value):
    """The job a command or cleanup is for, checked: its id goes on the machine as the programs' tag."""
    job=value.get('job')
    if not (isinstance(job,str) and JOB.fullmatch(job)):raise Refused(400,'invalid_machine_request')
    return job


def kill(proc):
    if proc.poll() is None:
        try:os.killpg(proc.pid,signal.SIGKILL)
        except OSError:pass
    proc.wait()
    for pipe in (proc.stdin,proc.stdout):
        if pipe is not None:
            try:pipe.close()
            except OSError:pass


def feed(pipe,data):
    try:pipe.write(data)
    except OSError:pass
    finally:
        try:pipe.close()
        except OSError:pass


class Machines:
    def __init__(self,root,token):self.root,self.token,self.cleaning=Path(root),token if len(token or '')>=32 else '',{}

    def folder(self,ident,create=False):
        path=self.root/ident
        if create and not path.exists():path.mkdir(mode=0o700)
        if path.is_symlink() or path.exists() and not path.is_dir():raise Refused(500,'machine_unavailable')
        return path

    def close(self,ident):
        """Ends this machine's shared connections, so the next command connects and checks its host key again."""
        for path in CONTROL.glob('cm-'+ident+'-*'):
            try:subprocess.run(['ssh','-F','/dev/null','-o','ControlPath='+str(path),'-O','exit','nocheh-machine'],env=environment(),
                               stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            except (OSError,subprocess.SubprocessError):pass
            path.unlink(missing_ok=True)

    def ssh(self,ident,address,port,login,remote,stdin,trust=False,shared=True):
        folder=self.root/ident
        return ['ssh','-F','/dev/null','-i',str(folder/'key'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',
                '-o','StrictHostKeyChecking='+('accept-new' if trust else 'yes'),'-o','UserKnownHostsFile='+str(folder/'known_hosts'),
                '-o','GlobalKnownHostsFile=/dev/null','-o','UpdateHostKeys=no','-o','ConnectTimeout=10','-o','ServerAliveInterval=15',
                '-o','ServerAliveCountMax=3',*(['-o','ControlMaster=auto','-o','ControlPersist=60','-o',f'ControlPath={CONTROL}/cm-{ident}-%C']
                if shared else ['-o','ControlMaster=no','-o','ControlPath=none']),'-e','none',*([] if stdin else ['-n']),
                '-p',str(port),'-l',login,'--',address,remote]

    def untrusted(self,ident,host_key):
        """Why not to connect: no key, or a stored host key that is not exactly the one the store trusts."""
        if not (self.root/ident/'key').is_file():return 'machine_key_missing'
        found=fingerprints(self.root/ident/'known_hosts')
        return 'machine_host_key_unknown' if not found else 'machine_host_key_changed' if found!={host_key} else None

    def start(self,argv,stdin=None):
        proc=subprocess.Popen(argv,env=environment(),stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE,
                              stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        if stdin is not None:threading.Thread(target=feed,args=(proc.stdin,stdin),daemon=True).start()
        return proc

    @staticmethod
    def opened(proc,marker,deadline,client=None):
        """ssh's output up to the marker: (rest, None) once the remote shell runs, else (what came, why it did not):
        'exited', 'timeout', 'noise' or 'gone' (the client left)."""
        output=proc.stdout.fileno();poller=select.poll();poller.register(output,select.POLLIN)
        if client is not None:poller.register(client,select.POLLIN)
        held=b'';open_=True;ended=None
        while True:
            for number,_ in poller.poll(100):
                if number==client:return held,'gone'
                chunk=os.read(output,65536)
                if not chunk:poller.unregister(output);open_=False;continue
                held+=chunk;at=held.find(marker)
                if at>NOISE:return held,'noise'
                if at>=0:return held[at+len(marker):],None
                if len(held)>NOISE+len(marker):return held,'noise'
            if proc.poll() is not None:
                ended=ended or time.monotonic()
                if not open_ or time.monotonic()-ended>TAIL:return held,'exited'
            elif time.monotonic()>deadline:return held,'timeout'

    @staticmethod
    def pump(proc,first,deadline,emit,client=None):
        """Hands the output after the marker to emit until ssh ends: its exit code, 124 at the deadline, None when
        the client left. An ssh ended by a signal ends with 128 and its number, as a shell says it."""
        output=proc.stdout.fileno();poller=select.poll();poller.register(output,select.POLLIN)
        if client is not None:poller.register(client,select.POLLIN)
        if first:emit(first)
        open_=True;ended=None
        while True:
            for number,_ in poller.poll(100):
                if number==client:return None
                chunk=os.read(output,65536)
                if chunk:emit(chunk)
                else:poller.unregister(output);open_=False
            if proc.poll() is not None:
                ended=ended or time.monotonic()
                if not open_ or time.monotonic()-ended>TAIL:return proc.returncode if proc.returncode>=0 else 128-proc.returncode
            elif time.monotonic()>deadline:return 124

    def short(self,ident,address,port,login,command,trust=False,shared=True,seconds=None):
        """Runs one short command; (exit code, output) or (None, failure code, detail)."""
        known=self.root/ident/'known_hosts';marker=('\x1enocheh-'+secrets.token_hex(8)+'\x1e').encode()
        remote=b"printf '%s' '"+marker+b"'; "+command
        proc=self.start(self.ssh(ident,address,port,login,remote,None,trust,shared));deadline=time.monotonic()+(seconds or SHORT)
        try:
            rest,why=self.opened(proc,marker,deadline)
            if why:return None,failure(rest,known) if why=='exited' else 'machine_unreachable',line(rest) or 'The machine did not answer in time.'
            output=[]
            def keep(chunk):
                if sum(map(len,output))<NOISE:output.append(chunk)
            code=self.pump(proc,rest,deadline,keep)
            return code,b''.join(output)
        finally:kill(proc)

    def keys(self,value):
        ident,*_=target(value);comment=value['comment']
        if not (isinstance(comment,str) and COMMENT.fullmatch(comment)):raise Refused(400,'invalid_machine_request')
        with KEYS:
            folder=self.folder(ident,create=True);key,public=folder/'key',folder/'key.pub'
            if not (key.is_file() and public.is_file()):
                for path in (key,public):path.unlink(missing_ok=True)
                try:made=subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C',comment,'-f',str(key)],env=environment(),
                                        stdin=subprocess.DEVNULL,capture_output=True,timeout=60).returncode==0
                except (OSError,subprocess.SubprocessError):made=False
                if not made or not public.is_file():raise Refused(500,'machine_unavailable')
            text=public.read_text().strip()
        if not 0<len(text)<=1000:raise Refused(500,'machine_unavailable')
        return {'public_key':text}

    def test(self,value):
        ident,address,port,login,host_key=target(value)
        folder=self.folder(ident);known=folder/'known_hosts'
        if not (folder/'key').is_file():
            return {'ok':False,'error':'machine_key_missing','detail':'Nocheh has no key for this machine. Keys are not in backups.'}
        if host_key is None:
            # Trusting anew: a shared connection made under the old trust must not carry on.
            self.close(ident);known.unlink(missing_ok=True)
        else:
            found=fingerprints(known)
            if not found:return {'ok':False,'error':'machine_host_key_unknown','detail':'No host key is trusted for this machine.'}
            if found!={host_key}:return {'ok':False,'error':'machine_host_key_changed','detail':'The stored host key is not the trusted one.'}
        # A test always opens its own connection, so it proves the machine answers and checks its host key now.
        code,*result=self.short(ident,address,port,login,b'exec uname -srm',trust=host_key is None,shared=False)
        if code is None:return {'ok':False,'error':result[0],'detail':result[1]}
        if code!=0:return {'ok':False,'error':'machine_unreachable','detail':line(result[0]) or f'The test command ended with code {code}.'}
        found=fingerprints(known)
        if len(found)!=1 or host_key is not None and found!={host_key}:
            return {'ok':False,'error':'machine_host_key_unknown','detail':'The machine did not send exactly one host key.'}
        return {'ok':True,'host_key':next(iter(found)),'system':line(result[0])}

    def cleanup(self,value):
        ident,address,port,login,host_key=target(value,exec_=True);job=job_of(value)
        self.folder(ident)
        # Cleanups of one machine run one at a time, each over its own connection.
        with self.cleaning.setdefault(ident,threading.Lock()):
            if refused:=self.untrusted(ident,host_key):return {'ok':False,'error':refused}
            code,*result=self.short(ident,address,port,login,b'exec bash --norc -c '+quote(CLEANUP.encode())+b' nocheh '+job.encode(),seconds=CLEANING)
        if code is None:return {'ok':False,'error':result[0]}
        return {'ok':True} if code==0 else {'ok':False,'error':'machine_cleanup_failed'}

    def forget(self,value):
        ident,*_=target(value);self.folder(ident);self.close(ident)
        (self.root/ident/'known_hosts').unlink(missing_ok=True)
        return {'ok':True}

    def remove(self,value):
        ident,*_=target(value);self.close(ident);path=self.root/ident
        if path.is_symlink() or path.is_file():path.unlink()
        elif path.exists():shutil.rmtree(path)
        return {'ok':True}


class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    server_version='nocheh-machines'
    sys_version=''
    # Reading a request; a stream waits longer for a slow reader.
    timeout=60

    streaming=False

    def log_message(self,*_):pass

    def reply(self,status,value):
        data=json.dumps(value).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers()
        self.wfile.write(data);self.close_connection=True

    def do_GET(self):
        if self.path!='/health':return self.reply(404,{'error':'not_found'})
        ssh=self.server.ssh or version();self.server.ssh=ssh
        self.reply(200 if ssh else 503,{'ok':bool(ssh),'service':'machines','ssh':ssh})

    def do_POST(self):
        machines=self.server.machines
        try:
            if not machines.token:raise Refused(503,'machine_unavailable')
            given=self.headers.get('Authorization','').encode('utf-8','surrogateescape')
            if not hmac.compare_digest(given,('Bearer '+machines.token).encode()):raise Refused(401,'unauthorized')
            keys=REQUESTS.get(self.path)
            if keys is None:raise Refused(404,'not_found')
            value=self.body(keys)
            if self.path=='/exec':return self.execute(value)
            self.reply(200,getattr(machines,self.path[1:])(value))
        except Refused as refused:self.reply(refused.status,{'error':refused.code})
        except Exception:
            # Once a stream has started, a reply can only end; the missing X frame tells the client.
            if self.streaming:self.close_connection=True
            else:self.reply(500,{'error':'machine_unavailable'})

    def body(self,keys):
        try:size=int(self.headers.get('Content-Length',''))
        except ValueError:size=-1
        if self.headers.get('Transfer-Encoding') or not 0<size<=MAX_BODY:raise Refused(400,'invalid_machine_request')
        try:value=json.loads(self.rfile.read(size))
        except ValueError:raise Refused(400,'invalid_machine_request') from None
        if not isinstance(value,dict) or set(value)!=set(keys):raise Refused(400,'invalid_machine_request')
        return value

    def chunk(self,data):self.wfile.write(b'%x\r\n%s\r\n'%(len(data),data))

    def execute(self,value):
        machines=self.server.machines;ident,address,port,login,host_key=target(value,exec_=True);job=job_of(value)
        script,stdin,timeout,login_shell=value['script'],value['stdin'],value['timeout'],value['login_shell']
        if (not isinstance(script,str) or '\x00' in script or stdin is not None and not isinstance(stdin,str)
                or type(timeout) is not int or not 1<=timeout<=3600 or type(login_shell) is not bool):raise Refused(400,'invalid_machine_request')
        data=raw(script);given=None if stdin is None else raw(stdin)
        if given is not None and len(given)>MAX_STDIN:raise Refused(400,'invalid_machine_request')
        marker=('\x1enocheh-'+secrets.token_hex(8)+'\x1e').encode()
        remote=(b"printf '%s' '"+marker+b"'; exec env "+TAG.encode()+b'='+job.encode()+b" bash --norc -c "+quote(WRAP)+b' nocheh %d '%timeout+(b'-l' if login_shell else b"''")
                +b' '+quote(data))
        if len(data)>MAX_SCRIPT or len(remote)>MAX_REMOTE:raise Refused(409,'machine_script_too_long')
        machines.folder(ident)
        if refused:=machines.untrusted(ident,host_key):raise Refused(502,refused)
        client=self.connection.fileno();known=machines.root/ident/'known_hosts'
        proc=machines.start(machines.ssh(ident,address,port,login,remote,given is not None),given)
        deadline=time.monotonic()+timeout+GRACE
        try:
            rest,why=machines.opened(proc,marker,deadline,client)
            if why=='gone':self.close_connection=True;return
            if why:raise Refused(502,failure(rest,known) if why=='exited' else 'machine_timeout' if why=='timeout' else 'machine_unreachable')
            self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Transfer-Encoding','chunked')
            self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers()
            self.streaming=self.close_connection=True;self.connection.settimeout(120)
            sent=0;capped=False
            def emit(chunk):
                nonlocal sent,capped
                if capped:return
                piece=chunk[:max(0,MAX_OUTPUT-sent-5)]
                if piece:sent+=5+len(piece);self.chunk(b'O'+struct.pack('>I',len(piece))+piece)
                if len(piece)<len(chunk):capped=True;self.chunk(b'O'+struct.pack('>I',len(CAPPED))+CAPPED)
            code=machines.pump(proc,rest,deadline,emit,client)
            if code is None:return
            kill(proc);self.chunk(b'X'+struct.pack('>I',4)+struct.pack('>i',code));self.wfile.write(b'0\r\n\r\n')
        finally:kill(proc)


class Server(ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=True

    def __init__(self,address,machines):
        super().__init__(address,Handler);self.machines=machines;self.ssh=None


def main(argv=()):
    os.umask(0o077)
    machines=Machines(os.environ.get('NOCHEH_MACHINES_DIR','/machines'),os.environ.get('NOCHEH_MACHINE_TOKEN',''))
    server=Server(('0.0.0.0',int(os.environ.get('NOCHEH_MACHINES_PORT',PORT))),machines);server.ssh=version()
    if not machines.token:print('NOCHEH_MACHINE_TOKEN is not set: machine control stays off (./bin/nocheh up generates it).',file=sys.stderr,flush=True)
    if not server.ssh:print('ssh cannot run here (not installed, or no user for this uid): machine control cannot connect.',file=sys.stderr,flush=True)
    server.serve_forever()


if __name__=='__main__':main(sys.argv[1:])
