/**
 * Memory › Facts: what Nocheh learned from conversations (meanings, situations
 * and conventions), and correcting or retiring any of it.
 */
import {useEffect, useState} from 'react';
import {Lightbulb, Search} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Select,
  Technical,
  Textarea,
} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import {CONFLICT_TEXT, certainty, EvidenceLinks, useChats, useCommand, useCursorPages, when} from './shared';

export type Learned = {
  id: string;
  subject: string;
  kind: string;
  scope_kind: 'conversation' | 'project';
  scope_id: string;
  active_revision: number;
  text: string;
  author: string;
  retired: boolean;
  revised_at: string;
  provenance: {
    learning?: {uncertainty?: string; evidence?: {id: string}[]; conflicts?: string[]};
    [key: string]: unknown;
  };
};
type Version = {
  revision: number;
  text: string;
  author: string;
  retired: boolean;
  created_at: string;
  evidence?: {id: string}[];
  provenance?: any;
};
type Project = {id: string; name: string; state: string};

const kindLabel: Record<string, string> = {meaning: 'Meaning', state: 'Situation', convention: 'Convention'};
const authorLabel = (author: string) =>
  author === 'owner' ? 'You' : author === 'participant' ? 'Someone in the chat' : 'Nocheh';
type Show = 'current' | 'revised' | 'unsure' | 'retired';

