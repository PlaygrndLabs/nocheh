/**
 * Settings › Tasks: the statuses tasks move through, the names of the five
 * priorities, the owner's own columns, and the time zone task times and
 * reminders mean. Saved with the Save button at the top, like other settings.
 */
import {useState} from 'react';
import {ArrowDown, ArrowUp, Plus, Trash2, X} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {Button, Card, CardHeader, Dot, Input, LoadError, LoadingRows, Select, type Tone} from '../../ui/core';
import {errorWords} from '../memory/shared';
import type {PropertyType, StatusCategory, TaskSettings} from '../tasks/model';

type Saved = TaskSettings & {revision: string};
const colors: {value: Tone; label: string}[] = [
  {value: 'neutral', label: 'Gray'},
  {value: 'info', label: 'Blue'},
  {value: 'accent', label: 'Teal'},
  {value: 'good', label: 'Green'},
  {value: 'warn', label: 'Yellow'},
  {value: 'bad', label: 'Red'},
];
const kinds: {value: StatusCategory; label: string}[] = [
  {value: 'not_started', label: 'Not started'},
  {value: 'active', label: 'In progress'},
  {value: 'done', label: 'Done'},
  {value: 'cancelled', label: 'Dropped'},
];
const types: {value: PropertyType; label: string}[] = [
  {value: 'text', label: 'Text'},
  {value: 'number', label: 'Number'},
  {value: 'select', label: 'Choice'},
  {value: 'multi_select', label: 'Several choices'},
  {value: 'date', label: 'Date'},
  {value: 'checkbox', label: 'Checkbox'},
  {value: 'url', label: 'Link'},
  {value: 'person', label: 'People'},
];
const levels = ['Level 0', 'Level 1', 'Level 2', 'Level 3', 'Level 4'];

/** A short, stable ID for something new, from its name where it has Latin letters. */
function newId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'item';
  let id = base;
  while (taken.includes(id)) id = base + '-' + Math.random().toString(36).slice(2, 6);
  return id;
}

function zones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch {
    return ['UTC'];
  }
}

