/**
 * Members: the people who may talk to Nocheh in your groups and in their own private chat with it, and what each may do
 * there (steps 3 and 4). A line only the owner sees reminds them to check local laws before reading members' chats. The
 * members are a table; a member opens in its place, with the way back and to any other member. Every switch here saves at
 * once, so the page has no Save bar; the daily cap has its own Save. What a change answers shows at once, until the list
 * reloads with it.
 */
import {useState} from 'react';
import {Contact, Scale, UserPlus} from 'lucide-react';
import {useParam} from '../lib/navigation';
import {refreshResources} from '../lib/resource';
import {setParams} from '../lib/routes';
import {Button, Card, Empty, LoadError} from '../ui/core';
import {Page} from '../ui/page';
import {AddMember} from './members/add';
import {MemberDetail} from './members/detail';
import {useKnownPeople, useLocalLaws, useMembers} from './members/hooks';
import {DailyMessages, MemberList} from './members/list';
import {withAnswers, type MemberAnswer} from './members/model';

export default function MembersPage() {
  const list = useMembers();
  const known = useKnownPeople();
  const laws = useLocalLaws();
  const selected = useParam('member');
  const adding = useParam('add');
  const [answers, setAnswers] = useState<MemberAnswer[]>([]);
  const data = withAnswers(list.data, answers);
  const answered = (answer: MemberAnswer) =>
    setAnswers(current => [...current.filter(item => item.revision > (list.data?.revision ?? -1)), answer]);
  const member = selected ? (data?.members.find(item => item.id === selected) ?? null) : null;
  return (
    <Page
      title="Members"
      description="People who may talk to Nocheh in your groups and in their private chat with it, and what each may do there. Switches save at once; the daily cap has its own Save."
      actions={
        <Button variant="primary" disabled={!data} onClick={() => setParams({add: 'new'})}>
          <UserPlus aria-hidden /> Add member
        </Button>
      }
    >
      {laws && (
        <p className="mb-5 flex items-start gap-2 text-[13px] text-muted" data-testid="members-local-laws">
          <Scale className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{laws}</span>
        </p>
      )}
      {list.error && !data && <LoadError what="members" onRetry={() => void refreshResources()} />}
      {selected ? (
        member ? (
          <MemberDetail
            key={member.id}
            member={member}
            members={data?.members ?? []}
            known={known}
            onSaved={answered}
          />
        ) : (
          data && (
            <Card>
              <Empty icon={Contact} title="This member isn’t here any more">
                They were removed. Choose another member, or add them again.
                <span className="mt-3 block">
                  <Button size="sm" onClick={() => setParams({member: null, tab: null})}>
                    All members
                  </Button>
                </span>
              </Empty>
            </Card>
          )
        )
      ) : (
        <div className="space-y-5">
          <MemberList list={data} loading={!data && !list.error} known={known} />
          {data && <DailyMessages value={data.daily_messages} onSaved={answered} />}
        </div>
      )}
      {adding && data && (
        <AddMember
          list={data}
          known={known}
          person={adding === 'new' ? null : adding}
          onClose={() => setParams({add: null})}
          onSaved={answered}
        />
      )}
    </Page>
  );
}
