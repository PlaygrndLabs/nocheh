/**
 * The owner's saved settings and unsaved edits, shared by every page that
 * changes a setting (Settings, Chats). Edits survive moving between pages.
 * Save writes the edits and then applies them in one step; the bottom save
 * bar shows the progress and the outcome.
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
  models?: {embedding: string[]; embedding_locked: string | null};
};
export type Phase = 'idle' | 'saving' | 'applying' | 'failed';
type State = {
  data: SettingsView | null;
  error: string;
  changes: Record<string, string>;
  revision: string | null;
  phase: Phase;
  message: string;
};

let state: State = {data: null, error: '', changes: {}, revision: null, phase: 'idle', message: ''};
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
        if (mine === sequence) update({data, error: '', changes: rebase(state.changes, data)});
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
  update({changes: {}, revision: null, phase: 'idle', message: ''});
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Saves every edit, then applies the saved settings to the running services. */
export async function saveSettings(): Promise<boolean> {
  if (state.phase === 'saving' || state.phase === 'applying' || !state.data) return false;
  const changes = state.changes;
  try {
    if (Object.keys(changes).length) {
      update({phase: 'saving', message: ''});
      const data = await apiPost<SettingsView>('/settings', {changes, revision: state.revision ?? state.data.revision});
      update({changes: {}, revision: null});
      if (data?.fields) update({data});
      else await loadSettings();
    }
    update({phase: 'applying', message: ''});
    const job = await apiPost<{id: string; state: string; result?: any; error?: string}>('/settings/apply', {});
    let current = job;
    for (let tries = 0; ['running', 'queued'].includes(current.state) && tries < 400; tries++) {
      await sleep(1500);
      current = await apiGet('/jobs/' + encodeURIComponent(job.id)).catch(() => current);
    }
    await loadSettings();
    if (current.state !== 'complete') {
      const rolledBack = current.result?.rolled_back;
      // A failed apply restores the previous settings; keep the edits so they can be fixed and saved again.
      update({
        phase: 'failed',
        changes: state.data ? rebase(changes, state.data) : changes,
        revision: state.data?.revision ?? null,
        message: rolledBack
          ? 'The services didn’t start with these settings, so Nocheh went back to the previous ones. Your edits are kept.'
          : 'The new settings were saved, but restarting the services didn’t finish. Check System, then try again.',
      });
      return false;
    }
    update({phase: 'idle', message: ''});
    return true;
  } catch (error) {
    await loadSettings();
    update({phase: 'failed', message: settingsError(error as ApiError)});
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
    return 'Memory already holds search data from the current memory search model. Rebuild memory before changing it.';
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
