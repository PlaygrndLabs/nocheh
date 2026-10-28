/**
 * Plain owner-facing words and number formats for the System and Usage pages.
 * Internal names (service ids, workflow families, stage codes) never reach the
 * screen directly; unknown codes fall back to readable text.
 */
import type {Tone} from '../ui/core';

/** `snake_case` → "snake case", for codes without a known name. */
export const readable = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ');

const counter = new Intl.NumberFormat();
export const count = (value: number | null | undefined): string => (value == null ? '—' : counter.format(value));

/** A short token count such as 48.2k or 1.3M. */
export function compact(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1000) return counter.format(value);
  if (value < 1e6) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 'k';
  return (value / 1e6).toFixed(1) + 'M';
}

export function money(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return '< $0.01';
  return '$' + value.toFixed(2);
}

/** A cost total. Unpriced calls make it "Unknown" or "At least …"; never zero. */
export function cost(total: {cost: number; unknown: boolean; calls: number}): string {
  if (!total.calls) return '—';
  if (total.unknown && total.cost === 0) return 'Unknown';
  return total.unknown ? 'At least ' + money(total.cost) : money(total.cost);
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  if (ms < 3600000) return (ms / 60000).toFixed(1) + ' min';
  return (ms / 3600000).toFixed(1) + ' h';
}

export function bytes(value: unknown): string {
  if (typeof value !== 'number') return '—';
  let size = value;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (size < 1024 || unit === 'GB') return unit === 'B' ? size + ' B' : size.toFixed(1) + ' ' + unit;
    size /= 1024;
  }
  return '—';
}

export const dateTime = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '—';

