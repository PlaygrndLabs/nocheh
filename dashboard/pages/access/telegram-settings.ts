import {useState} from 'react';
import {call} from '../../lib/api';
import {errorText} from '../../lib/page-helpers';
import {refreshResources, useResource} from '../../lib/resource';
import type {ParticipantRule} from '../../lib/group-access';

type Field = {key: string; value?: string};
type SettingsData = {revision: number | string; apply_state?: string; fields: Field[]};
export type AccessRule = {granted: string[]; denied: string[]};

/**
 * The installation settings that decide who can talk to Nocheh in a chat.
 * Changes are saved one at a time with the settings revision they started
 * from, then applied to the running services like any other setting.
 */
export function useTelegramSettings(notify: (text: string, error?: boolean) => void) {
  const settings = useResource<SettingsData>('/settings');
  const [busy, setBusy] = useState(false);
  const [unapplied, setUnapplied] = useState(false);
  const value = (key: string) => settings.data?.fields.find(field => field.key === key)?.value ?? '';
  const groupIds = value('TELEGRAM_GROUP_IDS')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  let access: Record<string, AccessRule> = {};
  try {
    access = JSON.parse(value('TELEGRAM_GROUP_ACCESS') || '{}');
  } catch {
    access = {};
  }
  const save = async (changes: Record<string, string>, message: string) => {
    if (!settings.data) return false;
    setBusy(true);
    try {
      await call('/settings', {revision: settings.data.revision, changes});
      await refreshResources();
      setUnapplied(true);
      notify(message);
      return true;
    } catch (error) {
      notify(errorText(error), true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await call('/settings/apply', {});
      setUnapplied(false);
      await refreshResources();
      notify('Applying saved settings. Follow the result in System › Backups & maintenance.');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setBusy(false);
    }
  };
  return {
    loaded: !!settings.data,
    error: settings.error,
    busy,
    /** Saved changes are waiting to be applied, here or from Settings. */
    pending: unapplied || settings.data?.apply_state === 'pending',
    owner: value('TELEGRAM_OWNER_ID'),
    enabled: value('TELEGRAM_ENABLED') === 'true',
    replies: value('TELEGRAM_GROUP_REPLIES') || 'addressed',
    names: value('TELEGRAM_BOT_NAMES'),
    topicMemory: value('TELEGRAM_TOPIC_MEMORY') || 'group',
    groupIds,
    access,
    ruleFor: (group: string): ParticipantRule => access[group] ?? {granted: [], denied: []},
    save,
    apply,
  };
}
export type TelegramSettings = ReturnType<typeof useTelegramSettings>;
