/**
 * Memory › People: the people Nocheh knows, what it knows about each, how they
 * relate, and which chats may use a fact about them.
 */
import {useEffect, useState, type ReactNode} from 'react';
import {ChevronRight, Pencil, Search, Share2, UserRound} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Badge,
  Button,
  Card,
  Details,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Segmented,
  Select,
  Technical,
  Textarea,
} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import {CONFLICT_TEXT, certainty, EvidenceLinks, useChats, useCommand, useCursorPages} from './shared';

type Entity = {
  id: string;
  kind: 'person' | 'project';
  name: string;
  state: 'active' | 'merged' | 'rejected';
  project_id: string | null;
  merged_into: string | null;
  revision: number;
};
type Claim = {
  id: string;
  subject_entity_id: string;
  object_entity_id: string | null;
  predicate: string;
  revision: number;
  content: string;
  relationship_kind: string | null;
  attribution: 'direct' | 'reported' | 'inferred';
  uncertainty: string;
  author: string;
  retired: boolean;
  evidence: {id: string}[];
  created_at: string;
};
type Grant = {
  id: string;
  destination: string;
  fact_id: string;
  fact_revision: number;
  state: string;
  revision: number;
  wording: string | null;
  expires_at: string | null;
};

const attributionLabel: Record<string, string> = {
  direct: 'Said by them',
  reported: 'Said by someone else',
  inferred: 'Nocheh’s guess',
};
const relationshipLabel: Record<string, string> = {
  contextual: 'Related',
  participates: 'Takes part in',
  responsible: 'Responsible for',
  depends_on: 'Depends on',
  associated: 'Associated with',
};
const words = (value: string) => value.replace(/_/g, ' ');

function useDebounced(value: string, ms = 300) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** Names of people and projects by id, for relationships that point at someone else. */
function useNames() {
  const {data} = useResource<{entities: Entity[]}>('/entities?state=all&after=', 60000);
  return (id: string | null | undefined) => data?.entities.find(entity => entity.id === id)?.name ?? null;
}

