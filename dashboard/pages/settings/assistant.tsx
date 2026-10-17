/** Settings › Assistant: how much Nocheh may do without asking, its role and skills, and limits for each chat. */
import {useEffect, useState} from 'react';
import {RotateCcw} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, CardHeader, Field, Input, LoadError, LoadingRows, Select} from '../../ui/core';
import {RoleAndSkills} from '../chats/role-skills';

const freedom = [
  {
    value: 'approval_required',
    title: 'Ask me first',
    text: 'Every message Nocheh sends for you and every tool it runs waits for your yes in the Inbox or your private chat.',
  },
  {
    value: 'owner_requests_execute',
    title: 'Do what I ask',
    text: 'When you ask in your private chat, it acts without a separate yes. Requests from groups, schedules and background work still wait.',
  },
];

const names: Record<string, [string, string]> = {
  'nocheh_tools.shell': [
    'Commands',
    'Propose commands in an isolated workspace. Each run needs your yes or a saved permission.',
  ],
  'nocheh_tools.browser': ['Web pages', 'Read an approved public page. No logins.'],
  'nocheh_tools.mcp': ['Outside tools', 'Propose an exact call to a public tool server.'],
  'agent.reasoning_effort': ['Thinking effort', 'More effort can give better answers but takes longer.'],
  'agent.max_iterations': ['Steps per answer', 'Most tool and thinking steps in one answer.'],
  'agent.run_budget_seconds': ['Time per answer (seconds)', 'Longest time one answer may take.'],
  'memory.memory_char_limit': ['Notes size (characters)', 'Room for the assistant’s general notes.'],
  'memory.user_char_limit': ['Profile size (characters)', 'Room for what it notes about you.'],
};

const conflict = (error: unknown) => /conflict|changed/.test((error as ApiError)?.message ?? '');

