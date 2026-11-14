/** Create or edit a sharing rule: which chats' facts may be used in which chat. */
import {useState} from 'react';
import {Button, Field, Input, Segmented, Switch, Textarea} from '../../ui/core';
import {Dialog} from '../../ui/overlay';
import {chatName, groupSpace, parentOf} from '../../lib/chats-model';
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
  `Everyone allowed in ${group ?? 'the chat you share into'}, its topics included, will see what this rule lets in.`;

/**
 * Shown wherever a group joins a project: everyone allowed there sees and changes the tasks set on the whole project,
 * never another group's own tasks (ADR-0243, ADR-0248).
 */
export const projectTasksWarning = (chat: string, projects: string[]) =>
  `Everyone allowed in ${chat} will see and change the tasks set on the whole of ` +
  (projects.length < 2 ? (projects[0] ?? '') : projects.slice(0, -1).join(', ') + ' and ' + projects.at(-1)) +
  ', never another group’s own tasks.';

/**
 * Shown before a group leaves its project for none: its tasks, its topics' too, stay on that project's list, where
 * only the owner sees them (ADR-0248).
 */
export const leaveTasksText = (project: string) =>
  `Its tasks, and its topics’ tasks, stay on ${project}’s list, where only you see them.`;

/** Shown before a group moves from one project to another: its tasks, its topics' too, move with it (ADR-0248). */
export const moveTasksText = (from: string, to: string) =>
  `Its tasks, and its topics’ tasks, move with it from ${from} to ${to}.`;

export const modeText: Record<Rule['mode'], {label: string; hint: string}> = {
  approved: {label: 'I approve each text', hint: 'You write or check the exact text before the chat can use it.'},
  filtered: {
    label: 'Filter automatically',
    hint: 'Nocheh passes on what’s relevant and holds back anything private or uncertain.',
  },
};

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
  owner,
  presetDestination,
}: {
  rule: Rule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner?: string;
  presetDestination?: string;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  // A rule saved earlier may still name a private chat; editing it leaves that chat out (ADR-0242).
  const [sources, setSources] = useState<string[]>((rule?.sources ?? []).filter(groupSpace));
  const [destination, setDestination] = useState(
    rule ? (groupSpace(rule.destination) ? rule.destination : '') : (presetDestination ?? ''),
  );
  const [mode, setMode] = useState<Rule['mode']>(rule?.mode ?? 'approved');
  const [instructions, setInstructions] = useState(rule?.instructions ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const action = useAction();
  const ready = name.trim() && sources.length && destination;
  // A rule into a topic is named by its group, which is who sees it.
  const target = useChat(parentOf(destination) ?? destination);

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
      description={ruleAudienceText(destination && groupSpace(destination) ? chatName(target) : null)}
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
          owner={owner}
          exclude={destination ? [destination] : []}
          groupsOnly
          hint="Only these exact groups or topics. Private chats never share."
        />
        <ChatPicker
          label="Into this chat"
          value={destination ? [destination] : []}
          onChange={ids => setDestination(ids[0] ?? '')}
          owner={owner}
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
        <Field label="Privacy notes (optional)" htmlFor="rule-notes" hint="Anything Nocheh must never pass on.">
          <Textarea
            id="rule-notes"
            value={instructions}
            maxLength={4000}
            rows={3}
            dir="auto"
            onChange={event => setInstructions(event.target.value)}
          />
        </Field>
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