export function People() {
  const person = useParam('person');
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim());
  const paging = useCursorPages(query);
  const list = useResource<{entities: Entity[]; next: string | null}>(
    '/entities?' + new URLSearchParams({kind: 'person', q: query, after: paging.after, state: 'active'}),
    30000,
  );
  const suggestions = useResource<{suggestions: {id: string}[]; next: string | null}>(
    '/entities/suggestions?after=',
    60000,
  );
  const waiting = suggestions.data?.suggestions.length ?? 0;
  const people = list.data?.entities ?? [];

  return (
    <>
      {waiting > 0 && (
        <Notice
          tone="warn"
          title={
            waiting === 1
              ? 'Nocheh isn’t sure about one name'
              : `Nocheh isn’t sure about ${suggestions.data?.next ? 'more than ' + waiting : waiting} names`
          }
          action={
            <a
              href="#inbox"
              className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-fg hover:bg-subtle"
            >
              Review in Inbox
            </a>
          }
        >
          Confirm whether they are the same person before Nocheh links them.
        </Notice>
      )}
      <Field label="Search people" htmlFor="people-search" className="max-w-md">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
          <Input
            id="people-search"
            type="search"
            className="pl-9"
            placeholder="Name"
            value={typed}
            onChange={event => setTyped(event.target.value)}
          />
        </div>
      </Field>
      <Card>
        {list.error && <LoadError className="m-4" what="people" onRetry={() => void refreshResources()} />}
        {!list.data && !list.error ? (
          <LoadingRows rows={4} />
        ) : list.data && people.length === 0 ? (
          <Empty icon={UserRound} title={query ? 'No one by that name' : 'No people yet'}>
            {query
              ? 'Try part of the name.'
              : 'People appear here when Nocheh learns about them from chats it may learn from.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {people.map(entity => (
              <li key={entity.id}>
                <button
                  type="button"
                  onClick={() => setParams({person: entity.id})}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-subtle/60 focus-visible:bg-subtle/60 focus-visible:outline-none"
                >
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text"
                  >
                    {entity.name.trim().slice(0, 1).toUpperCase() || '?'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{entity.name}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={paging.page}
          hasNext={!!list.data?.next}
          onPage={page => paging.go(page, list.data?.next)}
          summary={list.data ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : undefined}
        />
      </Card>
      <PersonDrawer id={person} onClose={() => setParams({person: null})} />
    </>
  );
}

function PersonDrawer({id, onClose}: {id: string | null; onClose: () => void}) {
  const detail = useResource<{entity: Entity; claims: Claim[]; bindings: unknown[]; partial: boolean}>(
    id ? '/entities/' + id : null,
  );
  const entity = detail.data?.entity;
  return (
    <Drawer open={!!id} onOpenChange={open => !open && onClose()} title={entity?.name ?? 'Person'} wide>
      {detail.error && <LoadError what="this person" onRetry={() => void refreshResources()} />}
      {!detail.data && !detail.error && <LoadingRows rows={4} />}
      {detail.data && entity && (
        <PersonDetail key={entity.id} entity={entity} claims={detail.data.claims} data={detail.data} />
      )}
    </Drawer>
  );
}

function PersonDetail({
  entity,
  claims,
  data,
}: {
  entity: Entity;
  claims: Claim[];
  data: {partial: boolean; bindings: unknown[]};
}) {
  const names = useNames();
  const grants = useResource<{grants: Grant[]}>('/memory-access/grants?after=', 30000);
  const facts = claims.filter(claim => !claim.object_entity_id);
  const relationships = claims.filter(claim => claim.object_entity_id);
  const sharedFor = (claim: Claim) =>
    (grants.data?.grants ?? []).filter(
      grant => grant.fact_id === claim.id && ['active', 'suspended'].includes(grant.state),
    );

  return (
    <div className="space-y-6">
      <NameEditor entity={entity} mergedInto={names(entity.merged_into)} />

      <section>
        <h3 className="mb-2 text-sm font-semibold">What Nocheh knows</h3>
        {facts.length === 0 ? (
          <p className="text-[13px] text-muted">No facts about this person yet.</p>
        ) : (
          <ul className="space-y-3">
            {facts.map(claim => (
              <ClaimItem key={claim.id + ':' + claim.revision} claim={claim} grants={sharedFor(claim)} shareable />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Relationships</h3>
        {relationships.length === 0 ? (
          <p className="text-[13px] text-muted">No known relationships.</p>
        ) : (
          <ul className="space-y-3">
            {relationships.map(claim => {
              const outgoing = claim.subject_entity_id === entity.id;
              const other = names(outgoing ? claim.object_entity_id : claim.subject_entity_id);
              return (
                <ClaimItem
                  key={claim.id + ':' + claim.revision}
                  claim={claim}
                  grants={[]}
                  heading={
                    <>
                      {claim.relationship_kind
                        ? (relationshipLabel[claim.relationship_kind] ?? words(claim.relationship_kind))
                        : words(claim.predicate)}
                      {' · '}
                      {other ?? 'someone else'}
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </section>

      {data.partial && <Notice>Only the first 200 facts are shown.</Notice>}
      {grants.error && <p className="text-[13px] text-muted">Couldn’t check which chats may use these facts.</p>}
      <MergePerson entity={entity} />
      <Technical value={{entity, bindings: data.bindings}} />
    </div>
  );
}

function NameEditor({entity, mergedInto}: {entity: Entity; mergedInto: string | null}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entity.name);
  if (entity.state === 'merged')
    return (
      <Notice
        tone="info"
        title={`Merged into ${mergedInto ?? 'another person'}`}
        action={
          <Button
            size="sm"
            busy={command.busy}
            onClick={async () => {
              if (await command.run('/entities/' + entity.id + '/unmerge', {expected_revision: entity.revision}))
                feedback.toast('Merge undone.');
            }}
          >
            Undo merge
          </Button>
        }
      >
        {command.error || 'Facts about this name are shown under that person.'}
      </Notice>
    );
  if (!editing)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Person</Badge>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          <Pencil aria-hidden /> Rename
        </Button>
      </div>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={async event => {
        event.preventDefault();
        if (
          await command.run('/entities/' + entity.id + '/rename', {
            name: name.trim(),
            expected_revision: entity.revision,
          })
        ) {
          setEditing(false);
          feedback.toast('Name saved.');
        }
      }}
    >
      <Field label="Name" htmlFor="person-name" error={command.error}>
        <Input
          id="person-name"
          value={name}
          maxLength={200}
          onChange={event => setName(event.target.value)}
          autoFocus
        />
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          busy={command.busy}
          disabled={!name.trim() || name.trim() === entity.name}
        >
          Save name
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setName(entity.name);
            command.clear();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ClaimItem({
  claim,
  grants,
  heading,
  shareable,
}: {
  claim: Claim;
  grants: Grant[];
  heading?: ReactNode;
  shareable?: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'share'>('view');
  const sure = certainty[claim.uncertainty];
  const chats = useChats();
  return (
    <li className="rounded-xl border border-line p-4">
      {heading && <p className="mb-1 text-[13px] font-medium text-muted">{heading}</p>}
      <p className="text-sm break-words" dir="auto">
        {claim.content}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {claim.author === 'owner' ? (
          <Badge tone="accent">Corrected by you</Badge>
        ) : (
          sure && <Badge tone={sure.tone}>{sure.label}</Badge>
        )}
        <Badge>{attributionLabel[claim.attribution] ?? words(claim.attribution)}</Badge>
      </div>
      <EvidenceLinks sources={claim.evidence} className="mt-2" />
      {mode === 'view' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setMode('edit')}>
            <Pencil aria-hidden /> Correct
          </Button>
          {shareable && (
            <Button size="sm" onClick={() => setMode('share')}>
              <Share2 aria-hidden /> Let a chat use it
            </Button>
          )}
        </div>
      )}
      {mode === 'edit' && <ClaimEditor claim={claim} onDone={() => setMode('view')} />}
      {mode === 'share' && <ShareForm claim={claim} onDone={() => setMode('view')} />}
      {grants.length > 0 && mode === 'view' && <GrantList grants={grants} />}
    </li>
  );
}

function ClaimEditor({claim, onDone}: {claim: Claim; onDone: () => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [content, setContent] = useState(claim.content);
  const [attribution, setAttribution] = useState(claim.attribution);
  const [uncertainty, setUncertainty] = useState(claim.uncertainty);
  const [kind, setKind] = useState(claim.relationship_kind ?? 'associated');
  const save = async (retired: boolean) => {
    if (
      retired &&
      !(await feedback.confirm({
        title: 'Retire this?',
        body: 'Nocheh stops using it. Chats that were allowed to use it lose access.',
        confirm: 'Retire',
        danger: true,
      }))
    )
      return;
    const result = await command.run('/entities/claims/' + claim.id + '/correct', {
      content: content.trim(),
      attribution,
      uncertainty,
      retired,
      expected_revision: claim.revision,
      ...(claim.object_entity_id ? {relationship_kind: kind} : {}),
    });
    if (result) {
      feedback.toast(retired ? 'Retired.' : 'Correction saved.');
      onDone();
    }
  };
  const id = 'claim-' + claim.id.slice(0, 8);
  return (
    <form
      className="mt-3 space-y-3 border-t border-line pt-3"
      onSubmit={event => {
        event.preventDefault();
        void save(false);
      }}
    >
      <Field label="Wording" htmlFor={id + '-text'}>
        <Textarea
          id={id + '-text'}
          rows={3}
          maxLength={8000}
          value={content}
          dir="auto"
          onChange={event => setContent(event.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who said it" htmlFor={id + '-who'}>
          <Select
            id={id + '-who'}
            value={attribution}
            onChange={event => setAttribution(event.target.value as Claim['attribution'])}
          >
            <option value="direct">They said it themselves</option>
            <option value="reported">Someone else said it</option>
            <option value="inferred">Nocheh guessed it</option>
          </Select>
        </Field>
        <Field label="How sure" htmlFor={id + '-sure'}>
          <Select id={id + '-sure'} value={uncertainty} onChange={event => setUncertainty(event.target.value)}>
            <option value="explicit">Stated clearly</option>
            <option value="supported">Likely</option>
            <option value="uncertain">Unsure</option>
          </Select>
        </Field>
        {claim.object_entity_id && (
          <Field label="Relationship" htmlFor={id + '-kind'}>
            <Select id={id + '-kind'} value={kind} onChange={event => setKind(event.target.value)}>
              {Object.entries(relationshipLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {command.error && (
        <Notice
          tone={command.error === CONFLICT_TEXT ? 'warn' : 'bad'}
          action={
            command.error === CONFLICT_TEXT && (
              <Button size="sm" onClick={() => void refreshResources()}>
                Reload
              </Button>
            )
          }
        >
          {command.error}
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" busy={command.busy} disabled={!content.trim()}>
          Save correction
        </Button>
        <Button size="sm" variant="ghost" disabled={command.busy} onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" className="ml-auto" disabled={command.busy} onClick={() => void save(true)}>
          Retire
        </Button>
      </div>
    </form>
  );
}

function ShareForm({claim, onDone}: {claim: Claim; onDone: () => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
  const [destination, setDestination] = useState('');
  const [wording, setWording] = useState(claim.content);
  const [length, setLength] = useState<'always' | 'until'>('always');
  const [until, setUntil] = useState('');
  const id = 'share-' + claim.id.slice(0, 8);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  return (
    <form
      className="mt-3 space-y-3 border-t border-line pt-3"
      onSubmit={async event => {
        event.preventDefault();
        const result = await command.run('/memory-access/grants', {
          fact_id: claim.id,
          fact_revision: claim.revision,
          destination,
          wording: wording.trim(),
          ...(length === 'until' && until ? {expires_at: new Date(until + 'T23:59:59').toISOString()} : {}),
        });
        if (result) {
          feedback.toast(`${chats.name(destination)} may now use this.`);
          onDone();
        }
      }}
    >
      <p className="text-[13px] text-muted">Only the wording below is shared. The original messages stay private.</p>
      <Field label="Chat" htmlFor={id + '-chat'}>
        <Select id={id + '-chat'} value={destination} onChange={event => setDestination(event.target.value)}>
          <option value="">Choose a chat…</option>
          {chats.items.map(chat => (
            <option key={chat.space_id} value={chat.space_id}>
              {chats.name(chat.space_id)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Wording the chat may use" htmlFor={id + '-text'}>
        <Textarea
          id={id + '-text'}
          rows={3}
          maxLength={12000}
          value={wording}
          dir="auto"
          onChange={event => setWording(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label="How long"
          size="sm"
          value={length}
          onChange={setLength}
          options={[
            {value: 'always', label: 'Until I stop it'},
            {value: 'until', label: 'Until a date'},
          ]}
        />
        {length === 'until' && (
          <Input
            type="date"
            aria-label="Last day"
            className="w-44"
            min={tomorrow}
            value={until}
            onChange={event => setUntil(event.target.value)}
          />
        )}
      </div>
      {command.error && <Notice tone="bad">{command.error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          busy={command.busy}
          disabled={!destination || !wording.trim() || (length === 'until' && !until)}
        >
          Share
        </Button>
        <Button size="sm" variant="ghost" disabled={command.busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function GrantList({grants}: {grants: Grant[]}) {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
  return (
    <div className="mt-3 border-t border-line pt-3">
      <ul className="space-y-2">
        {grants.map(grant => (
          <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0">
              {chats.name(grant.destination)}
              <span className="text-muted">
                {grant.state === 'suspended'
                  ? ' · paused until you approve the new wording'
                  : grant.expires_at
                    ? ' · until ' + new Date(grant.expires_at).toLocaleDateString()
                    : ' · until you stop it'}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={command.busy}
              onClick={async () => {
                const ok = await feedback.confirm({
                  title: `Stop sharing with ${chats.name(grant.destination)}?`,
                  body: 'The chat can no longer use this fact. Messages already sent stay sent.',
                  confirm: 'Stop sharing',
                  danger: true,
                });
                if (
                  ok &&
                  (await command.run('/memory-access/grants/' + grant.id + '/revoke', {
                    expected_revision: grant.revision,
                  }))
                )
                  feedback.toast('Sharing stopped.');
              }}
            >
              Stop sharing
            </Button>
          </li>
        ))}
      </ul>
      {command.error && <p className="mt-2 text-xs text-bad">{command.error}</p>}
    </div>
  );
}

function MergePerson({entity}: {entity: Entity}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [target, setTarget] = useState('');
  const people = useResource<{entities: Entity[]}>('/entities?kind=person&q=&after=&state=active', 60000);
  if (entity.state !== 'active') return null;
  const others = (people.data?.entities ?? []).filter(person => person.id !== entity.id);
  if (!others.length) return null;
  return (
    <Details summary="Same person as someone else?">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">Merge two names that are really one person. You can undo it later.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Merge into" htmlFor="merge-target" className="min-w-48 flex-1">
            <Select id="merge-target" value={target} onChange={event => setTarget(event.target.value)}>
              <option value="">Choose a person…</option>
              {others.map(person => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="danger"
            busy={command.busy}
            disabled={!target}
            onClick={async () => {
              const into = others.find(person => person.id === target)?.name ?? 'that person';
              const ok = await feedback.confirm({
                title: `Merge ${entity.name} into ${into}?`,
                body: 'Nocheh will treat both names as one person.',
                confirm: 'Merge',
                danger: true,
              });
              if (
                ok &&
                (await command.run('/entities/' + entity.id + '/merge', {
                  target_id: target,
                  expected_revision: entity.revision,
                }))
              )
                feedback.toast('Merged.');
            }}
          >
            Merge
          </Button>
        </div>
        {command.error && <p className="text-xs text-bad">{command.error}</p>}
      </div>
    </Details>
  );
}
