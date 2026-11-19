/**
 * Members: the people who may talk to Nocheh in your groups and in their own private chat with it, and what each may do
 * there (steps 3 and 4). A line only the owner sees reminds them to check local laws before reading members' chats. The
 * list sits beside the open member on wide screens; on a phone the member opens full width. Every switch here saves at
 * once, so the page has no Save bar; the daily cap has its own Save. What a change answers shows at once, until the list
 * reloads with it.
 */
import {useState} from 'react';
import {Contact, Scale, UserPlus} from 'lucide-react';
import {useParam} from '../lib/navigation';
import {refreshResources} from '../lib/resource';
import {setParams} from '../lib/routes';
import {cn} from '../lib/utils';
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
      <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className={cn('space-y-5 lg:sticky lg:top-6', selected && 'hidden lg:block')}>
          <MemberList list={data} loading={!data && !list.error} selected={selected} known={known} />
          {data && <DailyMessages value={data.daily_messages} onSaved={answered} />}
        </div>
        <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
          {member ? (
            <MemberDetail key={member.id} member={member} known={known} onSaved={answered} />
          ) : (
            <Card>
              <Empty icon={Contact} title={selected && data ? 'This member isn’t here any more' : 'Choose a member'}>
                {selected && data
                  ? 'They were removed. Choose another member, or add them again.'
                  : 'See where they may talk to Nocheh, what they may do, and pause or remove them.'}
              </Empty>
            </Card>
          )}
        </div>
      </div>
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