/** "just now", "5 min ago", "3 h ago", or the date for older times. */
export function ago(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 60) return 'in a moment';
    if (ahead < 3600) return `in ${Math.round(ahead / 60)} min`;
    return dateTime(value);
  }
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)} d ago`;
  return dateTime(value);
}

export const timeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

/* ---------- Services ---------- */

const serviceNames: Record<string, [string, string]> = {
  'nocheh-dashboard': ['Dashboard', 'This page, settings, backups and recovery'],
  'nocheh-app': ['Message capture', 'Saves incoming messages and runs everyday background work'],
  'nocheh-executor': ['Imports and approved tools', 'Runs chat imports and actions you approved'],
  'nocheh-db': ['Database', 'Stores messages, settings and background work'],
  'nocheh-security': ['Secret check and permissions', 'Hides secrets and checks every action is allowed'],
  hermes: ['Assistant', 'Writes replies and keeps its own notes'],
  'hermes-agent-sb': ['Tool sandbox', 'Starts isolated containers for tools'],
  'inngest-server': ['Background work scheduler', 'Schedules, retries and waits for background work'],
  'inngest-redis': ['Background work queue', 'Holds queued background work'],
  'honcho-api': ['Long-term memory', 'Remembers people and facts across chats'],
  'honcho-deriver': ['Long-term memory learning', 'Learns from new messages in the background'],
  'honcho-postgres': ['Long-term memory database', 'Stores memories and search data'],
  'honcho-redis': ['Long-term memory cache', 'Speeds up memory lookups'],
  'honcho-provider-gateway': ['Long-term memory model access', 'Calls models for memory and tracks spending'],
  'nocheh-miniapp': ['Telegram mini app', 'Home, Inbox and Tasks for you inside Telegram'],
  'nocheh-tunnel': ['Mini app tunnel', 'Connects only the mini app to its public address'],
  'pgweb-archive': ['Archive viewer', 'Optional read-only look at the archive database'],
  'honcho-cli': ['Memory inspector', 'Optional one-off memory inspection'],
};

export const serviceName = (row: {service: string}): string => serviceNames[row.service]?.[0] ?? readable(row.service);
export const servicePurpose = (row: {service: string; purpose?: string}): string =>
  serviceNames[row.service]?.[1] ?? (row.purpose || '');

export function serviceState(state: string): {label: string; tone: Tone} {
  if (state === 'running') return {label: 'Running', tone: 'good'};
  if (state === 'completed') return {label: 'Finished', tone: 'good'};
  if (state === 'optional-stopped') return {label: 'Off', tone: 'neutral'};
  if (state === 'unhealthy') return {label: 'Needs a look', tone: 'bad'};
  return {label: readable(state) || 'Unknown', tone: 'neutral'};
}

export const expectedState = (state: string): string =>
  ({running: 'Should be running', completed: 'Runs once, then stops', 'optional-stopped': 'Optional'})[state] ??
  readable(state);

/* ---------- Background work ---------- */

export const families: Record<string, string> = {
  telegram: 'Telegram replies',
  preparation: 'Preparing messages',
  browser: 'Browser chat',
  schedules: 'Scheduled runs',
  imports: 'Chat imports',
  memory_review: 'Memory notes',
  honcho: 'Long-term memory sync',
  actions: 'Approved messages',
  tools: 'Approved tools',
  organization: 'Organizing knowledge',
};
export const familyName = (family: string): string => families[family] ?? readable(family);

export const runStates: Record<string, {label: string; tone: Tone}> = {
  queued: {label: 'Queued', tone: 'neutral'},
  waiting: {label: 'Waiting', tone: 'warn'},
  running: {label: 'Running', tone: 'info'},
  retryable_failed: {label: 'Failed · will retry', tone: 'warn'},
  completed: {label: 'Done', tone: 'good'},
  failed: {label: 'Failed', tone: 'bad'},
  skipped: {label: 'Skipped', tone: 'neutral'},
  cancelled: {label: 'Cancelled', tone: 'neutral'},
  ambiguous: {label: 'Uncertain', tone: 'warn'},
  denied: {label: 'Denied', tone: 'neutral'},
};
export const runState = (state: string) => runStates[state] ?? {label: readable(state), tone: 'neutral' as Tone};

const reasons: Record<string, string> = {
  approval_required: 'Waiting for your approval',
  owner_paused: 'Paused',
  prerequisite: 'Waiting for an earlier step',
  guard_pending: 'Waiting for the secret check',
  receipt_pending: 'Checking whether it already ran',
  provider_unavailable: 'The model provider isn’t answering',
  provider_not_configured: 'No model is set up',
  runtime_unavailable: 'The assistant isn’t answering',
  workflow_execution_failed: 'It couldn’t start',
  legacy_owner: 'Handled by the older runner, so it can’t be retried or cancelled here',
  closed: 'It has finished, so there is nothing to retry or cancel',
  native_schedule_control: 'Pause or change this in the schedule itself',
  source_policy_control: 'Change this through the message’s memory or sharing settings',
  execution_in_progress: 'It is running right now; wait for it to finish',
  receipt_closed: 'It may already have had an effect, so it can’t be repeated',
  quota_paused: 'The provider paused requests (quota or rate limit)',
  subscription_unavailable: 'The model provider is unavailable',
  waiting_for_attachments: 'Waiting for files to download',
  waiting_for_transcription: 'Waiting for a voice transcription',
  delivery_unconfirmed: 'Telegram didn’t confirm delivery; it won’t be resent automatically',
  native_review_unconfirmed: 'The notes review stopped without confirming it finished, so it isn’t repeated automatically',
  input_limit: 'The message and its context were too long to learn from',
  invalid_model_output: 'The model’s answer couldn’t be used',
  no_conversation: 'Not part of a chat, so there is nothing to learn',
};
export const reason = (value: string | null | undefined): string => (value ? (reasons[value] ?? readable(value)) : '');

/** The words for a waiting-reasons row from background work health. */
export const waitingReason = (row: {state: string; waiting_reason: string | null}): string =>
  row.waiting_reason ? reason(row.waiting_reason) : row.state === 'queued' ? 'Queued to start' : 'Reason not recorded';

export function controlError(code: string): string {
  if (/revision_changed|domain_changed/.test(code)) return 'This changed somewhere else. Reload to see the latest.';
  if (code === 'workflow_execution_in_progress') return 'It is running right now. Try again when it finishes.';
  if (code.startsWith('workflow_') && reasons[code.slice(9)]) return reasons[code.slice(9)]! + '.';
  return 'That didn’t work. Check its latest state and try again.';
}

/* ---------- Reply timing ---------- */

export const timingCategories: Record<string, {label: string; tone: Tone; color: string}> = {
  internal: {label: 'Internal', tone: 'neutral', color: 'var(--muted)'},
  workflow: {label: 'Waiting', tone: 'warn', color: 'var(--warn)'},
  third_party: {label: 'Outside service', tone: 'info', color: 'var(--info)'},
  llm: {label: 'Model', tone: 'accent', color: 'var(--accent)'},
  unmeasured: {label: 'Not measured', tone: 'neutral', color: 'var(--strong-border)'},
};
export const timingCategory = (category: string) =>
  timingCategories[category] ?? {label: readable(category), tone: 'neutral' as Tone, color: 'var(--muted)'};

const stages: Record<string, string> = {
  capture: 'Saving the message',
  'outbox:preparation': 'Handing over for preparation',
  'queue:preparation': 'Waiting to be prepared',
  'step:preparation': 'Preparing the message',
  'wait:preparation': 'Pauses while preparing',
  transcription: 'Voice transcription',
  'outbox:telegram': 'Handing over for a reply',
  'queue:telegram': 'Waiting to reply',
  'step:telegram': 'Reply steps',
  'wait:telegram': 'Pauses between reply steps',
  hermes_queue: 'Waiting for the assistant',
  hermes_turn: 'Assistant, other work',
  hermes_delivery: 'Recording the reply',
  bootstrap: 'Assistant start-up',
  memory_recall: 'Long-term memory context',
  history_prepare: 'Loading chat history',
  agent_init: 'Assistant setup',
  conversation: 'Tools and reasoning',
  llm: 'Model response',
  model_guard: 'Secret check',
  honcho_recall: 'Long-term memory lookup',
  telegram_send: 'Sending to Telegram',
  unmeasured: 'Not measured',
};
export const stageName = (stage: string): string => stages[stage] ?? readable(stage.replace(':', ' '));

/* ---------- Usage ---------- */

const parts: Record<string, string> = {
  reply: 'Telegram replies',
  browser: 'Browser chat',
  schedule: 'Scheduled runs',
  memory_review: 'Memory notes',
  guard: 'Secret check',
  memory: 'Long-term memory',
  embedding: 'Memory search',
};
export const partName = (id: string, label?: string): string => parts[id] ?? label ?? readable(id);

/** Model routes from monitoring: which provider and model each part uses. */
const routeParts: Record<string, string> = {
  reply: 'Replies',
  memory: 'Long-term memory',
  guard: 'Secret check',
  embedding: 'Memory search',
};
export const routeName = (part: string, label?: string): string => routeParts[part] ?? label ?? readable(part);

/* ---------- Maintenance jobs ---------- */

const jobs: Record<string, string> = {
  'settings.apply': 'Apply settings',
  'operations.diagnose': 'Service check',
  'operations.export': 'Archive export',
  'operations.portable-export': 'Archive and memory export',
  'operations.backup': 'Backup',
  'operations.restart': 'Restart',
  'operations.restore': 'Restore',
};
export const jobName = (kind: string): string => jobs[kind] ?? readable(kind.replace(/^operations\./, ''));

export function jobState(state: string): {label: string; tone: Tone} {
  if (state === 'running' || state === 'queued') return {label: 'Running', tone: 'info'};
  if (state === 'complete' || state === 'completed') return {label: 'Done', tone: 'good'};
  if (state === 'failed') return {label: 'Failed', tone: 'bad'};
  if (state === 'interrupted') return {label: 'Interrupted', tone: 'warn'};
  if (state === 'cancelled') return {label: 'Cancelled', tone: 'neutral'};
  return {label: readable(state) || 'Unknown', tone: 'neutral'};
}

/** One line saying what a finished maintenance job did. */
export function jobOutcome(job: {kind: string; state: string; error?: string | null; result?: any}): string {
  const result = job.result ?? {};
  if (job.state === 'failed') {
    if (result.status === 'apply_failed')
      return result.rolled_back
        ? 'Didn’t apply; the previous settings were put back.'
        : 'Didn’t apply. Run a service check.';
    return job.error ? operationError(job.error) : 'It failed.';
  }
  if (job.state === 'interrupted') return 'Stopped when the dashboard restarted.';
  if (job.state === 'running') return 'In progress…';
  if (Array.isArray(result.containers)) {
    const bad = result.containers.filter((c: any) => c.state === 'unhealthy').length;
    return bad ? `${bad} service${bad === 1 ? '' : 's'} need a look.` : 'All services are fine.';
  }
  switch (result.status) {
    case 'backed_up':
      return 'Backup saved.';
    case 'restored_inactive':
      return 'Restored into a separate installation that stays switched off.';
    case 'exported':
      return (
        [
          result.events != null && `${count(result.events)} messages`,
          result.files != null && `${count(result.files)} files`,
          result.native_profiles != null && `${count(result.native_profiles)} assistant profiles`,
        ]
          .filter(Boolean)
          .join(' · ') || 'Export ready to download.'
      );
    case 'restarted':
      return 'Services restarted and answering.';
    case 'applied':
      return 'New settings are in use.';
    case 'apply_failed':
      return result.rolled_back
        ? 'Didn’t apply; the previous settings were put back.'
        : 'Didn’t apply. Run a service check.';
  }
  return 'Finished.';
}

export function operationError(code: string): string {
  if (code === 'wait_for_active_jobs') return 'Another task is running. Try again when it finishes.';
  if (code === 'installation_maintenance') return 'A backup is running. Try again when it finishes.';
  if (code === 'operation_denied') return 'That task isn’t allowed.';
  if (code === 'export_not_ready') return 'The export isn’t ready yet.';
  if (code === 'dashboard_restarted') return 'Stopped when the dashboard restarted.';
  if (code === 'operation_failed') return 'The task failed. Run a service check for details.';
  return readable(code).replace(/^./, c => c.toUpperCase()) + '.';
}

/* ---------- Telegram ---------- */

export const telegramStates: Record<string, {label: string; tone: Tone}> = {
  connected: {label: 'Receiving', tone: 'good'},
  ready: {label: 'Ready', tone: 'good'},
  recovering: {label: 'Reconnecting', tone: 'warn'},
  starting: {label: 'Starting', tone: 'info'},
  disabled: {label: 'Turned off', tone: 'neutral'},
  credentials_missing: {label: 'Bot token missing', tone: 'bad'},
  connection_failed: {label: 'Can’t connect', tone: 'bad'},
  runtime_failed: {label: 'Stopped', tone: 'bad'},
};

const telegramReasons: Record<string, string> = {
  telegram_network_error: 'Telegram stopped after the network didn’t come back.',
  telegram_polling_conflict: 'Another program may be using this bot token.',
  telegram_adapter_failed: 'The Telegram connection stopped.',
  telegram_poll_or_capture_failed: 'The last check for new messages failed.',
  telegram_unauthorized: 'Telegram rejected the bot token.',
  telegram_rate_limited: 'Telegram asked Nocheh to slow down.',
};
export const telegramReason = (code: string | null | undefined): string =>
  code ? (telegramReasons[code] ?? reason(code)) : '';

/* ---------- Databases ---------- */

const databaseNames: Record<string, string> = {
  archive: 'Archive',
  derived: 'Derived data',
  control: 'Control',
  workflow: 'Background work',
  honcho: 'Long-term memory',
  'honcho-ledger': 'Long-term memory budget',
  usage: 'Model usage',
};
export function databaseName(db: {id: string; name?: string}): string {
  if (db.id.startsWith('hermes:')) return 'Assistant notes · ' + db.id.slice(7);
  return databaseNames[db.id] ?? db.name ?? db.id;
}

const storeNames: Record<string, string> = {
  nocheh_archive: 'Archive (your originals)',
  nocheh_derived: 'Derived data',
  nocheh_control: 'Control',
  nocheh_inngest: 'Background work history',
  honcho_experiment: 'Long-term memory',
};
export const storeName = (row: {database: string; role?: string}): string =>
  storeNames[row.database] ?? row.role ?? row.database;

/** Plain words for what the assistant runtime can do. */
const capabilityNames: Record<string, string> = {
  status: 'Report its status',
  'profiles.list': 'List chat profiles',
  'config.read': 'Read its settings',
  'config.write': 'Change its settings',
  'memory.read': 'Read its own notes',
  'persona.read': 'Read roles and skills',
  'persona.write': 'Change roles and skills',
  'prompts.defaults': 'Share its built-in instructions',
  'run.start': 'Answer messages',
  'run.resume': 'Continue a paused answer',
  'run.cancel': 'Stop an answer',
  'run.events': 'Stream answers to the browser',
  lifecycle: 'Restart cleanly',
  'source.file': 'Read attached files',
  'guard.detect': 'Check messages for secrets',
  'action.execute': 'Carry out approved actions',
  'memory.review': 'Learn from conversations',
  'memory.recall': 'Look things up in long-term memory',
  'memory.filter': 'Keep each chat’s memory to itself',
  'schedule.advance': 'Run scheduled jobs',
  'telegram.chat': 'Read Telegram chat details',
  'usage.price': 'Price model usage',
};
export const capabilityName = (name: string): string => capabilityNames[name] ?? readable(name.replaceAll('.', ' '));