export function Facts() {
  const project = useParam('project');
  const chat = useParam('chat');
  const entry = useParam('entry');
  const show = (useParam('show') as Show | null) ?? 'current';
  const [query, setQuery] = useState('');
  const chats = useChats();
  const projects = useResource<{projects: Project[]}>('/projects?after=', 60000);
  const scope = project ? {kind: 'project', id: project} : chat ? {kind: 'conversation', id: chat} : null;
  const paging = useCursorPages(scope ? scope.kind + scope.id : '');
  const params = new URLSearchParams({after: paging.after});
  if (scope) {
    params.set('scope_kind', scope.kind);
    params.set('scope_id', scope.id);
  }
  const list = useResource<{entries: Learned[]; next: string | null}>('/learned?' + params, 30000);
  const projectName = (id: string) => projects.data?.projects.find(p => p.id === id)?.name ?? 'A project';
  const where = (item: Learned) =>
    item.scope_kind === 'project' ? projectName(item.scope_id) : chats.name(item.scope_id);

  const needle = query.trim().toLocaleLowerCase();
  const visible = (list.data?.entries ?? []).filter(item => {
    const learning = item.provenance?.learning ?? {};
    if (show === 'retired' ? !item.retired : item.retired) return false;
    if (show === 'revised' && item.active_revision < 2) return false;
    if (show === 'unsure' && learning.uncertainty !== 'uncertain' && !learning.conflicts?.length) return false;
    return !needle || (item.subject + ' ' + item.text + ' ' + where(item)).toLocaleLowerCase().includes(needle);
  });

  const scopeValue = project ? 'project:' + project : chat ? 'chat:' + chat : '';
  const knownScope =
    !scopeValue ||
    (project ? projects.data?.projects.some(p => p.id === project) : chats.items.some(c => c.space_id === chat));

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Field label="Search" htmlFor="facts-search" className="sm:min-w-56 sm:flex-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
            <Input
              id="facts-search"
              type="search"
              className="pl-9"
              placeholder="Words in a fact"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </div>
        </Field>
        <Field label="Learned in" htmlFor="facts-scope" className="sm:w-64">
          <Select
            id="facts-scope"
            value={scopeValue}
            onChange={event => {
              const [kind, ...rest] = event.target.value.split(':');
              const id = rest.join(':');
              setParams(
                {project: kind === 'project' ? id : null, chat: kind === 'chat' ? id : null, entry: null},
                true,
              );
            }}
          >
            <option value="">All chats and projects</option>
            {!knownScope && <option value={scopeValue}>{project ? 'Chosen project' : chats.name(chat)}</option>}
            {!!projects.data?.projects.length && (
              <optgroup label="Projects">
                {projects.data.projects.map(p => (
                  <option key={p.id} value={'project:' + p.id}>
                    {p.name}
                    {p.state === 'archived' ? ' (archived)' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {!!chats.items.length && (
              <optgroup label="Chats">
                {chats.items.map(c => (
                  <option key={c.space_id} value={'chat:' + c.space_id}>
                    {chats.name(c.space_id)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label="Show" htmlFor="facts-show" className="sm:w-48">
          <Select
            id="facts-show"
            value={show}
            onChange={event => setParams({show: event.target.value === 'current' ? null : event.target.value}, true)}
          >
            <option value="current">Current facts</option>
            <option value="revised">Only revised</option>
            <option value="unsure">Unsure or conflicting</option>
            <option value="retired">Retired</option>
          </Select>
        </Field>
      </div>

      <Card>
        {list.error && <LoadError className="m-4" what="learned facts" onRetry={() => void refreshResources()} />}
        {!list.data && !list.error ? (
          <LoadingRows rows={5} />
        ) : list.data && visible.length === 0 ? (
          <Empty icon={Lightbulb} title={list.data.entries.length ? 'Nothing matches' : 'Nothing learned yet'}>
            {list.data.entries.length
              ? 'Try other words or another filter.'
              : scope
                ? 'Nothing has been learned in this chat or project yet.'
                : 'Facts appear here as Nocheh learns from chats it is allowed to learn from.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map(item => (
              <FactRow key={item.id} item={item} where={where(item)} onOpen={() => setParams({entry: item.id})} />
            ))}
          </ul>
        )}
        <Pager
          page={paging.page}
          hasNext={!!list.data?.next}
          onPage={page => paging.go(page, list.data?.next)}
          summary={
            list.data ? `${visible.length} shown` + (needle || show !== 'current' ? ' on this page' : '') : undefined
          }
        />
      </Card>

      <FactDrawer
        id={entry}
        row={list.data?.entries.find(item => item.id === entry) ?? null}
        where={where}
        onClose={() => setParams({entry: null})}
      />
    </>
  );
}

function FactBadges({item, where}: {item: Learned; where?: string}) {
  const learning = item.provenance?.learning ?? {};
  const sure = certainty[learning.uncertainty ?? ''];
  return (
    <div className="flex flex-wrap gap-1.5">
      {where && <Badge>{where}</Badge>}
      <Badge>{kindLabel[item.kind] ?? 'Fact'}</Badge>
      {item.retired && <Badge>Retired</Badge>}
      {!item.retired && item.author === 'owner' && <Badge tone="accent">Corrected by you</Badge>}
      {!item.retired && item.author !== 'owner' && item.active_revision > 1 && <Badge tone="accent">Revised</Badge>}
      {!item.retired && item.author !== 'owner' && sure && <Badge tone={sure.tone}>{sure.label}</Badge>}
      {!item.retired && !!learning.conflicts?.length && <Badge tone="warn">Conflicts</Badge>}
    </div>
  );
}

function FactRow({item, where, onOpen}: {item: Learned; where: string; onOpen: () => void}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full px-5 py-3.5 text-left transition-colors hover:bg-subtle/60 focus-visible:bg-subtle/60 focus-visible:outline-none"
      >
        <p className="text-[13px] font-medium text-muted">{item.subject}</p>
        <p
          className={'mt-0.5 line-clamp-2 text-sm break-words ' + (item.retired ? 'text-muted line-through' : '')}
          dir="auto"
        >
          {item.text}
        </p>
        <div className="mt-2">
          <FactBadges item={item} where={where} />
        </div>
      </button>
    </li>
  );
}

function FactDrawer({
  id,
  row,
  where,
  onClose,
}: {
  id: string | null;
  row: Learned | null;
  where: (item: Learned) => string;
  onClose: () => void;
}) {
  const detail = useResource<{
    active_revision: number;
    versions: Version[];
    entry: Learned | null;
    next?: number | null;
  }>(id ? '/learned/' + id : null);
  const version = detail.data?.versions.find(v => v.revision === detail.data?.active_revision);
  const learning = version?.provenance?.learning;
  // The list row is enough to start; the detail read is the authority once it arrives.
  const item: Learned | null =
    detail.data?.entry ??
    (version && learning
      ? {
          id: id!,
          subject: learning.subject ?? row?.subject ?? 'Fact',
          kind: learning.kind ?? row?.kind ?? '',
          scope_kind: learning.scope?.kind ?? row?.scope_kind,
          scope_id: learning.scope?.id ?? row?.scope_id,
          text: version.text,
          author: version.author,
          retired: version.retired,
          active_revision: version.revision,
          revised_at: version.created_at,
          provenance: version.provenance,
        }
      : row);
  return (
    <Drawer open={!!id} onOpenChange={open => !open && onClose()} title={item?.subject ?? 'Fact'} wide>
      {detail.error && !item && <LoadError what="this fact" onRetry={() => void refreshResources()} />}
      {detail.error && item && <LoadError what="the latest version" onRetry={() => void refreshResources()} />}
      {!item && !detail.error && <LoadingRows rows={4} />}
      {item && (
        <FactDetail
          key={item.id}
          item={item}
          where={where(item)}
          versions={detail.data?.versions ?? null}
          firstNext={detail.data?.next ?? null}
        />
      )}
    </Drawer>
  );
}

function FactDetail({
  item,
  where,
  versions,
  firstNext,
}: {
  item: Learned;
  where: string;
  versions: Version[] | null;
  firstNext: number | null;
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [text, setText] = useState(item.text);
  // The revision this draft was started from; a reload moves it forward but keeps the typed text.
  const [base, setBase] = useState(item.active_revision);
  const dirty = text.trim() !== item.text.trim();
  useEffect(() => {
    if (!dirty) setBase(item.active_revision);
  }, [item.active_revision, dirty]);
  // After a reload, adopt the newest revision as the draft's base while keeping the typed text.
  const [adopt, setAdopt] = useState(false);
  useEffect(() => {
    if (!adopt) return;
    setBase(item.active_revision);
    setAdopt(false);
  }, [adopt, item.active_revision]);
  const conflict = base !== item.active_revision || command.error === CONFLICT_TEXT;
  const learning = item.provenance?.learning ?? {};

  const save = async (retired: boolean) => {
    if (retired) {
      const ok = await feedback.confirm({
        title: 'Retire this fact?',
        body: 'Nocheh stops using it. Its history is kept and you can restore it later.',
        confirm: 'Retire',
        danger: true,
      });
      if (!ok) return;
    }
    const result = await command.run<{revision: number}>('/learned/' + item.id + '/correct', {
      expected_revision: base,
      retired,
      ...(retired ? {} : {text: text.trim()}),
    });
    if (result) {
      setBase(result.revision);
      feedback.toast(
        retired ? 'Fact retired.' : item.retired ? 'Fact restored with your wording.' : 'Correction saved.',
      );
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <FactBadges item={item} where={where} />
        <p className={'text-[15px] leading-relaxed break-words ' + (item.retired ? 'text-muted' : '')} dir="auto">
          {item.text}
        </p>
        <p className="text-xs text-muted">
          {authorLabel(item.author)} · {when(item.revised_at)}
          {item.active_revision > 1 ? ` · version ${item.active_revision}` : ''}
        </p>
      </section>

      {item.active_revision > 1 && <OriginalWording id={item.id} versions={versions} />}

      {!!learning.conflicts?.length && (
        <Notice tone="warn" title="Other facts disagree with this one">
          <ul className="mt-1 space-y-0.5">
            {learning.conflicts.map((other, index) => (
              <li key={other}>
                <a className="text-accent-text hover:underline" href={'#memory?view=facts&entry=' + other}>
                  Conflicting fact {learning.conflicts!.length > 1 ? index + 1 : ''}
                </a>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <form
        className="space-y-3 rounded-xl border border-line p-4"
        onSubmit={event => {
          event.preventDefault();
          void save(false);
        }}
      >
        <Field
          label={item.retired ? 'Restore with this wording' : 'Correct it'}
          htmlFor="fact-text"
          hint="Your wording replaces what Nocheh learned. The earlier version stays in the history."
        >
          <Textarea
            id="fact-text"
            rows={4}
            maxLength={8000}
            value={text}
            dir="auto"
            onChange={event => {
              setText(event.target.value);
              command.clear();
            }}
          />
        </Field>
        {conflict ? (
          <Notice
            tone="warn"
            action={
              <Button
                size="sm"
                onClick={async () => {
                  command.clear();
                  await refreshResources();
                  setAdopt(true);
                }}
              >
                Reload
              </Button>
            }
          >
            {CONFLICT_TEXT}
          </Notice>
        ) : (
          command.error && <Notice tone="bad">{command.error}</Notice>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            busy={command.busy}
            disabled={!text.trim() || conflict || (!dirty && !item.retired)}
          >
            {item.retired ? 'Restore' : 'Save correction'}
          </Button>
          {dirty && (
            <Button variant="ghost" disabled={command.busy} onClick={() => setText(item.text)}>
              Undo changes
            </Button>
          )}
          {!item.retired && (
            <Button variant="danger" className="sm:ml-auto" disabled={command.busy} onClick={() => void save(true)}>
              Retire
            </Button>
          )}
        </div>
      </form>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Where it came from</h3>
        <EvidenceLinks sources={learning.evidence} />
      </section>

      <History id={item.id} first={versions} firstNext={firstNext} />
      <Technical value={item.provenance} />
    </div>
  );
}

function OriginalWording({id, versions}: {id: string; versions: Version[] | null}) {
  const inFirst = versions?.find(v => v.revision === 1);
  const original = useResource<{versions: Version[]}>(
    versions && !inFirst ? '/learned/' + id + '/history?before=2' : null,
  );
  const first = inFirst ?? original.data?.versions[0];
  return (
    <section className="rounded-xl bg-subtle/70 p-4">
      <h3 className="text-[13px] font-medium text-muted">Originally learned as</h3>
      {first ? (
        <p className="mt-1 text-sm break-words" dir="auto">
          {first.text}
        </p>
      ) : original.error ? (
        <p className="mt-1 text-[13px] text-muted">Couldn’t load the original wording.</p>
      ) : (
        <p className="mt-1 text-[13px] text-muted">Loading…</p>
      )}
    </section>
  );
}

function History({id, first, firstNext}: {id: string; first: Version[] | null; firstNext: number | null}) {
  const [before, setBefore] = useState<number[]>([]);
  // The first page comes with the fact itself; only older pages are read separately.
  const older = useResource<{versions: Version[]; next: number | null}>(
    before.length ? '/learned/' + id + '/history?before=' + before.at(-1) : null,
  );
  const versions = before.length ? (older.data?.versions ?? null) : first;
  const next = before.length ? (older.data?.next ?? null) : firstNext;
  const items = versions ?? [];
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">History</h3>
      {older.error && !versions && <p className="text-[13px] text-muted">Couldn’t load the history.</p>}
      {!versions && !older.error && <LoadingRows rows={2} />}
      {versions && (
        <ol className="space-y-3 border-l border-line pl-4">
          {items.map(version => (
            <li key={version.revision} className="relative">
              <span
                aria-hidden
                className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface bg-line-strong"
              />
              <p className="text-xs text-muted">
                Version {version.revision} · {authorLabel(version.author)} · {when(version.created_at)}
                {version.retired ? ' · retired' : ''}
              </p>
              <p className="mt-0.5 text-sm break-words" dir="auto">
                {version.text}
              </p>
            </li>
          ))}
        </ol>
      )}
      {(before.length > 0 || next) && (
        <div className="mt-3 flex gap-2">
          {before.length > 0 && (
            <Button size="sm" onClick={() => setBefore(stack => stack.slice(0, -1))}>
              Newer
            </Button>
          )}
          {next && (
            <Button size="sm" onClick={() => setBefore(stack => [...stack, next])}>
              Older
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
