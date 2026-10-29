/**
 * The owner's saved settings and unsaved edits, shared by every page that
 * changes a setting (Settings, Chats). Edits survive moving between pages.
 * Save writes the edits and then applies them in one step; the save controls
 * in the page header show the progress and the outcome. A page opened or
 * reloaded while an apply runs follows that apply to its end.
 */
import {useSyncExternalStore} from 'react';
import {apiGet, apiPost, type ApiError} from './api';

export type SettingField = {
  key: string;
  value: string | null;
  configured: boolean;
  secret: boolean;
  editable: boolean;
};
export type ProviderRow = {id: string; name: string; kind: string; url: string | null; has_key: boolean};
export type ProviderPart = {id: string; label: string; provider_setting: string; model_setting: string};
export type SettingsView = {
  revision: string;
  applied_revision: string | null;
  apply_state: 'current' | 'pending' | 'unverified';
  fields: SettingField[];
  providers?: {list: ProviderRow[]; parts: ProviderPart[]};
  models?: {
    embedding: string[];
    embedding_locked: string | null;
    embedding_rebuild?: string | null;
    transcription?: {model: string; usd_per_minute: number}[];
  };
  /** The apply that is running now, if any. */
  applying?: {id: string; step: string; started_at: string} | null;
};
/** What a running apply is doing: its step and when it started (ms). */
export type ApplyProgress = {step: string; started: number};
export type Phase = 'idle' | 'saving' | 'applying' | 'failed';
type State = {
  data: SettingsView | null;
  error: string;
  changes: Record<string, string>;
  revision: string | null;
  phase: Phase;
  message: string;
  progress: ApplyProgress | null;
};

let state: State = {data: null, error: '', changes: {}, revision: null, phase: 'idle', message: '', progress: null};
const listeners = new Set<() => void>();
function update(patch: Partial<State>) {
  state = {...state, ...patch};
  for (const listener of listeners) listener();
}

let loading: Promise<void> | null = null;
let sequence = 0;
/** Reads the saved settings again; an older answer arriving late never replaces a newer one. */
export function loadSettings(): Promise<void> {
  const mine = ++sequence;
  const request = apiGet<SettingsView>('/settings')
    .then(
      data => {
        if (mine !== sequence) return;
        update({data, error: '', changes: rebase(state.changes, data)});
        // An apply started before this page loaded, or in another tab: follow it.
        if (data.applying && state.phase !== 'saving' && state.phase !== 'applying') void resumeApply(data.applying);
      },
      error => {
        if (mine === sequence) update({error: (error as Error).message || 'unavailable'});
      },
    )
    .finally(() => {
      if (loading === request) loading = null;
    });
  loading = request;
  return request;
}

function savedValue(data: SettingsView | null, key: string): string {
  return data?.fields.find(field => field.key === key)?.value ?? '';
}
function isSecret(data: SettingsView | null, key: string): boolean {
  return !!data?.fields.find(field => field.key === key)?.secret;
}
/** Drops edits that now equal the saved value, for example after a save elsewhere. */
function rebase(changes: Record<string, string>, data: SettingsView): Record<string, string> {
  return Object.fromEntries(
    Object.entries(changes).filter(([key, value]) => isSecret(data, key) || value !== savedValue(data, key)),
  );
}

export function setSetting(key: string, value: string) {
  setSettings({[key]: value});
}

/** Records edits. A value equal to the saved one, or a blank secret, is no change. */
export function setSettings(values: Record<string, string>) {
  if (state.phase === 'saving' || state.phase === 'applying') return;
  const changes = {...state.changes};
  for (const [key, value] of Object.entries(values)) {
    const unchanged = isSecret(state.data, key) ? value === '' : value === savedValue(state.data, key);
    if (unchanged) delete changes[key];
    else changes[key] = value;
  }
  const dirty = Object.keys(changes).length > 0;
  update({
    changes,
    revision: dirty ? (state.revision ?? state.data?.revision ?? null) : null,
    ...(state.phase === 'failed' ? {phase: 'idle' as Phase, message: ''} : {}),
  });
}

