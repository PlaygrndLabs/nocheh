/** The Groups tab: each group the member is in now and Nocheh serves, by its Telegram title, and its task board. */
import {ChevronRight, UsersRound} from 'lucide-react';
import type {MemberMe} from '../../src/member-app-wire';
import {Card} from '../ui/core';
import {useWords} from './shared';

export function MemberGroups({me, onOpen}: {me: MemberMe; onOpen: (project: string, group: string) => void}) {
  const {t} = useWords();
  const projectName = (id: string | null) => me.projects.find(project => project.id === id)?.name ?? '';
  return (
    <section className="mx-auto max-w-2xl space-y-3 p-4">
      <h1 className="text-xl font-semibold">{t('tab_groups')}</h1>
      {!me.groups.length ? (
        <p className="text-sm text-muted">{t('groups_none')}</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line" aria-label={t('tab_groups')}>
            {me.groups.map(group => {
              const title = group.title?.trim() || t('unnamed_group');
              const open = group.board === 'open' && !!group.project;
              const count = group.open_count ?? 0;
              const line =
                group.board === 'none'
                  ? t('board_none')
                  : group.board === 'closed'
                    ? t('board_closed')
                    : [
                        projectName(group.project),
                        count === 0
                          ? t('open_count_zero')
                          : count === 1
                            ? t('open_count_one')
                            : t('open_count_many', {count}),
                      ]
                        .filter(Boolean)
                        .join(' · ');
              const content = (
                <>
                  <UsersRound className="size-5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" dir="auto">
                      {title}
                    </span>
                    <span className="block text-[13px] text-muted" dir="auto">
                      {line}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={group.id}>
                  {open ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-subtle"
                      onClick={() => onOpen(group.project!, group.id)}
                    >
                      {content}
                      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
