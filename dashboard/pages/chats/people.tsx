/**
 * "Members here" in one group: you always, then each member Telegram or a switch puts in this group, read-only. Every
 * switch lives on the Members page, so each name links there; someone seen here who isn't a member has "Make member",
 * which opens the add flow with them (step 3).
 */
import {UserPlus} from 'lucide-react';
import {refreshResources} from '../../lib/resource';
import {href} from '../../lib/routes';
import {isOn, type Chat} from '../../lib/chats-model';
import {Badge, Button, Card, CardBody, CardHeader, LoadError, LoadingRows} from '../../ui/core';
import {addMemberHref, memberHref, useKnownPeople, useMembers} from '../members/hooks';
import {byName, inGroup, memberHere, personMeta, personName} from '../members/model';
import type {Telegram} from './shared';

export function MembersHere({group: chat, telegram}: {group: Chat; telegram: Telegram}) {
  const list = useMembers();
  const known = useKnownPeople();
  const group = chat.space_id;
  const on = isOn(chat);
  const owner = telegram.ownerAccount;
  const here = inGroup(list.data, group);
  const members = here.members.sort(byName(known));
  const people = here.people.sort(byName(known));
  const talking = members.filter(member => memberHere(member, group)?.label === 'Can talk here').length;

  return (
    <Card>
      <CardHeader
        title="Members here"
        description={
          on
            ? talking
              ? `You and ${talking} ${talking === 1 ? 'member' : 'members'} can talk to Nocheh here.`
              : 'Only you can talk to Nocheh here, so far.'
            : 'Nocheh is off in this group, so nobody talks to it here until you turn it on.'
        }
        action={
          <a href={href('members')} className="text-[13px] font-medium text-accent-text hover:underline">
            Members page
          </a>
        }
      />
      <CardBody className="pt-3">
        {list.error && !list.data ? (
          <LoadError what="members" onRetry={() => void refreshResources()} />
        ) : !list.data ? (
          <LoadingRows rows={2} />
        ) : (
          <>
            <ul aria-label="Members here" className="divide-y divide-line rounded-lg border border-line">
              <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" dir="auto">
                    {(owner && known.get(owner)?.name) || 'You'}
                  </p>
                  {owner && <p className="text-xs text-muted">ID {owner}</p>}
                </div>
                <Badge tone="good">You · always</Badge>
              </li>
              {members.map(member => {
                const status = memberHere(member, group)!;
                const meta = personMeta(member, known);
                return (
                  <li key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <a
                        href={memberHref(member.id)}
                        className="block truncate text-sm font-medium text-accent-text hover:underline"
                        dir="auto"
                      >
                        {personName(member, known)}
                      </a>
                      {meta && <p className="text-xs text-muted">{meta}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {status.group.new && <Badge tone="info">New here</Badge>}
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
            {!members.length && <p className="mt-3 text-[13px] text-muted">No members here yet.</p>}
            {people.length > 0 && (
              <>
                <h3 className="mt-5 text-[13px] font-medium">Seen here, not members</h3>
                <ul
                  aria-label="Seen here, not members"
                  className="mt-2 divide-y divide-line rounded-lg border border-line"
                >
                  {people.map(person => {
                    const name = personName(person, known);
                    const meta = personMeta(person, known);
                    return (
                      <li key={person.account_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium" dir="auto">
                            {name}
                          </p>
                          {meta && <p className="text-xs text-muted">{meta}</p>}
                        </div>
                        <Button asChild size="sm">
                          <a href={addMemberHref(person.account_id)} aria-label={'Make ' + name + ' a member'}>
                            <UserPlus aria-hidden /> Make member
                          </a>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {!people.length && !members.length && (
              <p className="mt-1 text-[13px] text-muted">
                People show here once Nocheh sees them write in this group. You can also add a member by their Telegram
                user ID on the Members page.
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