export function discardSettings() {
  if (state.phase === 'saving' || state.phase === 'applying') return;
  update({changes: {}, revision: null, phase: 'idle', message: ''});
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ApplyJob = {id: string; state: string; step?: string; created_at?: string; result?: any; error?: string};
type ApplyOutcome = {job: ApplyJob; ended: 'finished' | 'too_long' | 'unreachable'};
// The server bounds every apply step (each restart, a rollback and the memory
// refresh), about 40 minutes at the very worst; past this the page stops waiting.
const APPLY_LIMIT = 45 * 60_000;
// A restart can make the dashboard miss a few answers; this long without one means it is gone.
const UNREACHABLE_LIMIT = 2 * 60_000;
// Applies this page already followed to their end, so a late settings answer never restarts one.
const settled = new Set<string>();
let following: string | null = null;

/** Waits for an apply to end, reporting its step, and never longer than the limits above. */
async function followApply(job: ApplyJob, started: number): Promise<ApplyOutcome> {
  following = job.id;
  let current = job;
  let answered = Date.now();
  try {
    while (['running', 'queued'].includes(current.state)) {
      update({progress: {step: current.step || 'starting', started}});
      if (Date.now() - started > APPLY_LIMIT) return {job: current, ended: 'too_long'};
      await sleep(1500);
      try {
        current = await apiGet<ApplyJob>('/jobs/' + encodeURIComponent(job.id));
        answered = Date.now();
      } catch (error) {
        if ((error as ApiError).status === 404) return {job: {...current, state: 'interrupted'}, ended: 'finished'};
        if (Date.now() - answered > UNREACHABLE_LIMIT) return {job: current, ended: 'unreachable'};
      }
    }
    return {job: current, ended: 'finished'};
  } finally {
    following = null;
    settled.add(job.id);
  }
}

/** Shows how an apply ended. `sent` are the edits it saved, kept as edits again when it rolled back. */
async function concludeApply({job, ended}: ApplyOutcome, sent: Record<string, string>): Promise<boolean> {
  await loadSettings();
  if (ended === 'finished' && job.state === 'complete' && job.result?.memory_rebuild === 'failed') {
    update({
      phase: 'failed',
      progress: null,
      message:
        'The new memory search model is in use, but rebuilding long-term memory didn’t start. Press Try again to start it.',
    });
    return false;
  }
  if (ended === 'finished' && job.state === 'complete') {
    update({phase: 'idle', message: '', progress: null});
    return true;
  }
  const rolledBack = job.result?.rolled_back;
  // A failed apply restores the previous settings; keep the edits so they can be fixed and saved again.
  update({
    phase: 'failed',
    progress: null,
    changes: state.data ? rebase({...sent, ...state.changes}, state.data) : state.changes,
    revision: state.data?.revision ?? null,
    message:
      ended === 'unreachable'
        ? 'Nocheh stopped answering while the services restarted. Reload the page in a minute to see whether the new settings are in use.'
        : ended === 'too_long'
          ? 'Restarting the services is taking far longer than it should. Check System, then try again.'
          : job.state === 'interrupted'
            ? 'The dashboard restarted while applying, so the new settings may not be in use yet. Press Try again to apply them.'
            : rolledBack
              ? 'The services didn’t start with these settings, so Nocheh went back to the previous ones. Your edits are kept.'
              : 'The new settings were saved, but restarting the services didn’t finish. Check System, then try again.',
  });
  return false;
}

/** Follows an apply this page didn't start, for example after a reload while it runs. */
async function resumeApply(applying: NonNullable<SettingsView['applying']>) {
  if (following === applying.id || settled.has(applying.id)) return;
  const started = Date.parse(applying.started_at) || Date.now();
  update({phase: 'applying', message: '', progress: {step: applying.step, started}});
  await concludeApply(await followApply({id: applying.id, state: 'running', step: applying.step}, started), {});
}

/**
 * The memory search model the edits switch to, when Honcho memory already holds
 * vectors from another one: saving it rebuilds long-term memory, so it is confirmed first.
 */
export function memoryRebuildModel(): string | null {
  const model = state.changes.NOCHEH_EMBEDDING_MODEL;
  const locked = state.data?.models?.embedding_locked;
  return model && locked && model !== locked ? model : null;
}

/** Saves every edit, then applies the saved settings to the running services when they need a restart. */
export async function saveSettings({rebuildMemory = false}: {rebuildMemory?: boolean} = {}): Promise<boolean> {
  if (state.phase === 'saving' || state.phase === 'applying' || !state.data) return false;
  const changes = state.changes;
  try {
    if (Object.keys(changes).length) {
      update({phase: 'saving', message: ''});
      const data = await apiPost<SettingsView>('/settings', {
        changes,
        revision: state.revision ?? state.data.revision,
        ...(rebuildMemory ? {rebuild_memory: true} : {}),
      });
      update({changes: {}, revision: null});
      if (data?.fields) update({data});
      else await loadSettings();
      // Settings that work live, such as automatic backups, need no restart.
      if (state.data?.apply_state === 'current') {
        update({phase: 'idle', message: '', progress: null});
        return true;
      }
    }
    update({phase: 'applying', message: '', progress: {step: 'starting', started: Date.now()}});
    let job: ApplyJob;
    try {
      job = await apiPost<ApplyJob>('/settings/apply', {});
    } catch (error) {
      // An apply already running, for example from another tab, already uses these saved settings.
      if ((error as ApiError).message !== 'wait_for_active_jobs') throw error;
      await loadSettings();
      const running = state.data?.applying;
      if (!running || settled.has(running.id)) throw error;
      job = {id: running.id, state: 'running', step: running.step, created_at: running.started_at};
    }
    const started = Date.parse(job.created_at ?? '') || Date.now();
    return await concludeApply(await followApply(job, started), changes);
  } catch (error) {
    await loadSettings();
    update({phase: 'failed', progress: null, message: settingsError(error as ApiError)});
    return false;
  }
}

/** Plain words for a settings error code or validation message. */
export function settingsError(error: ApiError | string): string {
  const code = typeof error === 'string' ? error : error.message;
  if (code === 'configuration_conflict')
    return 'Settings were changed somewhere else since you started. Your edits are kept; check them and save again.';
  if (code === 'wait_for_active_jobs' || code === 'job_busy')
    return 'Another task, such as a backup or import, is running. Save again when it finishes.';
  if (code === 'embedding_model_change_requires_rebuild')
    return 'Changing the memory search model rebuilds long-term memory. Save again and confirm the rebuild.';
  if (code === 'unsupported_setting') return 'One of these settings can’t be changed from the dashboard.';
  if (code === 'installation_maintenance') return 'Nocheh is busy with maintenance. Try again shortly.';
  if (code === 'ValueError' || code === 'operation_interrupted')
    return 'Nocheh didn’t accept these settings. Check every field you changed and try again.';
  // Validation messages arrive as readable sentences; codes as snake_case.
  if (/\s/.test(code)) return code.endsWith('.') ? code : code + '.';
  return 'Saving failed (' + code + '). Try again.';
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!state.data && !loading) void loadSettings();
  return () => listeners.delete(listener);
};

/** Saved settings, unsaved edits and helpers to read and change them. */
export function useSettings() {
  const current = useSyncExternalStore(subscribe, () => state);
  const field = (key: string) => current.data?.fields.find(f => f.key === key);
  return {
    ...current,
    busy: current.phase === 'saving' || current.phase === 'applying',
    dirty: Object.keys(current.changes).length,
    field,
    saved: (key: string) => savedValue(current.data, key),
    /** The edited value when there is one, otherwise the saved value. Secrets read as the typed text. */
    value: (key: string) => current.changes[key] ?? (field(key)?.secret ? '' : savedValue(current.data, key)),
    changed: (key: string) => key in current.changes,
    set: setSetting,
    setMany: setSettings,
  };
}
