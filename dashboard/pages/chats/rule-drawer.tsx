/** One sharing rule: what it does, texts waiting for approval, and what was shared. */
import {useState} from 'react';
import {Pencil, Search} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {chatFromId, chatName, formatDate, type Directory} from '../../lib/chats-model';
import {Badge, Button, Details, Field, Input, Notice, Spinner, Textarea} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import {modeText, ruleBody, type Rule} from './rule-dialog';
import {ActionError, chatHref, useAction} from './shared';

type Preview = {
  id: string;
  rule_id: string;
  rule_revision: number;
  state: string;
  created_at: string;
  text?: string;
  current?: boolean;
  guard_revision?: number | null;
  text_hash?: string;
  input?: {rule: Rule; sources: {id: string}[]};
};
type Release = {
  id: string;
  preview_id: string;
  rule_id: string;
  state: string;
  mode: string;
  revision: number;
  expires_at: string | null;
  created_at: string;
};
type Hit = {id: string; scope?: string; text?: string; occurred_at?: string; content_types?: string[]};

function useNames(owner?: string) {
  const directory = useResource<Directory>('/conversations?limit=100');
  return (space: string) =>
    chatName(directory.data?.items.find(item => item.space_id === space) ?? chatFromId(space), owner);
}

export function RuleDrawer({
  rule,
  missing,
  open,
  onOpenChange,
  onEdit,
  owner,
}: {
  rule: Rule | null;
  missing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (rule: Rule) => void;
  owner?: string;
}) {
  const name = useNames(owner);
  const action = useAction();
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={rule?.name ?? 'Sharing rule'}
      description={rule ? modeText[rule.mode].hint : undefined}
      footer={
        rule && (
          <>
            <Button onClick={() => onEdit(rule)}>
              <Pencil aria-hidden /> Edit
            </Button>
            <Button
              busy={action.busy === 'toggle'}
              onClick={() =>
                void action.run(
                  'toggle',
                  '/sharing/rules',
                  ruleBody({...rule, enabled: !rule.enabled}, rule.revision),
                  {
                    success: rule.enabled ? 'Rule turned off.' : 'Rule turned on.',
                  },
                )
              }
            >
              {rule.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </>
        )
      }
    >
      {!rule ? (
        missing ? (
          <Notice tone="warn" title="This rule isn’t in the list">
            It may have been on a later page, or it no longer exists.
          </Notice>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="space-y-6">
          <ActionError text={action.error} />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">State</dt>
            <dd>
              <Badge tone={rule.enabled ? 'good' : 'neutral'}>{rule.enabled ? 'On' : 'Off'}</Badge>
            </dd>
            <dt className="text-muted">From</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {rule.sources.map(space => (
                <a key={space} href={chatHref(space)} className="text-accent-text hover:underline" dir="auto">
                  {name(space)}
                </a>
              ))}
            </dd>
            <dt className="text-muted">Into</dt>
            <dd>
              <a href={chatHref(rule.destination)} className="text-accent-text hover:underline" dir="auto">
                {name(rule.destination)}
              </a>
            </dd>
            <dt className="text-muted">How</dt>
            <dd>{modeText[rule.mode].label}</dd>
            {rule.instructions.trim() && (
              <>
                <dt className="text-muted">Privacy notes</dt>
                <dd className="whitespace-pre-wrap" dir="auto">
                  {rule.instructions}
                </dd>
              </>
            )}
          </dl>
          {rule.mode === 'approved' ? (
            <ApprovedSharing rule={rule} />
          ) : (
            <p className="text-[13px] text-muted">
              When {name(rule.destination)} asks about something, Nocheh checks these chats and passes on only what’s
              safe. Each passed-on text lasts a short while.
            </p>
          )}
          <SharedTexts rule={rule} />
        </div>
      )}
    </Drawer>
  );
}

function ApprovedSharing({rule}: {rule: Rule}) {
  const previews = useResource<{previews: Preview[]; next: string | null}>('/sharing/previews?after=');
  const releases = useResource<{releases: Release[]; next: string | null}>('/sharing/releases?after=');
  const [composing, setComposing] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const released = new Set((releases.data?.releases ?? []).map(release => release.preview_id));
  const waiting = (previews.data?.previews ?? []).filter(
    preview =>
      preview.rule_id === rule.id &&
      preview.rule_revision === rule.revision &&
      preview.state === 'ready' &&
      !released.has(preview.id),
  );
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Share a text</h3>
        {!composing && !reviewing && (
          <Button size="sm" variant="primary" disabled={!rule.enabled} onClick={() => setComposing(true)}>
            Write a text to share
          </Button>
        )}
      </div>
      {!rule.enabled && <p className="text-[13px] text-muted">Turn the rule on to share texts.</p>}
      {composing && (
        <ShareForm
          rule={rule}
          onCancel={() => setComposing(false)}
          onPrepared={id => {
            setComposing(false);
            setReviewing(id);
          }}
        />
      )}
      {reviewing && <PreviewReview id={reviewing} onDone={() => setReviewing(null)} />}
      {!composing && !reviewing && waiting.length > 0 && (
        <div>
          <p className="mb-2 text-[13px] text-muted">Prepared, waiting for your approval:</p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {waiting.slice(0, 5).map(preview => (
              <li key={preview.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm">Prepared {formatDate(preview.created_at)}</span>
                <Button size="sm" onClick={() => setReviewing(preview.id)}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Pick the original messages the text comes from, write the text, then check it. */
function ShareForm({rule, onCancel, onPrepared}: {rule: Rule; onCancel: () => void; onPrepared: (id: string) => void}) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Hit[]>([]);
  const [text, setText] = useState('');
  const action = useAction();
  const search = useResource<Hit[]>(query ? '/search?limit=40&q=' + encodeURIComponent(query) : null);
  const groups = new Set(rule.sources.map(space => space.split('/topic/')[0]));
  const hits = (Array.isArray(search.data) ? search.data : []).filter(hit => !hit.scope || groups.has(hit.scope));
  const toggle = (hit: Hit) =>
    setChosen(current =>
      current.some(item => item.id === hit.id) ? current.filter(item => item.id !== hit.id) : [...current, hit],
    );
  const prepare = async () => {
    const result = await action.run<Preview>('prepare', '/sharing/preview', {
      rule_id: rule.id,
      expected_revision: rule.revision,
      source_ids: chosen.map(hit => hit.id),
      query,
      content: text,
    });
    if (result?.id) onPrepared(result.id);
  };
  return (
    <div className="space-y-4 rounded-lg border border-line p-4">
      <form
        className="flex items-end gap-2"
        onSubmit={event => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <Field label="Messages the text is based on" htmlFor="share-search" className="min-w-0 flex-1">
          <Input
            id="share-search"
            type="search"
            value={draft}
            placeholder="Search messages in the source chats"
            onChange={event => setDraft(event.target.value)}
          />
        </Field>
        <Button type="submit" aria-label="Search messages" disabled={!draft.trim()}>
          <Search aria-hidden />
        </Button>
      </form>
      {query && (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
          {search.error && !search.data ? (
            <p className="px-3 py-2 text-[13px] text-warn">Search isn’t available right now.</p>
          ) : !search.data ? (
            <p className="px-3 py-2 text-[13px] text-muted">Searching…</p>
          ) : hits.length ? (
            <ul>
              {hits.map(hit => {
                const checked = chosen.some(item => item.id === hit.id);
                return (
                  <li key={hit.id} className="border-b border-line last:border-b-0">
                    <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm hover:bg-subtle">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked}
                        disabled={!checked && chosen.length >= 10}
                        onChange={() => toggle(hit)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2" dir="auto">
                          {hit.text?.trim() || 'Message without text'}
                        </span>
                        {hit.occurred_at && <span className="text-xs text-muted">{formatDate(hit.occurred_at)}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[13px] text-muted">No messages from this rule’s chats match.</p>
          )}
        </div>
      )}
      <p className="text-xs text-muted">{chosen.length} of 10 messages chosen.</p>
      <Field label="Text to share" htmlFor="share-text" hint="Only this text reaches the chat, never the messages.">
        <Textarea
          id="share-text"
          rows={4}
          maxLength={12000}
          dir="auto"
          value={text}
          onChange={event => setText(event.target.value)}
        />
      </Field>
      <ActionError text={action.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel} disabled={!!action.busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          busy={action.busy === 'prepare'}
          disabled={!chosen.length || !text.trim()}
          onClick={() => void prepare()}
        >
          Check text
        </Button>
      </div>
    </div>
  );
}

/** The exact text after Nocheh's secret check, ready to approve. */
function PreviewReview({id, onDone}: {id: string; onDone: () => void}) {
  const resource = useResource<Preview>('/sharing/previews/' + id);
  const action = useAction();
  const preview = resource.data;
  if (resource.error && !preview)
    return (
      <Notice
        tone="warn"
        action={
          <Button size="sm" onClick={onDone}>
            Close
          </Button>
        }
      >
        This text couldn’t be loaded.
      </Notice>
    );
  if (!preview) return <Spinner />;
  const rule = preview.input?.rule;
  const canApprove =
    preview.state === 'ready' && preview.current && rule?.enabled && rule.mode === 'approved' && !!preview.text?.trim();
  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      {preview.state !== 'ready' ? (
        <Notice tone="info">Nocheh is still checking this text. Look again in a moment.</Notice>
      ) : (
        <>
          <p className="text-[13px] font-medium">This exact text will be available in the chat:</p>
          <blockquote className="rounded-lg bg-subtle p-3 text-sm whitespace-pre-wrap" dir="auto">
            {preview.text || 'Nothing can be shared from these messages.'}
          </blockquote>
        </>
      )}
      {!preview.current && (
        <Notice tone="warn">The rule or the messages changed since this was prepared. Prepare it again.</Notice>
      )}
      <ActionError text={action.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone} disabled={!!action.busy}>
          {canApprove ? 'Not now' : 'Close'}
        </Button>
        {canApprove && (
          <Button
            variant="primary"
            busy={action.busy === 'approve'}
            onClick={async () => {
              const result = await action.run(
                'approve',
                '/sharing/previews/' + id + '/approve',
                {
                  expected_revision: preview.rule_revision,
                  guard_revision: preview.guard_revision,
                  text_hash: preview.text_hash,
                },
                {success: 'Shared. The chat can use this text now.'},
              );
              if (result) onDone();
            }}
          >
            Approve and share
          </Button>
        )}
      </div>
    </div>
  );
}

function releaseState(release: Release): {label: string; tone: 'good' | 'neutral'} {
  if (release.state === 'revoked') return {label: 'Revoked', tone: 'neutral'};
  if (release.expires_at && Date.parse(release.expires_at) < Date.now()) return {label: 'Expired', tone: 'neutral'};
  return {label: 'Shared', tone: 'good'};
}

function SharedTexts({rule}: {rule: Rule}) {
  const releases = useResource<{releases: Release[]; next: string | null}>('/sharing/releases?after=');
  const action = useAction();
  const {confirm} = useFeedback();
  const mine = (releases.data?.releases ?? [])
    .filter(release => release.rule_id === rule.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = mine.filter(release => releaseState(release).label === 'Shared');
  const past = mine.filter(release => releaseState(release).label !== 'Shared');
  const revoke = async (release: Release) => {
    const ok = await confirm({
      title: 'Stop sharing this text?',
      body: 'The chat can’t use it any more. Messages already sent stay as they are.',
      confirm: 'Revoke',
      danger: true,
    });
    if (ok)
      await action.run(
        release.id,
        '/sharing/releases/' + release.id + '/revoke',
        {expected_revision: release.revision},
        {
          success: 'Text no longer shared.',
        },
      );
  };
  const row = (release: Release) => {
    const state = releaseState(release);
    return (
      <li key={release.id} className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-sm">{formatDate(release.created_at)}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
          {state.label === 'Shared' && (
            <Button
              size="sm"
              variant="danger"
              busy={action.busy === release.id}
              disabled={!!action.busy}
              onClick={() => void revoke(release)}
            >
              Revoke
            </Button>
          )}
        </div>
        <ReleaseText previewId={release.preview_id} />
      </li>
    );
  };
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Shared texts</h3>
      {releases.error && !releases.data ? (
        <p className="text-[13px] text-warn">Shared texts couldn’t be loaded.</p>
      ) : !releases.data ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : active.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">{active.map(row)}</ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing is shared through this rule right now.</p>
      )}
      {past.length > 0 && (
        <Details summary={`Earlier (${past.length})`}>
          <ul className="divide-y divide-line rounded-lg border border-line">{past.map(row)}</ul>
        </Details>
      )}
      <ActionError text={action.error} />
      {releases.error && releases.data && (
        <button type="button" className="text-xs text-warn underline" onClick={() => void refreshResources()}>
          May be out of date. Reload
        </button>
      )}
    </section>
  );
}

/** Loads a shared text only when asked, so a long list stays light. */
function ReleaseText({previewId}: {previewId: string}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="link" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? 'Hide text' : 'Show text'}
      </Button>
      {open && <LoadedText previewId={previewId} />}
    </div>
  );
}

function LoadedText({previewId}: {previewId: string}) {
  const resource = useResource<Preview>('/sharing/previews/' + previewId);
  if (resource.error && !resource.data) return <p className="text-[13px] text-warn">The text couldn’t be loaded.</p>;
  if (!resource.data) return <Spinner />;
  return (
    <blockquote className="rounded-lg bg-subtle p-3 text-sm whitespace-pre-wrap" dir="auto">
      {resource.data.text || 'The text isn’t available any more.'}
    </blockquote>
  );
}
