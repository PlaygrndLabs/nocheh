/** Create or edit a sharing rule: which chats' facts may be used in which chat. */
import {useState} from 'react';
import {Button, Field, Input, Segmented, Switch, Textarea} from '../../ui/core';
import {Dialog} from '../../ui/overlay';
import {groupSpace} from '../../lib/chats-model';
import {ChatPicker} from './chat-picker';
import {ActionError, useAction} from './shared';

export type Rule = {
  id: string;
  name: string;
  sources: string[];
  destination: string;
  enabled: boolean;
  mode: 'approved' | 'filtered';
  instructions: string;
  revision: number;
  /** Set when a project that shares owns this rule; it changes only from the project. */
  project_id?: string | null;
  /** Private chats an older rule still names. Nocheh skips them: only groups and topics share. */
  private_sources?: string[];
};

/** Shown wherever the owner turns on, or sees, a project whose chats share what they know. */
export const projectSharingWarning = 'Everyone allowed in any of these chats will see what the others know.';

/** Shown wherever a chat joins a project: everyone allowed there sees and changes the project's task list (ADR-0243). */
export const projectTasksWarning = (chat: string, projects: string[]) =>
  `Everyone allowed in ${chat} will see and change every task on the ${projects.length > 1 ? 'lists' : 'list'} of ` +
  (projects.length < 2 ? (projects[0] ?? '') : projects.slice(0, -1).join(', ') + ' and ' + projects.at(-1)) +
  '.';

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
      description="A project shares memory only when you turn that on in the project."
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
