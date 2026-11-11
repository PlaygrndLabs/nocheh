/**
 * Rules and words of Settings › Machines and System › Machine log, kept apart from the pages so
 * tests need no browser. The patterns are the store's own; the key itself never reaches the dashboard.
 */
import type {Tone} from '../ui/core';

export type Machine = {
  id: string;
  name: string;
  address: string;
  port: number;
  login: string;
  public_key: string;
  host_key: string | null;
  enabled: boolean;
  tested_at: string | null;
  test_error: string | null;
  revision: number;
  created_at: string;
  /** Approved or running jobs that work on it. */
  jobs: number;
};
export type Machines = {available: boolean; enabled: boolean; revision: number; machines: Machine[]};
export type MachineTest = {machine: Machine; result: {ok: boolean; error?: string; host_key?: string; system?: string}};
export type MachineCommand = {
  id: number;
  machine_id: string;
  machine_name: string;
  job_id: string | null;
  job_title: string | null;
  kind: 'command' | 'file' | 'internal' | 'cleanup' | 'test';
  command: string;
  /** The fingerprint of the script that actually ran; none for a test or a cleanup's own script. */
  script_sha256: string | null;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'ambiguous';
  exit_code: number | null;
  output_sha256: string | null;
  output_bytes: number;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
};
export type MachineDraft = {name: string; address: string; port: string; login: string};

const patterns = {
  name: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/,
  address: /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/,
  login: /^[a-z_][a-z0-9_-]{0,31}$/,
};

/** Nocheh connects from inside Docker, where localhost is Nocheh's own container, not the owner's computer. */
export const localHint = 'For a VM on this computer, use host.docker.internal, not localhost.';
export const addressHint = 'An IP address or a host name. ' + localHint;

/** Whether an address is localhost, 127.x.x.x or ::1: a warning on the form, since the store takes all but ::1. */
export const localAddress = (address: string) =>
  /^(?:(?:[a-z0-9-]+\.)*localhost\.?|127(?:\.\d{1,3}){3}|(?:0{0,4}:){2,7}0{0,3}1)$/i.test(address.trim());

/** What is wrong with each field of the machine form, to add or edit one; empty when it can be sent. */
export function machineProblems(
  draft: MachineDraft,
  taken: string[] = [],
): Partial<Record<keyof MachineDraft, string>> {
  const problems: Partial<Record<keyof MachineDraft, string>> = {};
  const name = draft.name.trim(),
    port = draft.port.trim();
  if (!patterns.name.test(name))
    problems.name = 'Use up to 40 letters, digits, spaces, dots, dashes or underscores. Start with a letter or digit.';
  else if (taken.some(other => other.toLowerCase() === name.toLowerCase()))
    problems.name = 'Another machine already has this name.';
  // ::1 is refused as the store refuses it; then the address names what to use instead.
  if (!patterns.address.test(draft.address.trim()))
    problems.address = localAddress(draft.address)
      ? localHint
      : 'Write a host name or an IP address, such as 192.0.2.10.';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    problems.port = 'Use a port from 1 to 65535.';
  if (!patterns.login.test(draft.login.trim()))
    problems.login = 'Use a Linux login name: up to 32 lowercase letters, digits, dashes or underscores.';
  return problems;
}

/** The body Add machine sends. */
export const machineBody = (draft: MachineDraft) => ({
  name: draft.name.trim(),
  address: draft.address.trim(),
  port: Number(draft.port.trim()),
  login: draft.login.trim(),
});

/** A machine as the Edit form starts. */
export const machineDraft = (machine: Machine): MachineDraft => ({
  name: machine.name,
  address: machine.address,
  port: String(machine.port),
  login: machine.login,
});

/**
 * What Edit sends over the revision it read, and whether it moves the machine: a new address, port
 * or login is another machine to the store, which forgets its host key and stops its jobs.
 */
export function machineEdit(machine: Machine, draft: MachineDraft) {
  const body = machineBody(draft);
  const moved = body.address !== machine.address || body.port !== machine.port || body.login !== machine.login;
  return {body: {...body, revision: machine.revision}, moved, changed: moved || body.name !== machine.name};
}

/** Where Nocheh signs in: `login@address:port`, with an IPv6 address in brackets. */
export const endpoint = (machine: Pick<Machine, 'login' | 'address' | 'port'>) =>
  `${machine.login}@${machine.address.includes(':') ? `[${machine.address}]` : machine.address}:${machine.port}`;

/** The one line that tells the owner how the public key gets on the machine. */
export const setupLine = (login: string) =>
  `On the machine, signed in as ${login}, paste the setup command into a terminal, or add the public key to ~${login}/.ssh/authorized_keys yourself. Then press Test.`;

/** A shell command, for the owner to paste on the machine, that adds the public key to the login's authorized_keys once,
 *  with the modes SSH asks for. */