function OwnerFreedom() {
  const {data, error} = useResource<any>('/owner-autonomy');
  const [choice, setChoice] = useState<string | null>(null);
  const saved = data?.mode ?? 'approval_required';
  const selected = choice ?? saved;
  useDraftSource({
    id: 'owner-freedom',
    labels: data && selected !== saved ? ['How much Nocheh does without asking'] : [],
    save: async () => {
      try {
        await apiPost('/owner-autonomy', {
          mode: selected,
          expected_revision: data.revision,
          operation_id: crypto.randomUUID(),
        });
        setChoice(null);
        await refreshResources();
      } catch (e) {
        throw new Error(
          conflict(e)
            ? 'How much Nocheh does without asking was changed somewhere else. Check it and save again.'
            : 'Couldn’t save how much Nocheh does without asking.',
        );
      }
    },
    discard: () => setChoice(null),
  });
  return (
    <Card>
      <CardHeader title="Acting for you" description="How much Nocheh may do without asking. No restart needed." />
      <div className="px-5 pt-3 pb-5">
        {error && !data ? (
          <LoadError what="this setting" />
        ) : !data ? (
          <LoadingRows rows={2} />
        ) : (
          <div role="radiogroup" aria-label="Acting for you" className="grid gap-2 sm:grid-cols-2">
            {freedom.map(option => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected === option.value}
                onClick={() => setChoice(option.value === saved ? null : option.value)}
                className={cn(
                  'rounded-lg border p-3.5 text-left transition-colors',
                  selected === option.value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {option.title}
                  {option.value === saved && selected !== saved && <Badge>Current</Badge>}
                  {option.value === 'approval_required' && (
                    <span className="text-xs font-normal text-muted">(default)</span>
                  )}
                </span>
                <span className="mt-1 block text-[13px] text-muted">{option.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

type Prefs = {
  scope?: string;
  revision: string;
  schema: Record<string, {min?: number; max?: number; choices?: string[]}>;
  values: Record<string, any>;
  origins: Record<string, string>;
};

function Limits() {
  const profiles = useResource<any>('/memory/profiles');
  const conversations = useResource<any>('/conversations?limit=100');
  const [scope, setScope] = useState('');
  const path = scope ? '/memory/preferences?scope=' + encodeURIComponent(scope) : '/policy';
  const prefs = useResource<Prefs>(path);
  const [changes, setChanges] = useState<Record<string, any>>({});
  const [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    setChanges({});
    setRevision(null);
  }, [scope]);
  const chatName = (id: string, owner: boolean) =>
    owner
      ? 'Your private chat'
      : (conversations.data?.items ?? []).find((c: any) => c.space_id === id)?.name || 'Chat ' + id;
  const data = prefs.data && (!scope || prefs.data.scope === scope) ? prefs.data : null;
  const edit = (key: string, value: any) => {
    setRevision(current => current ?? data?.revision ?? null);
    setChanges(current => {
      const next = {...current};
      if (value !== null && value === data?.values[key] && data?.origins[key] === (scope ? 'profile' : 'global'))
        delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const where = scope
    ? chatName(scope, (profiles.data?.profiles ?? []).find((p: any) => p.scope === scope)?.owner)
    : 'every chat';
  useDraftSource({
    id: 'assistant-limits:' + (scope || 'global'),
    labels: Object.keys(changes).map(key => (names[key]?.[0] ?? key) + ' (' + where + ')'),
    save: async () => {
      try {
        if (scope) await apiPost('/memory/preferences', {scope, revision: revision ?? data?.revision, changes});
        else await apiPost('/policy', {changes, revision: revision ?? data?.revision});
        setChanges({});
        setRevision(null);
        await refreshResources();
      } catch (e) {
        throw new Error(
          conflict(e)
            ? 'Assistant limits were changed somewhere else. Your edits are kept; check them and save again.'
            : 'Couldn’t save the assistant limits. Check the values are within range.',
        );
      }
    },
    discard: () => {
      setChanges({});
      setRevision(null);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Assistant limits"
        description="Defaults apply to every chat; a chat can have its own values. No restart needed."
        action={
          <Select aria-label="Which chat" value={scope} onChange={e => setScope(e.target.value)} className="w-56">
            <option value="">Defaults for every chat</option>
            {(profiles.data?.profiles ?? []).map((p: any) => (
              <option key={p.scope} value={p.scope}>
                {chatName(p.scope, p.owner)}
              </option>
            ))}
          </Select>
        }
      />
      <div className="mt-3 border-t border-line">
        {prefs.error && !data ? (
          <LoadError what="assistant limits" className="m-5" />
        ) : !data ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="grid gap-x-6 gap-y-5 px-5 py-5 sm:grid-cols-2">
            {Object.entries(data.schema).map(([key, spec]) => {
              const reset = changes[key] === null;
              const value = reset ? '' : (changes[key] ?? data.values[key] ?? '');
              const own = scope ? data.origins[key] === 'profile' : data.origins[key] !== 'default';
              const [title, hint] = names[key] ?? [key, ''];
              return (
                <Field
                  key={key}
                  label={title}
                  htmlFor={'pref-' + key}
                  aside={
                    reset
                      ? 'Reset when saved'
                      : own
                        ? scope
                          ? 'Set for this chat'
                          : 'Changed'
                        : scope
                          ? 'Default'
                          : 'Built-in'
                  }
                  hint={hint}
                >
                  <div className="flex gap-2">
                    {spec.choices ? (
                      <Select id={'pref-' + key} value={value} onChange={e => edit(key, e.target.value)}>
                        {reset && <option value="">Default</option>}
                        {spec.choices.map(choice => (
                          <option key={choice} value={choice}>
                            {choice[0]!.toUpperCase() + choice.slice(1)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        id={'pref-' + key}
                        type="number"
                        min={spec.min}
                        max={spec.max}
                        step={1}
                        value={value}
                        placeholder={reset ? 'Default' : undefined}
                        onChange={e => edit(key, e.target.value === '' ? null : Number(e.target.value))}
                      />
                    )}
                    <Button
                      size="icon"
                      aria-label={`Reset ${title} to ${scope ? 'the default' : 'the built-in value'}`}
                      title={scope ? 'Use the default' : 'Use the built-in value'}
                      disabled={reset || (!own && changes[key] === undefined)}
                      onClick={() => edit(key, null)}
                    >
                      <RotateCcw aria-hidden />
                    </Button>
                  </div>
                </Field>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

export function AssistantSettings() {
  return (
    <>
      <OwnerFreedom />
      <RoleAndSkills
        scope="default"
        where="every chat"
        description="Every chat starts from these. A chat’s own role replaces this one; set it on the chat’s page in Chats."
      />
      <Limits />
    </>
  );
}
