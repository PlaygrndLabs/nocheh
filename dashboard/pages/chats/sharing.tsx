/** Sharing: which chats' facts may be used in which chat, and the defaults for every chat, each on its own sub-tab. */
import {useState} from 'react';
import {Plus, Share2} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {useParam, useSubTab} from '../../lib/navigation';
import {chatName, unknownChat} from '../../lib/chats-model';
import {useChatDirectory} from '../../lib/chat-directory';
import {
  Button,
  Card,
  CardHeader,
  Empty,
  LoadError,
  LoadingRows,
  Pager,
  Segmented,
  SettingRow,
  Switch,
  Table,
  Td,
  Th,
} from '../../ui/core';
import {SubPanel, SubTabs} from '../../ui/page';
import {modeText, ruleBody, RuleDialog, type Rule} from './rule-dialog';
import {RuleDrawer} from './rule-drawer';
import {ActionError, Unsaved, useAction, type Telegram} from './shared';
import {DefaultSuggestions} from './suggestions';

/** Rules on one page of the table. */
const PAGE = 10;
const subTabs = ['rules', 'defaults'] as const;

export function SharingView({telegram}: {telegram: Telegram}) {
  const [pages, setPages] = useState<string[]>(['']);
  const rules = useResource<{rules: Rule[]; next: string | null}>('/sharing/rules?after=' + pages.at(-1));
  const chats = useChatDirectory();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const open = useParam('rule');
  const action = useAction();
  const name = (space: string) => chatName(chats.find(space) ?? unknownChat(space));
  const list = rules.data?.rules ?? [];
  const openRule = open ? (list.find(rule => rule.id === open) ?? null) : null;
  // A page of the table is the first ten the server gave; the next one starts after the tenth.
  const shown = list.slice(0, PAGE);
  const next = list.length > PAGE ? shown.at(-1)!.id : (rules.data?.next ?? null);
  const [tab, setTab] = useSubTab(subTabs);

  return (
    <>
      {/* Both panels stay on the page, so an unsaved default is kept while the rules are shown. */}
      <SubTabs
        label="Sharing"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'rules', label: 'Rules'},
          {id: 'defaults', label: 'Defaults'},
        ]}
      />
      <SubPanel id="rules" current={tab}>
        <Card>
          <CardHeader
            title="Sharing rules"
            description="A group answer uses only that group, or its whole project while the project shares its group chats. A rule is your exception: it lets a group use facts from others, and you and every member there see what it lets in. Only you make rules."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus aria-hidden /> New rule
              </Button>
            }
          />
          <div className="mt-3 border-t border-line">
            {rules.error && !rules.data ? (
              <LoadError className="m-4" what="sharing rules" onRetry={() => void refreshResources()} />
            ) : !rules.data ? (
              <LoadingRows rows={3} />
            ) : shown.length ? (
              <Table aria-label="Sharing rules" className="max-sm:block [&>tbody]:max-sm:block">
                <thead className="max-sm:sr-only">
                  <tr>
                    <Th scope="col">Rule</Th>
                    <Th scope="col">Shares from</Th>
                    <Th scope="col">Into</Th>
                    <Th scope="col">How</Th>
                    <Th scope="col">On</Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(rule => (
                    <tr
                      key={rule.id}
                      className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2.5 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0"
                    >
                      <Td className="max-w-0 align-middle sm:w-[32%] max-sm:w-full max-sm:max-w-none">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                          onClick={() => setParams({rule: rule.id})}
                          dir="auto"
                        >
                          {rule.name}
                        </button>
                        {!!rule.private_sources?.length && (
                          <span className="block truncate text-xs text-warn">
                            Reads a private chat. Nocheh skips it.
                          </span>
                        )}
                      </Td>
                      <Td
                        className="max-w-0 truncate align-middle text-[13px] text-muted sm:w-[24%] max-sm:max-w-none"
                        dir="auto"
                      >
                        <span className="sm:hidden">From </span>
                        {rule.sources.map(name).join(', ')}
                      </Td>
                      <Td
                        className="max-w-0 truncate align-middle text-[13px] text-muted sm:w-[20%] max-sm:max-w-none"
                        dir="auto"
                      >
                        <span className="sm:hidden">into </span>
                        {name(rule.destination)}
                      </Td>
                      <Td className="align-middle text-[13px] whitespace-nowrap text-muted">
                        {modeText[rule.mode].label}
                      </Td>
                      <Td className="align-middle max-sm:ml-auto">
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
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Empty icon={Share2} title="No sharing rules">
                Without a rule, nothing from one chat is used in another unless you approve it in the Inbox. Projects
                never share between their groups.
              </Empty>
            )}
            {action.error && (
              <div className="px-5 pb-3">
                <ActionError text={action.error} />
              </div>
            )}
          </div>
          <Pager
            page={pages.length - 1}
            hasNext={!!next}
            onPage={page =>
              setPages(current => (page < current.length - 1 ? current.slice(0, page + 1) : [...current, next!]))
            }
          />
        </Card>
      </SubPanel>

      <SubPanel id="defaults" current={tab}>
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
      </SubPanel>

      {editing && (
        <RuleDialog
          key={editing === 'new' ? 'new' : editing.id + ':' + editing.revision}
          rule={editing === 'new' ? null : editing}
          open
          onOpenChange={next => !next && setEditing(null)}
        />
      )}
      <RuleDrawer
        rule={openRule}
        missing={!!rules.data && !openRule}
        open={!!open}
        onOpenChange={next => !next && setParams({rule: null})}
        onEdit={rule => setEditing(rule)}
      />
    </>
  );
}