export const setupCommand = (publicKey: string) => {
  const key = `'${publicKey.replaceAll("'", `'\\''`)}'`;
  return (
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
    `{ grep -qxF -- ${key} ~/.ssh/authorized_keys || printf '%s\\n' ${key} >> ~/.ssh/authorized_keys; }`
  );
};

const words: Record<string, string> = {
  machine_unreachable: 'Can’t reach the machine',
  machine_auth_failed: 'The machine refused the key',
  machine_host_key_changed: 'The machine’s host key changed',
  machine_host_key_unknown: 'Nocheh lost the machine’s host key',
  machine_key_missing: 'Nocheh has no key for this machine',
  machine_cleanup_failed: 'Nocheh couldn’t end the job’s programs',
  machine_unavailable: 'Machine control isn’t running',
  machine_off: 'Machine control is off',
  machine_timeout: 'The machine took too long',
  machine_changed: 'The machine was changed during the job',
  machine_time_up: 'The job had no time left',
  machine_not_allowed: 'The job may not use this machine now',
  machine_script_too_long: 'The command was too long',
  invalid_machine_request: 'Nocheh refused the request',
  invalid_machine: 'Nocheh refused these machine details',
  invalid_machine_query: 'Nocheh refused these filters',
  invalid_settings: 'Nocheh refused this setting',
  machine_name_taken: 'Another machine already has this name',
  machine_not_found: 'This machine was removed',
  job_machine_off: 'Its machine was turned off or changed',
  job_machine_unavailable: 'Its run couldn’t be set up for its machine',
  job_stopped: 'The job was stopped',
};

/** A short phrase for an error code from the machine routes or the machine log. */
export function machineErrorWords(code: string | null | undefined): string {
  if (!code) return '';
  if (words[code]) return words[code]!;
  if (/conflict|changed/.test(code)) return 'This changed somewhere else';
  const text = code.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The same phrase inside a sentence: lowercase first, but Nocheh keeps its capital. */
export function machineErrorPhrase(code: string | null | undefined): string {
  const text = machineErrorWords(code);
  return text.startsWith('Nocheh') ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

const keyMissing = 'Machine keys aren’t kept in backups. Remove this machine and add it again.';
const cleanupFailed = 'Programs the job started may still run on the machine, so end them yourself.';

/** What to do after a test or an action failed with this code. */
export function machineAdvice(code: string, login: string): string {
  const advice: Record<string, string> = {
    machine_unreachable: 'Check that the machine is on, and that its address and port are right.',
    machine_auth_failed: `Add the public key to ~${login}/.ssh/authorized_keys on the machine, then press Test again.`,
    machine_host_key_changed:
      'If you reinstalled the machine, press Trust a new host key, then Test. If you didn’t, don’t trust it: something else may answer at its address.',
    machine_host_key_unknown: 'Press Trust a new host key, then Test.',
    machine_unavailable: 'Run ./bin/nocheh up, then try again.',
    machine_off: 'Turn on machine control first.',
    machine_timeout: 'Check that the machine is not too busy, then try again.',
    machine_name_taken: 'Choose another name.',
    invalid_machine: 'Check the name, address, port and login.',
    machine_not_found: 'Reload the page to see your machines.',
    machine_key_missing: keyMissing,
    machine_cleanup_failed: cleanupFailed,
  };
  if (advice[code]) return advice[code]!;
  return /conflict|changed/.test(code) ? 'Check it and try again.' : 'Try again in a minute.';
}

/** What the owner can do about a machine log row with this code; empty when nothing. */
export function commandAdvice(code: string | null | undefined): string {
  const advice: Record<string, string> = {
    machine_key_missing:
      'Machine keys aren’t kept in backups. Remove the machine in Settings › Machines and add it again.',
    machine_cleanup_failed: cleanupFailed,
  };
  return (code && advice[code]) || '';
}

/**
 * The badge of a machine: Off, Test failed, Ready or Not tested. Ready only while its last test
 * passed, as the store's own rule for a machine a new job may ask for. Never the alarm tone;
 * nothing here is new.
 */
export function machineStatus(machine: Machine): {label: string; tone: Tone} {
  if (!machine.enabled) return {label: 'Off', tone: 'neutral'};
  if (machine.test_error) return {label: 'Test failed: ' + machineErrorPhrase(machine.test_error), tone: 'warn'};
  if (machine.host_key) return {label: 'Ready', tone: 'good'};
  return {label: 'Not tested', tone: 'info'};
}

/** What a stopped machine job's cleanup is doing, in a line under the job; none once it is done. */
export function cleanupLine(
  cleanup: 'pending' | 'done' | 'failed' | null | undefined,
  machine: string,
): {text: string; tone: 'warn' | 'muted'} | null {
  if (cleanup === 'pending') return {text: `Ending its programs on ${machine}…`, tone: 'muted'};
  if (cleanup === 'failed')
    return {text: `Nocheh couldn’t end its programs on ${machine}. End them yourself.`, tone: 'warn'};
  return null;
}

export const commandKinds: Record<MachineCommand['kind'], string> = {
  command: 'Command',
  file: 'File',
  internal: 'Internal',
  cleanup: 'Cleanup',
  test: 'Test',
};
export const commandStates: Record<MachineCommand['state'], [string, Tone]> = {
  running: ['Running', 'accent'],
  done: ['Finished', 'neutral'],
  failed: ['Didn’t run', 'warn'],
  cancelled: ['Stopped', 'neutral'],
  ambiguous: ['Unclear', 'warn'],
};

/** A log row's state in words, with its badge tone; an unknown state reads as it is. */
export const commandState = (state: string): [string, Tone] =>
  commandStates[state as MachineCommand['state']] ?? [state, 'neutral'];

/** The exit code as a badge: 0 is good; any other code is worth a look, not an alarm. */
export function exitBadge(code: number | null): {label: string; tone: Tone} | null {
  if (code === null) return null;
  return {label: String(code), tone: code === 0 ? 'good' : 'warn'};
}

/** The machine log's query: one page of commands, newest first, before the cursor. */
export function commandQuery(filters: {machine?: string; job?: string; all?: boolean; before?: number | null}): string {
  const query = new URLSearchParams({limit: '25'});
  if (filters.machine) query.set('machine', filters.machine);
  if (filters.job) query.set('job', filters.job);
  if (filters.all) query.set('kind', 'all');
  if (filters.before) query.set('before', String(filters.before));
  return '/machines/commands?' + query;
}
