"""Use the same supported Node major for host services and Docker builds."""
import os
import shutil
import subprocess
from .configuration import ROOT


def executable(env=None):
    env=os.environ if env is None else env
    node=env.get('NOCHEH_NODE') or shutil.which('node',path=env.get('PATH'))
    if not node:raise ValueError('Node 24 is required; install it or set NOCHEH_NODE to its executable.')
    version=subprocess.check_output([node,'-p','process.versions.node'],text=True,timeout=10).strip()
    if version.split('.')[0]!='24':raise ValueError('Node 24 is required; set NOCHEH_NODE to a Node 24 executable.')
    return node


def build(env=None):
    subprocess.run([executable(env),str(ROOT/'scripts/build.mjs')],cwd=ROOT,env=env,check=True)
