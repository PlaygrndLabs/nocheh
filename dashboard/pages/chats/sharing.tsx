/** Sharing: which chats' facts may be used in which chat, and the defaults for every chat. */
import {useState} from 'react';
import {ArrowRight, Plus, Share2} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {useParam} from '../../lib/navigation';
import {chatFromId, chatName, type Directory} from '../../lib/chats-model';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  LoadError,
  LoadingRows,
  Pager,
  Segmented,
  SettingRow,
  Switch,
} from '../../ui/core';
import {modeText, ruleBody, RuleDialog, type Rule} from './rule-dialog';
import {RuleDrawer} from './rule-drawer';
import {ActionError, Unsaved, useAction, type Telegram} from './shared';
import {DefaultSuggestions} from './suggestions';

export function SharingView({telegram}: {telegram: Telegram}) {
  const [pages, setPages] = useState<string[]>(['']);
  const rules = useResource<{rules: Rule[]; next: string | null}>('/sharing/rules?after=' + pages.at(-1));
  const directory = useResource<Directory>('/conversations?limit=100');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const open = useParam('rule');
  const action = useAction();
  const name = (space: string) =>
    chatName(directory.data?.items.find(item => item.space_id === space) ?? chatFromId(space), telegram.owner);
  const list = rules.data?.rules ?? [];
  const openRule = open ? (list.find(rule => rule.id === open) ?? null) : null;

  return (
    <>
      <Card>
        <CardHeader
          title="Sharing rules"
          description="Each chat remembers only its own messages. A rule lets one chat use facts from others."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> New rule
            </Button>
          }
        />
        <CardBody className="pt-3">
          {rules.error && !rules.data ? (
            <LoadError what="sharing rules" onRetry={() => void refreshResources()} />
          ) : !rules.data ? (
            <LoadingRows rows={3} />
          ) : list.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.map(rule => (
                <li key={rule.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 basis-60 text-left"
                    onClick={() => setParams({rule: rule.id})}
                  >
                    <span className="block truncate text-sm font-medium hover:underline" dir="auto">
                      {rule.name}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                      <span className="truncate" dir="auto">
                        {rule.sources.map(name).join(', ')}
                      </span>
                      <ArrowRight className="size-3 shrink-0" aria-label="into" />
                      <span className="truncate" dir="auto">
                        {name(rule.destination)}
                      </span>
                    </span>
                  </button>
                  <Badge>{modeText[rule.mode].label}</Badge>
                  <Switch
                    checked={rule.enabled}
                    disabled={!!action.busy}
                    label={(rule.enabled ? 'Turn off ' : 'Turn on ') + rule.name}
                    onChange={enabled =>
                      void action.run(rule.id, '/sharing/rules', ruleBody({...rule, enabled}, rule.revision), {
                        success: enabled ? 'Rule turned on.' : 'Rule turned off.',
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={Share2} title="No sharing rules">
              Without a rule, nothing from one chat is used in another unless you approve it in the Inbox.
            </Empty>
          )}
          <ActionError text={action.error} />
        </CardBody>
        <Pager
          page={pages.length - 1}
          hasNext={!!rules.data?.next}
          onPage={page =>
            setPages(current =>
              page < current.length - 1 ? current.slice(0, page + 1) : [...current, rules.data!.next!],
            )
          }
        />
      </Card>

      <Card id="defaults">
        <CardHeader title="Defaults" description="Used by every chat unless you set something else for one chat." />
        <div className="mt-2">
          <SettingRow
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                Topic memory <Unsaved show={telegram.topicMemoryChanged} />
              </span>
            }
            description={
              telegram.topicMemory === 'topic'
                ? 'Each topic remembers only its own messages.'
                : 'A group’s main chat and all its topics share one memory.'
            }
          >
            <div className="sm:flex sm:justify-end">
              <Segmented
                label="Topic memory"
                value={telegram.topicMemory === 'topic' ? 'topic' : 'group'}
                disabled={!telegram.loaded || telegram.busy}
                options={[
                  {value: 'group', label: 'Whole group'},
                  {value: 'topic', label: 'Each topic'},
                ]}
                onChange={telegram.setTopicMemory}
              />
            </div>
          </SettingRow>
          <div className="border-t border-line px-5 pt-4 pb-2">
            <h3 className="text-sm font-medium">Fact suggestions</h3>
            <p className="mt-0.5 text-[13px] text-muted">
              When a fact from another chat could help, Nocheh can ask you before sharing it.
            </p>
            <div className="mt-2 pb-2">
              <DefaultSuggestions />
            </div>
          </div>
        </div>
      </Card>

      {editing && (
        <RuleDialog
          key={editing === 'new' ? 'new' : editing.id + ':' + editing.revision}
          rule={editing === 'new' ? null : editing}
          owner={telegram.owner}
          open
          onOpenChange={next => !next && setEditing(null)}
        />
      )}
      <RuleDrawer
        rule={openRule}
        missing={!!rules.data && !openRule}
        open={!!open}
        owner={telegram.owner}
        onOpenChange={next => !next && setParams({rule: null})}
        onEdit={rule => setEditing(rule)}
      />
    </>
  );
}
