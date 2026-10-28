/**
 * "Built-in instructions": the texts Nocheh's code tells the models behind the
 * scenes. The owner can replace any of them; resetting brings back the built-in
 * text, which then follows future updates.
 */
import {useEffect, useRef, useState} from 'react';
import {ChevronRight, RotateCcw} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {Badge, Button, Card, CardHeader, LoadError, LoadingRows, Textarea} from '../../ui/core';

type Prompts = {
  revision: string;
  defaults: Record<string, string>;
  texts: Record<string, string>;
  limit: number;
  placeholders: Record<string, string[]>;
};

export const instructions: {key: string; title: string; hint: string}[] = [
  {
    key: 'reply.common',
    title: 'Reply rules for every chat',
    hint: 'Sent with every reply, in your private chat and in groups.',
  },
  {key: 'reply.owner', title: 'Your private chat', hint: 'Added after the rules above when Nocheh replies to you.'},
  {
    key: 'reply.group',
    title: 'Groups',
    hint: 'Added after the rules above in groups. [NO_REPLY] is how Nocheh stays quiet.',
  },
  {
    key: 'memory.evidence',
    title: 'Using remembered facts',
    hint: 'Explains the remembered facts that come with each message.',
  },
  {
    key: 'memory.limited',
    title: 'When long-term memory is unavailable',
    hint: 'Told to Nocheh when Honcho memory can’t be reached.',
  },
  {
    key: 'memory.notes_review',
    title: 'Notes review',
    hint: 'Guides how Nocheh updates its Hermes notes after a conversation.',
  },
  {
    key: 'learning.interpret',
    title: 'Learning from conversations',
    hint: 'Tells Honcho memory what to learn from each message. Keep {trigger_id} and {citable_ids}; Nocheh fills them in.',
  },
  {
    key: 'sharing.group_filter',
    title: 'Group sharing filter',
    hint: 'Decides what private knowledge may be shared with a group. Your privacy rules from Settings are added after it.',
  },
  {
    key: 'telegram.not_allowed',
    title: 'Reply to people who aren’t allowed',
    hint: 'Sent in a group, as a reply, when someone you haven’t allowed asks Nocheh something there. No model is used.',
  },
  {
    key: 'telegram.not_allowed_private',
    title: 'Reply to strangers in private',
    hint: 'Sent when anyone but you writes to Nocheh in a private chat, at most once a day per person. No model is used.',
  },
  {
    key: 'telegram.approval_card',
    title: 'Approval card for a message',
    hint: 'The card with Approve and Reject buttons in Telegram. {destination} is where it goes, {origin} where it was asked, {text} the exact message. A line whose value is missing is left out.',
  },
  {
    key: 'telegram.approval_action',
    title: 'Approval card for a tool',
    hint: 'The same card for shell, browser and online tool actions. {kind} is the tool, {origin} where it was asked, {arguments} exactly what it will run.',
  },
  {
    key: 'telegram.approval_texts',
    title: 'Approval buttons and results',
    hint: 'One “name: text” line each for the buttons, the result added to a decided card, and the short notices after a press. A line you remove keeps its default.',
  },
  {
    key: 'tasks.reminder',
    title: 'Task reminder',
    hint: 'Sent to your private chat when a task reminder is due. {title} is the task, {due} its due day, {list} its project and {notes} its notes. A line whose value is missing is left out.',
  },
  {
    key: 'system.problems',
    title: 'Problem notice',
    hint: 'Sent to your private chat when a failure or other problem is new or worse, at most once an hour for the same problem. {problems} is the list, one line each. Turn it off in Settings › Telegram.',
  },
  {
    key: 'system.problem_buttons',
    title: 'Problem notice buttons',
    hint: 'One “name: text” line each for the Open and Retry failed buttons under a problem notice and the short answers to a press. {count} is how many tasks are retried. A line you remove keeps its default.',
  },
  {
    key: 'guard.secret_check',
    title: 'Secret check',
    hint: 'Finds passwords and keys before anything is stored. Keep its JSON reply format, or the check fails and messages wait.',
  },
];

/** A plain-language problem with an edited text, or null. */
export function instructionProblem(text: string, limit: number, placeholders: string[] = []): string | null {
  if (!text.trim()) return 'Write something, or reset it to the built-in text.';
  if (text.length > limit) return `Keep it under ${limit.toLocaleString()} characters.`;
  const missing = placeholders.filter(name => !text.includes(name));
  if (missing.length)
    return `Keep ${missing.join(' and ')} in the text; Nocheh fills ${missing.length === 1 ? 'it' : 'them'} in.`;
  return null;
}

