/** Create or edit a sharing rule: which chats' facts may be used in which chat. */
import {useState} from 'react';
import {Button, Field, Input, Segmented, Switch, Textarea} from '../../ui/core';
import {Dialog} from '../../ui/overlay';
import {chatName} from '../../lib/chats-model';
import {useChatDirectory} from '../../lib/chat-directory';
import {ChatPicker} from './chat-picker';
import {ActionError, useAction, useChat} from './shared';

export type Rule = {
  id: string;
  name: string;
  sources: string[];
  destination: string;
  enabled: boolean;
  mode: 'approved' | 'filtered';
  instructions: string;
  revision: number;
  /** Private chats an older rule still names. Nocheh skips them: only groups and topics share. */
  private_sources?: string[];
};

/**
 * Shown wherever a group joins a project, after the project's other groups: a project grants no access in a group,
 * but a person in two of its groups can ask for a private answer that combines them (ADR-0247).
 */
export const projectGroupsNote = 'People in two of these groups can get private answers that combine them.';
/** What "Share group chats" means for the people in a project's groups (ADR-0267). */
export const sharedChatsNote = 'Everyone in these groups, members or not, can see answers built from all of them.';
/** The note for a project's groups: shared chats while its "Share group chats" is on (the default), else private answers. */
export const projectNote = (shares: boolean | undefined) => (shares === false ? projectGroupsNote : sharedChatsNote);
/** The note where a group moves into or out of a project whose sharing is not shown. */
export const sharingProjectNote =
  'While a project shares its group chats, everyone in its groups, members or not, can see answers built from all of them.';
export const relatedGroupsHint = 'Put only related groups in one project; keep family groups out of projects.';

/** The groups already in a project, named first wherever another group joins it. */
export const otherGroupsText = (project: string, groups: string[]) =>
  groups.length
    ? `Already in ${project}: ${groups.length < 2 ? groups[0] : groups.slice(0, -1).join(', ') + ' and ' + groups.at(-1)}.`
    : `No other group is in ${project} yet.`;

/**
 * Who sees what one of the owner's rules lets into a chat: the one exception to "a group answer uses only that group".
 * Always the whole destination group, its topics included: every member reads every topic, and while topics share the
 * group's memory a rule into one topic is used in the General chat and every other topic too.
 */
export const ruleAudienceText = (group: string | null) =>
  `You and every member in ${group ?? 'the chat you share into'}, its topics included, will see what this rule lets in.`;

/**
 * Shown wherever a group joins a project: everyone in it, members or not, sees every task on the project's list, and
 * members change them where they may write tasks, whatever "Share group chats" says (ADR-0276).
 */
export const projectTasksWarning = (chat: string, projects: string[]) =>
  `Everyone in ${chat}, members or not, will see every task on the list of ` +
  (projects.length < 2 ? (projects[0] ?? '') : projects.slice(0, -1).join(', ') + ' and ' + projects.at(-1)) +
  ', whatever “Share group chats” says. Members can change them where they may write tasks.';

/**
 * Shown before a group leaves its project for none: its tasks, its topics' too, stay on that project's list, which the
 * project's chats keep seeing (ADR-0276).
 */
export const leaveTasksText = (project: string) =>
  `Its tasks, and its topics’ tasks, stay on ${project}’s list. ${project}’s chats still see them. This group no longer does.`;

/** Shown before a group moves from one project to another: its tasks, its topics' too, stay on the old project's list,
 * and the group sees the new project's list instead (ADR-0276). */
export const moveTasksText = (from: string, to: string) =>
  `Its tasks, and its topics’ tasks, stay on ${from}’s list. From now on it sees ${to}’s tasks instead.`;

/**
 * What each way of sharing does. The filter is a model that people can steer: what anyone writes in these chats, a
 * question in the receiving group or a message in a source group, can talk it into passing on more (ADR-0251).
 */
export const modeText: Record<Rule['mode'], {label: string; hint: string}> = {
  approved: {label: 'I approve each text', hint: 'You write or check the exact text before the chat can use it.'},
  filtered: {
    label: 'Filter automatically',
    hint: 'Nocheh tries to hold back private things, but people in these chats can talk it into passing more. For private talk, use “I approve each text”.',
  },
};