export function TaskSettingsPanel() {
  const saved = useResource<Saved>('/tasks/settings');
  const [draft, setDraft] = useState<TaskSettings | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const data = saved.data;
  const value = draft ?? data ?? null;
  const edit = (next: TaskSettings) => {
    setRevision(current => current ?? data?.revision ?? null);
    setDraft(next);
  };
  const reset = () => {
    setDraft(null);
    setRevision(null);
  };
  const dirty =
    !!draft &&
    !!data &&
    JSON.stringify({
      statuses: draft.statuses,
      priorities: draft.priorities,
      properties: draft.properties,
      time_zone: draft.time_zone,
    }) !==
      JSON.stringify({
        statuses: data.statuses,
        priorities: data.priorities,
        properties: data.properties,
        time_zone: data.time_zone,
      });
  useDraftSource({
    id: 'task-settings',
    labels: dirty ? ['Tasks: statuses, priorities and columns'] : [],
    save: async () => {
      if (!draft) return;
      if ([...draft.statuses, ...draft.properties].some(item => !item.name.trim()))
        throw new Error('Give every status and column a name, then save again.');
      try {
        await apiPost('/tasks/settings', {
          revision: revision ?? data?.revision,
          statuses: draft.statuses.map(item => ({...item, name: item.name.trim()})),
          priorities: draft.priorities.map(item => ({...item, name: item.name.trim()})),
          properties: draft.properties.map(item => ({
            ...item,
            name: item.name.trim(),
            options: item.options
              .filter(option => option.name.trim())
              .map(option => ({...option, name: option.name.trim()})),
          })),
          time_zone: draft.time_zone,
        });
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /conflict|changed/.test((e as ApiError)?.message ?? '')
            ? 'Task settings were changed somewhere else. Your edits are kept; check them and save again.'
            : errorWords(e),
        );
      }
    },
    discard: reset,
  });
  if (saved.error && !data) return <LoadError what="task settings" onRetry={() => void refreshResources()} />;
  if (!value)
    return (
      <Card>
        <LoadingRows rows={4} />
      </Card>
    );
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allZones = zones();
  const statusIds = value.statuses.map(item => item.id);
  const move = <T,>(items: T[], index: number, by: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    return next;
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Statuses"
          description="The steps a task goes through, in board order. Each belongs to one kind: not started, in progress, done or dropped. Removing a status moves its tasks to the first status of the same kind."
        />
        <ul className="mt-3 divide-y divide-line border-t border-line" aria-label="Statuses">
          {value.statuses.map((status, index) => (
            <li key={status.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
              <Dot tone={status.color} />
              <Input
                aria-label={'Status name ' + (index + 1)}
                value={status.name}
                maxLength={40}
                className="w-44"
                dir="auto"
                onChange={event =>
                  edit({
                    ...value,
                    statuses: value.statuses.map((item, at) =>
                      at === index ? {...item, name: event.target.value} : item,
                    ),
                  })
                }
              />
              <Select
                aria-label={'Kind of ' + (status.name || 'status')}
                value={status.category}
                className="w-36"
                onChange={event =>
                  edit({
                    ...value,
                    statuses: value.statuses.map((item, at) =>
                      at === index ? {...item, category: event.target.value as StatusCategory} : item,
                    ),
                  })
                }
              >
                {kinds.map(kind => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={'Color of ' + (status.name || 'status')}
                value={status.color}
                className="w-28"
                onChange={event =>
                  edit({
                    ...value,
                    statuses: value.statuses.map((item, at) =>
                      at === index ? {...item, color: event.target.value as Tone} : item,
                    ),
                  })
                }
              >
                {colors.map(color => (
                  <option key={color.value} value={color.value}>
                    {color.label}
                  </option>
                ))}
              </Select>
              <span className="ml-auto flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={'Move ' + status.name + ' up'}
                  disabled={!index}
                  onClick={() => edit({...value, statuses: move(value.statuses, index, -1)})}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={'Move ' + status.name + ' down'}
                  disabled={index === value.statuses.length - 1}
                  onClick={() => edit({...value, statuses: move(value.statuses, index, 1)})}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={'Remove ' + status.name}
                  disabled={value.statuses.filter(item => item.category === status.category).length < 2}
                  title={
                    value.statuses.filter(item => item.category === status.category).length < 2
                      ? 'Each kind keeps at least one status.'
                      : undefined
                  }
                  onClick={() => edit({...value, statuses: value.statuses.filter((_, at) => at !== index)})}
                >
                  <Trash2 aria-hidden />
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <div className="border-t border-line px-5 py-3">
          <Button
            size="sm"
            disabled={value.statuses.length >= 20}
            onClick={() =>
              edit({
                ...value,
                statuses: [
                  ...value.statuses,
                  {id: newId('status', statusIds), name: '', category: 'active', color: 'info'},
                ],
              })
            }
          >
            <Plus aria-hidden /> Add status
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Priorities"
          description="Five levels, from level 0 (none) to level 4 (most urgent). Name them as you like."
        />
        <ul className="mt-3 divide-y divide-line border-t border-line" aria-label="Priorities">
          {value.priorities.map((priority, index) => (
            <li key={priority.level} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
              <span className="w-20 text-xs text-muted">{levels[priority.level]}</span>
              <Dot tone={priority.color} />
              <Input
                aria-label={'Priority name ' + levels[priority.level]}
                value={priority.name}
                maxLength={40}
                className="w-44"
                dir="auto"
                onChange={event =>
                  edit({
                    ...value,
                    priorities: value.priorities.map((item, at) =>
                      at === index ? {...item, name: event.target.value} : item,
                    ),
                  })
                }
              />
              <Select
                aria-label={'Color of ' + (priority.name || 'priority')}
                value={priority.color}
                className="w-28"
                onChange={event =>
                  edit({
                    ...value,
                    priorities: value.priorities.map((item, at) =>
                      at === index ? {...item, color: event.target.value as Tone} : item,
                    ),
                  })
                }
              >
                {colors.map(color => (
                  <option key={color.value} value={color.value}>
                    {color.label}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Your columns"
          description="Extra fields every task can have, like a column in a Notion table: text, a number, choices, a date, a checkbox, a link or people. Removing a column, or one of its choices, clears it from tasks."
        />
        {!!value.properties.length && (
          <ul className="mt-3 divide-y divide-line border-t border-line" aria-label="Your columns">
            {value.properties.map((property, index) => {
              const change = (patch: Partial<TaskSettings['properties'][number]>) =>
                edit({
                  ...value,
                  properties: value.properties.map((item, at) => (at === index ? {...item, ...patch} : item)),
                });
              const choices = property.type === 'select' || property.type === 'multi_select';
              return (
                <li key={property.id} className="space-y-2 px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={'Column name ' + (index + 1)}
                      value={property.name}
                      maxLength={40}
                      className="w-44"
                      dir="auto"
                      onChange={event => change({name: event.target.value})}
                    />
                    <Select
                      aria-label={'Type of ' + (property.name || 'column')}
                      value={property.type}
                      className="w-40"
                      onChange={event => {
                        const type = event.target.value as PropertyType;
                        change({type, options: type === 'select' || type === 'multi_select' ? property.options : []});
                      }}
                    >
                      {types.map(type => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label={'Remove column ' + property.name}
                      onClick={() => edit({...value, properties: value.properties.filter((_, at) => at !== index)})}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  {choices && (
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      role="group"
                      aria-label={'Choices of ' + property.name}
                    >
                      {property.options.map((option, at) => (
                        <span
                          key={option.id}
                          className="inline-flex items-center gap-1 rounded-md border border-line py-0.5 pr-0.5 pl-1.5"
                        >
                          <Input
                            aria-label={'Choice ' + (at + 1)}
                            value={option.name}
                            maxLength={40}
                            className="h-7 w-28 border-0 px-1 text-xs"
                            dir="auto"
                            onChange={event =>
                              change({
                                options: property.options.map((item, i) =>
                                  i === at ? {...item, name: event.target.value} : item,
                                ),
                              })
                            }
                          />
                          <button
                            type="button"
                            aria-label={'Remove choice ' + option.name}
                            className="rounded p-0.5 text-muted hover:bg-subtle hover:text-fg"
                            onClick={() => change({options: property.options.filter((_, i) => i !== at)})}
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ))}
                      <Button
                        size="sm"
                        disabled={property.options.length >= 50}
                        onClick={() =>
                          change({
                            options: [
                              ...property.options,
                              {
                                id: newId(
                                  'choice',
                                  property.options.map(item => item.id),
                                ),
                                name: '',
                                color: 'neutral',
                              },
                            ],
                          })
                        }
                      >
                        <Plus aria-hidden /> Add choice
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 border-t border-line px-5 py-3">
          <Button
            size="sm"
            disabled={value.properties.length >= 30}
            onClick={() =>
              edit({
                ...value,
                properties: [
                  ...value.properties,
                  {
                    id: newId(
                      'column',
                      value.properties.map(item => item.id),
                    ),
                    name: '',
                    type: 'text',
                    options: [],
                  },
                ],
              })
            }
          >
            <Plus aria-hidden /> Add column
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Time zone"
          description="Task times, Today and Upcoming, and reminders follow this time zone, in the dashboard and in chat."
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          <Select
            aria-label="Time zone"
            value={value.time_zone}
            className="w-64"
            onChange={event => edit({...value, time_zone: event.target.value})}
          >
            {[...new Set(['UTC', value.time_zone, ...allZones])].map(zone => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          {device && device !== value.time_zone && (
            <Button size="sm" onClick={() => edit({...value, time_zone: device})}>
              Use this device’s ({device.replace(/_/g, ' ')})
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