export function BuiltInInstructions() {
  const prompts = useResource<Prompts>('/prompts');
  const data = prompts.data;
  // A string is a new text; null means use the built-in text again.
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [revision, setRevision] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const value = (key: string) =>
    changes[key] === null
      ? (data?.defaults[key] ?? '')
      : (changes[key] ?? data?.texts[key] ?? data?.defaults[key] ?? '');
  const problem = (key: string) =>
    changes[key] == null ? null : instructionProblem(changes[key]!, data!.limit, data!.placeholders[key]);
  const edit = (key: string, text: string | null) => {
    setRevision(current => current ?? data?.revision ?? null);
    setChanges(current => {
      const next = {...current};
      const custom = data?.texts[key] !== undefined;
      const target = text ?? data?.defaults[key];
      if (target === (data?.texts[key] ?? data?.defaults[key])) delete next[key];
      else if (custom && target === data?.defaults[key]) next[key] = null;
      else next[key] = text;
      return next;
    });
  };
  const reset = () => {
    setChanges({});
    setRevision(null);
    setChecked(false);
  };
  const title = (key: string) => instructions.find(item => item.key === key)?.title ?? key;

  useDraftSource({
    id: 'built-in-instructions',
    labels: Object.keys(changes).map(key => 'Instruction: ' + title(key)),
    save: async () => {
      setChecked(true);
      if (Object.keys(changes).some(problem)) throw new Error('Fix the marked instructions, then save again.');
      try {
        await apiPost('/prompts', {
          texts: Object.fromEntries(
            Object.entries(changes).map(([key, text]) => [key, text === null ? null : text.trim()]),
          ),
          revision: revision ?? data?.revision,
        });
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /conflict|changed/.test((e as ApiError)?.message ?? '')
            ? 'The instructions were changed somewhere else. Your edits are kept; check them and save again.'
            : 'Couldn’t save the instructions.',
        );
      }
    },
    discard: reset,
  });

  return (
    <Card>
      <CardHeader
        title="Built-in instructions"
        description="What Nocheh is told behind the scenes. Change any of them, or reset one to bring back the built-in text. No restart needed."
      />
      <div className="mt-3 border-t border-line">
        {prompts.error && !data ? (
          <LoadError what="the instructions" className="m-5" />
        ) : !data ? (
          <LoadingRows rows={3} />
        ) : (
          <ul className="divide-y divide-line">
            {instructions.map(({key, title, hint}) => {
              const pending = key in changes;
              const custom = changes[key] === null ? false : pending || data.texts[key] !== undefined;
              const error = checked ? problem(key) : null;
              return (
                <Instruction
                  key={key}
                  title={title}
                  hint={hint}
                  status={
                    pending
                      ? changes[key] === null
                        ? 'Reset when saved'
                        : 'Not saved'
                      : custom
                        ? 'Changed'
                        : 'Built-in'
                  }
                  value={value(key)}
                  limit={data.limit}
                  error={error}
                  custom={custom}
                  onChange={text => edit(key, text)}
                />
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Instruction(props: {
  title: string;
  hint: string;
  status: string;
  value: string;
  limit: number;
  error: string | null;
  custom: boolean;
  onChange: (text: string | null) => void;
}) {
  const {title, hint, status, value, limit, error, custom, onChange} = props;
  const details = useRef<HTMLDetailsElement>(null);
  // A failed save opens the text it is about; the owner closes it again.
  useEffect(() => {
    if (error && details.current) details.current.open = true;
  }, [error]);
  return (
    <li>
      <details ref={details} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 hover:bg-subtle [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
          <Badge tone={status === 'Built-in' ? 'neutral' : status === 'Changed' ? 'accent' : 'warn'}>{status}</Badge>
        </summary>
        <div className="space-y-2 px-5 pb-4">
          <Textarea
            aria-label={title}
            aria-invalid={!!error || undefined}
            dir="auto"
            rows={8}
            value={value}
            onChange={event => onChange(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {error ? (
              <p className="text-xs text-bad" role="alert">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {value.length.toLocaleString()} of {limit.toLocaleString()} characters
              </p>
            )}
            <Button size="sm" disabled={!custom} onClick={() => onChange(null)}>
              <RotateCcw aria-hidden /> Reset to built-in
            </Button>
          </div>
        </div>
      </details>
    </li>
  );
}
