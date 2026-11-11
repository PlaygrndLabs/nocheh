/**
 * "Tools": which of Nocheh's tools a chat may use: commands, web pages and outside tools, Notion included.
 * Nocheh keeps these switches itself and checks them when a tool is asked for and again right before it runs.
 * Each switch on its own: a topic follows its group, a chat the tools in every chat, and those are on unless
 * the owner turns them off.
 */
import {useState} from 'react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {Card, CardHeader, LoadError, LoadingRows, Segmented, SettingRow} from '../../ui/core';

type Tool = 'shell' | 'browser' | 'mcp';
type Origin = 'default' | 'every_chat' | 'chat' | 'topic';
type Choice = 'default' | 'on' | 'off';
export type ChatTools = {
  space: string;
  revision: number;
  own: Record<Tool, boolean | null>;
  values: Record<Tool, boolean>;
  origins: Record<Tool, Origin>;
};

export const toolNames: [Tool, string, string][] = [
  ['shell', 'Commands', 'Run a bounded command in a sealed workspace. No network.'],
  ['browser', 'Web pages', 'Read an approved public page. No logins.'],
  ['mcp', 'Outside tools', 'Propose an exact call to a public tool server, including Notion.'],
];
const choices: {value: Choice; label: string}[] = [
  {value: 'default', label: 'Default'},
  {value: 'on', label: 'On'},
  {value: 'off', label: 'Off'},
];
const choiceOf = (value: boolean | null): Choice => (value === null ? 'default' : value ? 'on' : 'off');
const valueOf = (choice: Choice): boolean | null => (choice === 'default' ? null : choice === 'on');

/** Where a switch's default comes from, seen from `space`. */
export function toolOrigin(origin: Origin, space: string): string {
  if (origin === 'every_chat') return 'set for every chat';
  if (origin === 'chat') return space.includes('/topic/') ? 'set for the group' : 'set for this chat';
  if (origin === 'topic') return 'set for this topic';
  return 'built in';
}

/** The space a switch falls back to: a topic's group, a chat's every-chat row, nothing for every chat. */
export const toolParent = (space: string): string | null =>
  space === '*' ? null : space.includes('/topic/') ? space.split('/topic/')[0]! : '*';

export function ToolSwitches({
  space,
  title,
  description,
  where,
}: {
  space: string;
  title: string;
  description: string;
  where: string;
}) {
  const parentSpace = toolParent(space);
  const own = useResource<ChatTools>('/chat-tools?space=' + encodeURIComponent(space));
  const parent = useResource<ChatTools>(parentSpace ? '/chat-tools?space=' + encodeURIComponent(parentSpace) : null);
  const data = own.data && own.data.space === space ? own.data : null;
  const inherited = parent.data && parent.data.space === parentSpace ? parent.data : null;
  const [changes, setChanges] = useState<Partial<Record<Tool, boolean | null>>>({});
  const [revision, setRevision] = useState<number | null>(null);
  const reset = () => {
    setChanges({});
    setRevision(null);
  };
  const edit = (tool: Tool, choice: Choice) => {
    setRevision(current => current ?? data?.revision ?? null);
    setChanges(current => {
      const next = {...current};
      if (data && valueOf(choice) === data.own[tool]) delete next[tool];
      else next[tool] = valueOf(choice);
      return next;
    });
  };

  useDraftSource({
    id: 'chat-tools:' + space,
    labels: toolNames.filter(([tool]) => changes[tool] !== undefined).map(([, name]) => name + ' (' + where + ')'),
    save: async () => {
      try {
        await apiPost('/chat-tools', {space, changes, expected_revision: revision ?? data?.revision});
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /changed|conflict/.test((e as ApiError)?.message ?? '')
            ? 'The tools for ' + where + ' were changed somewhere else. Your edits are kept; check them and save again.'
            : 'Couldn’t save the tools for ' + where + '.',
        );
      }
    },
    discard: reset,
  });

  const failed = (own.error && !data) || (parentSpace && parent.error && !inherited);
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="mt-3 border-t border-line">
        {failed ? (
          <LoadError what="the tools" className="m-5" />
        ) : !data || (parentSpace && !inherited) ? (
          <LoadingRows rows={3} />
        ) : (
          toolNames.map(([tool, name, hint]) => {
            const draft = changes[tool];
            const fallback = inherited ? inherited.values[tool] : true;
            const from = inherited ? toolOrigin(inherited.origins[tool], space) : 'built in';
            return (
              <SettingRow key={tool} title={name} description={hint}>
                <div className="space-y-1.5">
                  <Segmented
                    label={name + ' in ' + where}
                    value={choiceOf(draft === undefined ? data.own[tool] : draft)}
                    options={choices}
                    onChange={choice => edit(tool, choice)}
                  />
                  <p className="text-xs text-muted">
                    Default: {fallback ? 'on' : 'off'}, {from}.
                  </p>
                </div>
              </SettingRow>
            );
          })
        )}
      </div>
    </Card>
  );
}
