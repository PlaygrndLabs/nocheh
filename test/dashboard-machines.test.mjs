import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const compiled = await build({
  entryPoints: ['dashboard/lib/machines.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  addressHint,
  cleanupLine,
  commandAdvice,
  commandQuery,
  commandState,
  endpoint,
  exitBadge,
  localAddress,
  localHint,
  machineAdvice,
  machineBody,
  machineDraft,
  machineEdit,
  machineErrorPhrase,
  machineErrorWords,
  machineProblems,
  machineStatus,
  setupCommand,
  setupLine,
} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const draft = {name: 'build-vm', address: '192.0.2.10', port: '22', login: 'nocheh'};
const machine = {
  id: 'ab12'.repeat(8),
  name: 'build-vm',
  address: '192.0.2.10',
  port: 22,
  login: 'nocheh',
  public_key: 'ssh-ed25519 AAAA nocheh build-vm',
  host_key: 'SHA256:' + 'a'.repeat(43),
  enabled: true,
  tested_at: '2026-01-01T00:00:00Z',
  test_error: null,
  revision: 1,
  created_at: '2026-01-01T00:00:00Z',
  jobs: 0,
};

test('the form refuses what the store refuses, before anything is sent', () => {
  assert.deepEqual(machineProblems(draft), {});
  assert.deepEqual(machineProblems({...draft, address: 'host.docker.internal', port: '2222'}), {});
  assert.deepEqual(machineProblems({...draft, address: 'fd00::10'}), {});
  // An address or login that ssh would read as an option never passes.
  assert.ok(machineProblems({...draft, address: '-oProxyCommand=x'}).address);
  assert.ok(machineProblems({...draft, address: '192.0.2.10 -p 1'}).address);
  assert.ok(machineProblems({...draft, login: '-l'}).login);
  assert.ok(machineProblems({...draft, login: 'Nocheh'}).login);
  assert.ok(machineProblems({...draft, login: 'a'.repeat(33)}).login);
  assert.ok(machineProblems({...draft, name: ' '}).name);
  assert.ok(machineProblems({...draft, name: 'a'.repeat(41)}).name);
  for (const port of ['0', '65536', '22.5', '', 'ssh']) assert.ok(machineProblems({...draft, port}).port, port);
  assert.equal(machineProblems({...draft, port: '65535'}).port, undefined);
  // Names are unique in any case, as the store's index is.
  assert.equal(
    machineProblems({...draft, name: 'Build-VM'}, ['build-vm']).name,
    'Another machine already has this name.',
  );
  assert.deepEqual(machineBody({name: ' build-vm ', address: ' 192.0.2.10', port: ' 22 ', login: 'nocheh '}), {
    name: 'build-vm',
    address: '192.0.2.10',
    port: 22,
    login: 'nocheh',
  });
});

test('a VM on the same computer is host.docker.internal: localhost is flagged, never refused', () => {
  assert.equal(localHint, 'For a VM on this computer, use host.docker.internal, not localhost.');
  assert.equal(
    addressHint,
    'An IP address or a host name. For a VM on this computer, use host.docker.internal, not localhost.',
  );
  for (const address of [
    'localhost',
    'LOCALHOST',
    ' localhost ',
    'vm.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '0:0:0:0:0:0:0:1',
  ]) {
    assert.equal(localAddress(address), true, address);
    // The store takes these, so the form only warns; ::1 it refuses, and the refusal says what to use.
    assert.deepEqual(machineProblems({...draft, address}), address === '::1' ? {address: localHint} : {}, address);
  }
  for (const address of [
    'host.docker.internal',
    '192.0.2.10',
    '10.127.0.1',
    'localhost-vm',
    'fd00::1',
    '::10',
    'build-vm.example.org',
  ])
    assert.equal(localAddress(address), false, address);
});

test('Edit sends all four fields over the revision it read, and says when the machine moves', () => {
  assert.deepEqual(machineDraft(machine), {name: 'build-vm', address: '192.0.2.10', port: '22', login: 'nocheh'});
  // Nothing changed: nothing to send.
  assert.deepEqual(machineEdit(machine, machineDraft(machine)), {
    body: {name: 'build-vm', address: '192.0.2.10', port: 22, login: 'nocheh', revision: 1},
    moved: false,
    changed: false,
  });
  // A new name keeps the host key and the jobs: no confirm.
  assert.deepEqual(machineEdit(machine, {...machineDraft(machine), name: ' web-vm '}), {
    body: {name: 'web-vm', address: '192.0.2.10', port: 22, login: 'nocheh', revision: 1},
    moved: false,
    changed: true,
  });
  // A new address, port or login is another machine to the store: it asks first.
  for (const change of [{address: '192.0.2.11'}, {port: '2222'}, {login: 'builder'}])
    assert.equal(machineEdit(machine, {...machineDraft(machine), ...change}).moved, true, JSON.stringify(change));
  assert.equal(machineEdit(machine, {...machineDraft(machine), address: ' 192.0.2.10 ', port: '022'}).moved, false);
  assert.equal(machineEdit({...machine, revision: 7}, machineDraft(machine)).body.revision, 7);
});

test('a machine reads as Off, Test failed, Ready or Not tested, and never in the alarm tone', () => {
  assert.deepEqual(machineStatus(machine), {label: 'Ready', tone: 'good'});
  assert.deepEqual(machineStatus({...machine, enabled: false, test_error: 'machine_unreachable'}), {
    label: 'Off',
    tone: 'neutral',
  });
  assert.deepEqual(machineStatus({...machine, host_key: null, tested_at: null}), {label: 'Not tested', tone: 'info'});
  assert.deepEqual(machineStatus({...machine, test_error: 'machine_unreachable'}), {
    label: 'Test failed: can’t reach the machine',
    tone: 'warn',
  });
  assert.deepEqual(machineStatus({...machine, host_key: null, test_error: 'machine_auth_failed'}), {
    label: 'Test failed: the machine refused the key',
    tone: 'warn',
  });
  // Ready only while the last test passed: a failed test keeps new jobs off the machine, as the store does.
  assert.deepEqual(machineStatus({...machine, test_error: 'machine_timeout'}), {
    label: 'Test failed: the machine took too long',
    tone: 'warn',
  });
  assert.equal(
    machineStatus({...machine, test_error: 'machine_host_key_changed'}).label,
    'Test failed: the machine’s host key changed',
  );
  // After a restore Nocheh has no key; its name keeps its capital inside the badge.
  assert.equal(
    machineStatus({...machine, test_error: 'machine_key_missing'}).label,
    'Test failed: Nocheh has no key for this machine',
  );
  // Trust a new host key clears the key, the last test and its problem: the next Test trusts the new key.
  assert.deepEqual(machineStatus({...machine, host_key: null, tested_at: null, test_error: null}), {
    label: 'Not tested',
    tone: 'info',
  });
  for (const state of ['running', 'done', 'failed', 'cancelled', 'ambiguous', 'other'])
    assert.notEqual(commandState(state)[1], 'bad', state);
  assert.deepEqual(exitBadge(0), {label: '0', tone: 'good'});
  assert.deepEqual(exitBadge(127), {label: '127', tone: 'warn'});
  assert.equal(exitBadge(null), null);
});

test('error codes become plain words and a next step', () => {
  assert.equal(machineErrorWords('machine_unreachable'), 'Can’t reach the machine');
  assert.equal(machineErrorWords('machine_auth_failed'), 'The machine refused the key');
  assert.equal(machineErrorWords('machine_host_key_changed'), 'The machine’s host key changed');
  assert.equal(machineErrorWords('machine_unavailable'), 'Machine control isn’t running');
  assert.equal(machineErrorWords('job_machine_off'), 'Its machine was turned off or changed');
  assert.equal(machineErrorWords('job_stopped'), 'The job was stopped');
  assert.equal(machineAdvice('invalid_machine', 'nocheh'), 'Check the name, address, port and login.');
  assert.equal(machineErrorWords('configuration_conflict'), 'This changed somewhere else');
  assert.equal(machineErrorWords('machine_new_failure'), 'Machine new failure');
  assert.equal(machineErrorWords(null), '');
  assert.equal(machineErrorPhrase('job_machine_off'), 'its machine was turned off or changed');
  assert.equal(machineErrorPhrase('machine_host_key_unknown'), 'Nocheh lost the machine’s host key');
  // A key lost in a restore and a cleanup that couldn't end the programs each say what to do.
  assert.equal(machineErrorWords('machine_key_missing'), 'Nocheh has no key for this machine');
  assert.match(
    machineAdvice('machine_key_missing', 'nocheh'),
    /aren’t kept in backups\. Remove this machine and add it again\./,
  );
  assert.equal(machineErrorWords('machine_cleanup_failed'), 'Nocheh couldn’t end the job’s programs');
  assert.match(commandAdvice('machine_cleanup_failed'), /may still run on the machine, so end them yourself\.$/);
  assert.match(commandAdvice('machine_key_missing'), /Remove the machine in Settings › Machines and add it again\./);
  assert.equal(commandAdvice('machine_unreachable'), '');
  assert.equal(commandAdvice(null), '');
  // Every code a machine route, test, cleanup or log row can carry has its own words.
  for (const code of [
    'invalid_machine_request',
    'machine_not_allowed',
    'machine_off',
    'machine_changed',
    'machine_time_up',
    'machine_unavailable',
    'machine_unreachable',
    'machine_auth_failed',
    'machine_host_key_changed',
    'machine_host_key_unknown',
    'machine_script_too_long',
    'machine_timeout',
    'machine_key_missing',
    'machine_cleanup_failed',
    'invalid_machine',
    'invalid_machine_query',
    'invalid_settings',
    'machine_name_taken',
    'machine_not_found',
    'job_stopped',
    'job_machine_off',
    'job_machine_unavailable',
  ])
    assert.ok(
      ![code.charAt(0).toUpperCase() + code.slice(1).replaceAll('_', ' '), 'This changed somewhere else'].includes(
        machineErrorWords(code),
      ),
      code,
    );
  assert.match(machineAdvice('machine_auth_failed', 'builder'), /~builder\/\.ssh\/authorized_keys/);
  assert.match(machineAdvice('machine_unavailable', 'nocheh'), /\.\/bin\/nocheh up/);
  assert.equal(
    setupLine('nocheh'),
    'On the machine, signed in as nocheh, paste the setup command into a terminal, or add the public key to ~nocheh/.ssh/authorized_keys yourself. Then press Test.',
  );
});

test('the setup command adds the public key once, with the modes SSH asks for', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDutBo6f45zuPJ6cSri5hzM1HbEERM2PrLAkkXefdFxZ nocheh build-vm';
  const home = mkdtempSync(join(tmpdir(), 'machine-setup-'));
  try {
    for (const shell of ['sh', 'bash']) {
      // Run twice: the line is added once. A key line already there for another machine stays.
      execFileSync(shell, ['-c', 'mkdir -p ~/.ssh && echo "ssh-ed25519 AAAA other" > ~/.ssh/authorized_keys'], {env: {...process.env, HOME: home}});
      for (let i = 0; i < 2; i++) execFileSync(shell, ['-c', setupCommand(key)], {env: {...process.env, HOME: home}});
      assert.deepEqual(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA other\n' + key + '\n', shell);
      assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
      assert.equal(statSync(join(home, '.ssh/authorized_keys')).mode & 0o777, 0o600);
    }
    // A quote in the line stays inside it.
    rmSync(join(home, '.ssh'), {recursive: true});
    execFileSync('sh', ['-c', setupCommand("ssh-ed25519 AAAA it's; touch ~/oops")], {env: {...process.env, HOME: home}});
    assert.equal(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8'), "ssh-ed25519 AAAA it's; touch ~/oops\n");
    assert.throws(() => statSync(join(home, 'oops')));
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test('a stopped machine job says while its programs are ended, and when the owner must end them', () => {
  assert.deepEqual(cleanupLine('pending', 'build-vm'), {text: 'Ending its programs on build-vm…', tone: 'muted'});
  assert.deepEqual(cleanupLine('failed', 'build-vm'), {
    text: 'Nocheh couldn’t end its programs on build-vm. End them yourself.',
    tone: 'warn',
  });
  assert.equal(cleanupLine('done', 'build-vm'), null);
  assert.equal(cleanupLine(null, 'build-vm'), null);
  assert.equal(cleanupLine(undefined, 'build-vm'), null);
});

test('addresses show as ssh would reach them, and the log asks for one page at a time', () => {
  assert.equal(endpoint(machine), 'nocheh@192.0.2.10:22');
  assert.equal(endpoint({...machine, address: 'fd00::10', port: 2222}), 'nocheh@[fd00::10]:2222');
  assert.equal(commandQuery({}), '/machines/commands?limit=25');
  assert.equal(
    commandQuery({machine: machine.id, job: '9c'.repeat(32), all: true, before: 41}),
    `/machines/commands?limit=25&machine=${machine.id}&job=${'9c'.repeat(32)}&kind=all&before=41`,
  );
  assert.equal(commandQuery({all: false, before: null}), '/machines/commands?limit=25');
});
