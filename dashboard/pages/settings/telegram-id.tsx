/**
 * "Find my ID": lists who wrote to the bot privately, so the owner can pick their
 * own Telegram user ID without the terminal. It works only while Telegram is off;
 * what it reads is saved and answered once Telegram is on, and nothing is sent.
 */
import {useState} from 'react';
import {Search} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {Button} from '../../ui/core';

type Person = {id: string; name: string | null; username: string | null};
/** `more`: more messages were waiting than one look reads. */
type Found = {bot: string | null; people: Person[]; more?: boolean};

const problems: Record<string, string> = {
  telegram_token_missing: 'Save the bot token first.',
  telegram_running:
    'Telegram is on, so Nocheh already reads the bot’s messages. Turn Telegram off and save to look again.',
  telegram_token_refused: 'Telegram refused the bot token. Copy it again from @BotFather, paste it and save.',
  telegram_unreachable: 'Telegram couldn’t be reached. Check the internet connection and try again.',
  wait_for_active_jobs: 'Another task, such as a backup or a settings change, is running. Try again when it finishes.',
  job_busy: 'Nocheh is already looking. Try again in a moment.',
};

/** The button, sitting beside the ID field. */
export function FindIdButton({disabled, busy, onClick}: {disabled: boolean; busy: boolean; onClick: () => void}) {
  return (
    <Button disabled={disabled || busy} busy={busy} onClick={onClick}>
      {!busy && <Search aria-hidden />} Find my ID
    </Button>
  );
}

export function useFindTelegramId() {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [problem, setProblem] = useState('');
  const find = async () => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      setFound(await apiPost<Found>('/telegram/discover', {}));
    } catch (error) {
      setFound(null);
      setProblem(problems[(error as ApiError).message] ?? 'Nocheh couldn’t look for your ID. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return {busy, found, problem, find, clear: () => (setFound(null), setProblem(''))};
}

/** What the last look found, under the ID field. `current` is the ID in the field now, `saved` the saved one. */
export function FoundPeople({
  found,
  problem,
  current,
  saved,
  telegramOn,
  disabled,
  onUse,
}: {
  found: Found | null;
  problem: string;
  current: string;
  saved: string;
  /** The Telegram switch is on in the form, saved or not. */
  telegramOn: boolean;
  disabled: boolean;
  onUse: (id: string) => void;
}) {
  if (problem)
    return (
      <p role="alert" className="border-t border-line px-5 py-3 text-[13px] text-bad">
        {problem}
      </p>
    );
  if (!found) return null;
  const bot = found.bot ?? 'your bot';
  if (!found.people.length)
    return (
      <p role="status" className="border-t border-line px-5 py-3 text-[13px] text-muted">
        {found.more
          ? `${bot} has more waiting messages than one look reads, and yours isn’t among them. Type your ID instead; a Telegram bot such as @userinfobot shows it.`
          : `No private messages to ${bot} yet. Open ${bot} in Telegram, send it any message, then press Find my ID again.`}
      </p>
    );
  return (
    <div role="status" className="border-t border-line px-5 py-3">
      <p className="text-[13px] text-muted">
        {found.people.length === 1 ? 'This account wrote' : 'These accounts wrote'} to {bot}. Choose yours.
      </p>
      <ul
        aria-label="Accounts that wrote to the bot"
        className="mt-2 divide-y divide-line rounded-lg border border-line"
      >
        {found.people.map(person => (
          <li key={person.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {person.name ?? person.username ?? 'No name'}
                {person.name && person.username && <span className="font-normal text-muted"> {person.username}</span>}
              </span>
              <span className="tabular block text-xs text-muted">{person.id}</span>
            </span>
            {current === person.id ? (
              <span className="text-[13px] text-muted">
                {saved === person.id
                  ? 'Your saved ID'
                  : telegramOn
                    ? 'Added. Press Save to keep it.'
                    : 'Added. Turn Telegram on above, then press Save.'}
              </span>
            ) : (
              <Button size="sm" disabled={disabled} onClick={() => onUse(person.id)}>
                Use this ID
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