/** Privacy notes only steer the filter; a rule where the owner approves each text never reads them. */
const privacyNotesHint = 'Anything Nocheh shouldn’t pass on. It tries to hold these back.';
export const unusedNotesText = '(used only by Filter automatically)';

/** The body that saves a rule; also used to turn a rule on or off. */
export function ruleBody(rule: Omit<Rule, 'id' | 'revision'> & {id?: string}, revision: number) {
  return {
    ...(rule.id ? {id: rule.id} : {}),
    name: rule.name.trim(),
    sources: rule.sources,
    destination: rule.destination,
    enabled: rule.enabled,
    mode: rule.mode,
    instructions: rule.instructions,
    expected_revision: revision,
  };
}

export function RuleDialog({
  rule,
  open,
  onOpenChange,
  presetDestination,
}: {
  rule: Rule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetDestination?: string;
}) {
  const chats = useChatDirectory();
  const [name, setName] = useState(rule?.name ?? '');
  // A rule saved earlier may still name a private chat; editing it leaves that chat out (ADR-0242). What a chat is
  // comes from the chat directory, so a chat it doesn't know counts as private too. A chat it hasn't answered for yet
  // (past the first page, still being looked up) is kept, and the rule waits to be saved until it has.
  const [chosenSources, setSources] = useState<string[]>(rule?.sources ?? []);
  const [chosenDestination, setDestination] = useState(rule ? rule.destination : (presetDestination ?? ''));
  const sources = chosenSources.filter(space => !chats.notGroup(space));
  const destination = chats.notGroup(chosenDestination) ? '' : chosenDestination;
  const waiting = [...sources, destination].some(space => !chats.settled(space));
  const [mode, setMode] = useState<Rule['mode']>(rule?.mode ?? 'approved');
  const [instructions, setInstructions] = useState(rule?.instructions ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const action = useAction();
  const ready = !waiting && name.trim() && sources.length && destination;
  // A rule into a topic is named by its group, which is who sees it.
  const target = useChat(chats.parentOf(destination) ?? destination);

  const save = async () => {
    const result = await action.run(
      'save',
      '/sharing/rules',
      ruleBody({id: rule?.id, name, sources, destination, enabled, mode, instructions}, rule?.revision ?? 0),
      {success: rule ? 'Sharing rule saved.' : 'Sharing rule created.'},
    );
    if (result) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={rule ? 'Edit sharing rule' : 'New sharing rule'}
      description={ruleAudienceText(destination ? chatName(target) : null)}
      className="max-w-xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" busy={action.busy === 'save'} disabled={!ready} onClick={() => void save()}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" htmlFor="rule-name">
          <Input
            id="rule-name"
            value={name}
            maxLength={200}
            dir="auto"
            placeholder="e.g. Trip notes for the family group"
            onChange={event => setName(event.target.value)}
          />
        </Field>
        <ChatPicker
          label="Share facts from"
          value={sources}
          onChange={setSources}
          multiple
          exclude={destination ? [destination] : []}
          groupsOnly
          hint="Only these exact groups or topics. Private chats never share."
        />
        <ChatPicker
          label="Into this chat"
          value={destination ? [destination] : []}
          onChange={ids => setDestination(ids[0] ?? '')}
          exclude={sources}
          groupsOnly
          hint="Groups and topics only. Private chats never share."
        />
        <div className="space-y-1.5">
          <p className="text-[13px] font-medium">How</p>
          <Segmented
            label="How facts are shared"
            value={mode}
            options={[
              {value: 'approved', label: modeText.approved.label},
              {value: 'filtered', label: modeText.filtered.label},
            ]}
            onChange={setMode}
          />
          <p className="text-xs text-muted">{modeText[mode].hint}</p>
        </div>
        {/* Only the filter reads the notes. Hidden for a rule you approve, they are still kept and saved with it. */}
        {mode === 'filtered' && (
          <Field label="Privacy notes (optional)" htmlFor="rule-notes" hint={privacyNotesHint}>
            <Textarea
              id="rule-notes"
              value={instructions}
              maxLength={4000}
              rows={3}
              dir="auto"
              onChange={event => setInstructions(event.target.value)}
            />
          </Field>
        )}
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="rule-on" className="text-sm font-medium">
            Rule is on
          </label>
          <Switch id="rule-on" checked={enabled} onChange={setEnabled} label="Rule is on" />
        </div>
      </div>
      <ActionError text={action.error} />
    </Dialog>
  );
}
