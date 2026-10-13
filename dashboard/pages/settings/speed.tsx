import {useSettings} from '../../lib/settings';
import {Card, CardHeader, Notice, Select, SettingRow} from '../../ui/core';
import {Unsaved} from './telegram';

export const speedKeys = ['NOCHEH_PARALLEL_REPLIES', 'NOCHEH_PARALLEL_RUNS', 'NOCHEH_PARALLEL_GUARD_CHECKS'];

const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => String(from + i));

export function SpeedSettings() {
  const s = useSettings();
  const runs = Number(s.value('NOCHEH_PARALLEL_RUNS')) || 4;
  const replies = Number(s.value('NOCHEH_PARALLEL_REPLIES')) || 3;
  const rows: {key: string; title: string; description: string; options: string[]}[] = [
    {
      key: 'NOCHEH_PARALLEL_REPLIES',
      title: 'Chats answered at once',
      description: 'Different chats answered at the same time. Messages in one chat are always answered in order.',
      options: range(1, Math.max(runs, replies)),
    },
    {
      key: 'NOCHEH_PARALLEL_RUNS',
      title: 'Assistant runs at once',
      description: 'Shared by replies, memory reviews and scheduled jobs. Each run can use up to 2 GB of memory.',
      options: range(1, 8),
    },
    {
      key: 'NOCHEH_PARALLEL_GUARD_CHECKS',
      title: 'Secret checks at once',
      description: 'Every message is checked before it’s answered. Each check is one model call.',
      options: range(1, 4),
    },
  ];
  return (
    <>
      {replies > runs && (
        <Notice tone="warn" title="Too many chats at once">
          Chats answered at once can’t be more than assistant runs at once. Lower it or raise the runs.
        </Notice>
      )}
      <Card>
        <CardHeader
          title="Speed"
          description="How much Nocheh does at the same time. Higher is faster but uses more memory and model calls."
          className="pb-3"
        />
        <div className="border-t border-line">
          {rows.map(row => (
            <SettingRow
              key={row.key}
              htmlFor={row.key}
              title={
                <>
                  {row.title}
                  <Unsaved show={s.changed(row.key)} />
                </>
              }
              description={row.description}
            >
              <Select
                id={row.key}
                value={s.value(row.key)}
                disabled={s.busy}
                onChange={e => s.set(row.key, e.target.value)}
              >
                {row.options.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </SettingRow>
          ))}
        </div>
      </Card>
    </>
  );
}
