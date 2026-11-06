"""A made-up GitHub repository for the fetcher and writer tests (ADR-0209): example-org/widgets, with fixed dates."""
import os
import subprocess
from pathlib import Path

NAME='example-org/widgets'
BRANCH='main'
# A gitlink's commit; the submodule itself is never fetched.
GITLINK='1'*40
DATES={'GIT_AUTHOR_DATE':'2026-01-02T03:04:05Z','GIT_COMMITTER_DATE':'2026-01-02T03:04:05Z'}
# What the tip holds: five files (the symlink and the LFS pointer included) and four folders (src, assets, vendor and
# the gitlink's empty folder).
FILES=5
DIRS=4


def environment(home):
    return {'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':str(home),'LANG':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1',
            'GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_AUTHOR_NAME':'Example Dev',
            'GIT_AUTHOR_EMAIL':'dev@example.invalid','GIT_COMMITTER_NAME':'Example Dev','GIT_COMMITTER_EMAIL':'dev@example.invalid',**DATES}


def git(folder,*args,data=None):
    return subprocess.run(['git','-C',str(folder),*args],env=environment(folder),input=data,stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL,check=True).stdout


def made(folder,variant=None,notes=b''):
    """The work repository at folder/'widgets' and its tip. A variant replaces the tip with an object git's strict
    check refuses ('dotgit', 'no_email') or accepts with FSCK_IGNORE ('zero_padded')."""
    work=Path(folder)/'widgets';work.mkdir(parents=True)
    git(work,'init','-q','-b',BRANCH)
    (work/'src').mkdir();(work/'assets').mkdir()
    (work/'src/widget.py').write_text('# REPOMARK1: the widget\nprint("widgets")\n')
    (work/'README.md').write_text('Widgets for the example organization.\n')
    (work/'assets/logo.png').write_text('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'*64+'\nsize 12345\n')
    (work/'.gitmodules').write_text('[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n')
    os.symlink('/etc/passwd',work/'escape')
    if notes:(work/'notes.txt').write_bytes(notes)
    git(work,'add','-A');git(work,'commit','-q','-m','Add the widgets')
    git(work,'update-index','--add','--cacheinfo','160000,%s,vendor/lib'%GITLINK)
    git(work,'commit','-q','-m','REPOMARK2: vendor the lib')
    if variant:
        blob=git(work,'hash-object','-w','--stdin',data=b'hello\n').strip().decode()
        tree=git(work,'rev-parse','HEAD^{tree}').strip().decode()
        if variant=='dotgit':
            tree=literal(work,'tree',b'100644 .git\0'+bytes.fromhex(blob))
            author=b'Example Dev <dev@example.invalid> 1767323045 +0000'
        elif variant=='zero_padded':
            sub=literal(work,'tree',b'100644 file\0'+bytes.fromhex(blob))
            tree=literal(work,'tree',b'040000 sub\0'+bytes.fromhex(sub))
            author=b'Example Dev <dev@example.invalid> 1767323045 +0000'
        else:
            author=b'Example Dev 1767323045 +0000'
        parent=git(work,'rev-parse','HEAD').strip()
        commit=literal(work,'commit',b'tree %s\nparent %s\nauthor %s\ncommitter %s\n\nA broken tip\n'%(tree.encode(),parent,author,author))
        git(work,'update-ref','refs/heads/'+BRANCH,commit)
    return work,git(work,'rev-parse','refs/heads/'+BRANCH).strip().decode()


def literal(work,kind,data):
    return git(work,'hash-object','-t',kind,'--literally','-w','--stdin',data=data).strip().decode()


def bundle(work,path,extra=None):
    """The branch as a bundle; with `extra`, a pack that also holds that unreachable object."""
    if extra is None:
        git(work,'bundle','create','-q',str(path),'refs/heads/'+BRANCH);return Path(path).read_bytes()
    tip=git(work,'rev-parse','refs/heads/'+BRANCH).strip()
    objects=git(work,'rev-list','--objects','refs/heads/'+BRANCH)+extra.encode()+b'\n'
    pack=git(work,'pack-objects','--stdout',data=objects)
    data=b'# v2 git bundle\n'+tip+b' refs/heads/'+BRANCH.encode()+b'\n\n'+pack
    Path(path).write_bytes(data);return data


def served(work,folder):
    """A bare copy for dumb HTTP at folder/example-org/widgets.git, as a git server keeps it."""
    target=Path(folder)/(NAME+'.git');target.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['git','clone','-q','--bare',str(work),str(target)],env=environment(folder),stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL,check=True)
    git(target,'update-server-info')
    return target
