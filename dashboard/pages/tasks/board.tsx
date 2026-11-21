/**
 * The board: one column for each status, cards dragged between columns to
 * change status and within a column to change their order. Dropped tasks stay
 * off the board; finished ones sit in their column until archived. A column shows
 * a few cards at a time, so the board fits one screen.
 */
import * as React from 'react';
import {useState} from 'react';
import {useCommand} from '../memory/shared';
import {cn} from '../../lib/utils';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button, Dot, Select} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {TaskRow} from './row';
import type {Task, TaskSettings} from './model';

/** Cards shown in a column at once. */
const SHOWN = 4;

export function Board({
  tasks,
  settings,
  describe,
  onOpen,
}: {
  tasks: Task[];
  settings: TaskSettings;
  describe: (task: Task) => {list: string | null; group: string | null};
  onOpen: (task: Task) => void;
}) {
  const command = useCommand();
  const feedback = useFeedback();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** The page each column is on; a column not listed is on its first. */
  const [pages, setPages] = useState<Record<string, number>>({});
  const columns = settings.statuses.filter(status => status.category !== 'cancelled');
  const byStatus = (id: string) =>
    tasks
      .filter(task => task.status === id)
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  /** Move a card to a status, before another card or at the end of the column. */
  const move = async (task: Task, status: string, before: Task | null) => {
    const column = byStatus(status).filter(item => item.id !== task.id);
    const index = before ? column.findIndex(item => item.id === before.id) : column.length;
    const previous = column[index - 1]?.position;
    const next = column[index]?.position;
    const position =
      previous === undefined && next === undefined
        ? task.position
        : previous === undefined
          ? next! - 1
          : next === undefined
            ? previous + 1
            : (previous + next) / 2;
    const body: Record<string, unknown> = {expected_revision: task.revision};
    if (status !== task.status) body.status = status;
    if (position !== task.position) body.position = position;
    if (Object.keys(body).length === 1) return;
    const saved = await command.run('/tasks/' + task.id, body);
    if (saved && status !== task.status)
      feedback.toast(`Moved to ${settings.statuses.find(item => item.id === status)?.name ?? status}.`);
  };
  const dragged = tasks.find(task => task.id === dragging);
  return (
    <div className="space-y-2">
      {command.error && <p className="text-sm text-bad">{command.error}</p>}
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" aria-label="Board">
        {columns.map(status => {
          const all = byStatus(status.id);
          const last = Math.max(0, Math.ceil(all.length / SHOWN) - 1);
          const page = Math.min(pages[status.id] ?? 0, last);
          const cards = all.slice(page * SHOWN, (page + 1) * SHOWN);
          const turn = (to: number) => setPages(current => ({...current, [status.id]: to}));
          return (
            <section
              key={status.id}
              aria-label={status.name}
              className={cn(
                'flex min-w-52 flex-1 basis-0 flex-col rounded-xl border border-line bg-subtle/60 p-2 max-sm:w-72 max-sm:flex-none',
                over === status.id && 'border-accent',
              )}
              onDragOver={event => {
                if (!dragging) return;
                event.preventDefault();
                setOver(status.id);
              }}
              onDragLeave={() => setOver(current => (current === status.id ? null : current))}
              onDrop={event => {
                event.preventDefault();
                setOver(null);
                if (dragged) void move(dragged, status.id, null);
                setDragging(null);
              }}
            >
              <h3 className="flex items-center gap-2 px-1.5 pt-1 pb-2 text-[13px] font-semibold">
                <Dot tone={status.color} />
                {status.name}
                <span className="font-normal text-muted">{all.length}</span>
              </h3>
              <ul className="flex min-h-12 flex-col gap-2" aria-label={status.name + ' tasks'}>
                {cards.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    card
                    compact
                    settings={settings}
                    {...describe(task)}
                    onOpen={() => onOpen(task)}
                    itemProps={{
                      draggable: true,
                      className: cn('cursor-grab', dragging === task.id && 'opacity-50'),
                      onDragStart: event => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', task.id);
                        setDragging(task.id);
                      },
                      onDragEnd: () => {
                        setDragging(null);
                        setOver(null);
                      },
                      onDragOver: event => {
                        if (dragging && dragging !== task.id) event.preventDefault();
                      },
                      onDrop: event => {
                        event.preventDefault();
                        event.stopPropagation();
                        setOver(null);
                        if (dragged && dragged.id !== task.id) void move(dragged, status.id, task);
                        setDragging(null);
                      },
                    }}
                    footer={
                      <Select
                        aria-label={`Status of “${task.title}”`}
                        value={task.status}
                        className="mt-1.5 h-7 text-xs"
                        disabled={command.busy}
                        onChange={event => void move(task, event.target.value, null)}
                      >
                        {settings.statuses.map(option => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    }
                  />
                ))}
              </ul>
              {last > 0 && (
                <div className="mt-2 flex items-center justify-between gap-2 px-1 text-xs text-muted">
                  <span>
                    {page * SHOWN + 1}–{page * SHOWN + cards.length} of {all.length}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Previous ${status.name} tasks`}
                      disabled={page === 0}
                      onClick={() => turn(page - 1)}
                    >
                      <ChevronLeft aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Next ${status.name} tasks`}
                      disabled={page === last}
                      onClick={() => turn(page + 1)}
                    >
                      <ChevronRight aria-hidden />
                    </Button>
                  </span>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
