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
    hint: 'The same card for shell, browser and online tool actions. {kind} says what it does, such as “Notion · create pages”, {summary} the assistant’s own short line about it, {origin} where it was asked, {arguments} exactly what it will run, field by field, with long text in a quote that opens on a tap. With a summary, {arguments} folds into one quote that opens on a tap, unless it is a command.',
  },
  {
    key: 'telegram.approval_texts',
    title: 'Approval buttons and results',
    hint: 'One “name: text” line each for the buttons, the note above a site’s or command’s “where asked” buttons that says the rule covers everyone allowed in that chat or topic (rule_note), the result added to a decided card and its {reason}, the name of a job or schedule that asked, the names of a command, a web page and a tool list (the lines starting with kind), the heading of a tool’s folded details (details), the card that lists a job’s changes (the lines starting with list), and the short notices after a press. A line you remove keeps its default.',
  },
  {
    key: 'telegram.action_continued',
    title: 'After an approved operation ends',
    hint: 'Sent to the agent, not to the chat, when operations a message asked for have ended, so it answers in that chat as a reply to the message. {actions} lists each operation’s ID, tool and state.',
  },
  {
    key: 'telegram.late_messages',
    title: 'Messages that arrived late',
    hint: 'Sent to your private chat after Nocheh saved messages without answering because it got them late, for example while it was offline. {chats} lists each chat and how many, {minutes} is the number of minutes set in Settings › Telegram and {count} is the total. A line whose value is missing is left out.',
  },
  {
    key: 'tasks.reminder',
    title: 'Task reminder',
    hint: 'Sent to your private chat when a task reminder is due. {title} is the task, {due} its due day, {list} its project and {notes} its notes. A line whose value is missing is left out.',
  },
  {
    key: 'imports.ready',
    title: 'Import ready',
    hint: 'Sent to your private chat once an imported chat is saved, read and checked for secrets. {chats} is the chat, {messages} how many messages and {failed} how many could not be prepared. A line whose value is missing is left out.',
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
  {
    key: 'images.read',
    title: 'Reading images',
    hint: 'Sent with each photo or image when it is saved, live or imported. Its answer is checked for secrets and becomes the image’s searchable text.',
  },
  {
    key: 'background.job',
    title: 'Background job: first message',
    hint: 'Starts an approved background job in its own session. {instruction} is what the person asked; {title}, {chat}, {period}, {size} and {limits} are filled in.',
  },
  {
    key: 'background.resume',
    title: 'Background job: after an interruption',
    hint: 'Sent when a job restarts after an interruption and its work so far is still there. {title} is the job’s name.',
  },
  {
    key: 'background.restart',
    title: 'Background job: fresh restart',
    hint: 'Added to the first message when a job restarts and its earlier work could not be kept. {todo} is its last to-do list, left out when it may no longer be shown.',
  },
  {
    key: 'background.limit',
    title: 'Background job: stopped at a limit',
    hint: 'Sent to the chat instead of a report when a job reaches its cost or time limit. {title} and {limit} (cost or time) are filled in; {done} and {left} come from its last to-do list, and {none} is said when it kept none.',
  },
  {
    key: 'background.card',
    title: 'Background job card',
    hint: 'The Approve and Reject card for a job. {instruction} is what the person asked; {title}, {size}, {minutes}, {cost}, {cost_limit}, {minutes_limit}, {checked}, {unpriced}, {notion}, {box} and {repo} are filled in. {cost_limit} is missing on a model without a price, and {unpriced} then says only the time limit applies; {notion} says what the job may do in your Notion without asking; {box} says that it runs in a sealed box; {repo} names the GitHub copy it reads. A line whose value is missing is left out; a card without {unpriced}, {notion}, {box} or {repo} still shows that line, at its end.',
  },
  {
    key: 'background.texts',
    title: 'Background job card answers',
    hint: 'One “name: text” line each for what a decided job card says: running, queued, stopping, done, limited, stopped, failed and rejected. checked and member_limit make the card’s secret check line, unpriced its line for a model without a price, notion_reads its Notion line and box its sealed box line. box_repo is the sealed box line of a job that reads a GitHub copy, repo its copy line with {repo_name}, {repo_branch}, {repo_commit}, {repo_copied} and {repo_size}, and repo_removed what a card says when Remove withdrew it. A line you remove keeps its default.',
  },
  {
    key: 'background.box',
    title: 'Background job: sealed box',
    hint: 'Added to each run of a job in its sealed box: what /chat and /work hold and in what order, that the box has no internet, and that its work is lost when the job ends.',
  },
  {
    key: 'background.repo',
    title: 'Background job: GitHub copy',
    hint: 'Added after the sealed box text to each run of a job that reads a GitHub copy: where the copy is, how to read it, and when to run its code. {repo}, {branch}, {commit} and {copied} are filled in.',
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
