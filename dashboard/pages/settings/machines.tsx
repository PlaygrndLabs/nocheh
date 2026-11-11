/**
 * Settings › Machines: the owner's own machines that background jobs may work on over SSH, after
 * one Approve on the job's plan card. Nocheh makes each machine's key and keeps it; the page shows
 * only the public key to put on the machine. Test trusts the machine's host key on its first
 * success. Every control acts at once; turning things off, removing and moving a machine ask first.
 */
import {useState} from 'react';
import {Copy, KeyRound, Pencil, Plus, PlugZap, ScrollText, Server, Trash2} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {
  addressHint,
  endpoint,
  localAddress,
  localHint,
  machineAdvice,
  machineBody,
  machineDraft,
  machineEdit,
  machineErrorWords,
  machineProblems,
  machineStatus,
  setupLine,
  type Machine,
  type MachineDraft,
  type Machines,
  type MachineTest,
} from '../../lib/machines';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {ago, dateTime} from '../../lib/system-format';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  SettingRow,
  Switch,
  Textarea,
} from '../../ui/core';
import {LinkButton} from '../../ui/link-button';
import {Dialog, useFeedback} from '../../ui/overlay';

const loginHint =
  'Use a separate login for Nocheh, with bash as its shell, because Stop ends every program it runs. Install ps (procps) on the machine so Stop can do that.';
const offText =
  'Cards waiting for your approval are withdrawn. Running machine jobs stop, and every program their login runs on the machine is ended.';
const removeText = (machine: Machine) =>
  `Nocheh deletes its key for ${machine.name}. Cards waiting for your approval are withdrawn, and running jobs on it stop and their programs there end. The machine log keeps its commands. Remove the key line from ~${machine.login}/.ssh/authorized_keys on the machine too.`;
const jobsText = (machine: Machine) =>
  machine.jobs > 0 ? `${machine.jobs === 1 ? 'A job works' : `${machine.jobs} jobs work`} on it. ` : '';
const moveText = (machine: Machine) =>
  `${jobsText(machine)}Nocheh forgets the host key it trusts for ${machine.name}. Jobs running on it stop, and cards waiting for your approval are withdrawn. Then press Test, so Nocheh trusts the machine again. Its key stays the same.`;
const trustText =
  'Do this only when you know the machine changed, for example after you reinstalled it. Nocheh forgets the host key it trusts now, and the next Test trusts the key the machine shows then. Jobs on it stop, and cards waiting for your approval are withdrawn.';

/** Copies text; false when the browser does not allow it, such as on a plain http address. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A public key to select and copy by hand. */
function PublicKey({value, label}: {value: string; label: string}) {
  return (
    <Textarea
      readOnly
      aria-label={label}
      rows={3}
      value={value}
      className="min-h-0 resize-none font-mono text-xs break-all"
      onFocus={event => event.currentTarget.select()}
      onClick={event => event.currentTarget.select()}
    />
  );
}

/** A problem and what to do, under the action that failed. */
const failure = (code: string, login: string) => `${machineErrorWords(code)}. ${machineAdvice(code, login)}`;

export function MachineSettings() {
  const status = useResource<Machines>('/machines', 10000);
  const feedback = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The machine whose key the browser would not copy: its key is shown to copy by hand.
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Machine | null>(null);

  // A problem names the machine it is about, with what to do next.
  const fail = (code: string, machine?: Machine) =>
    setProblem((machine ? machine.name + ': ' : '') + failure(code, machine?.login ?? 'nocheh'));
  const act = async (name: string, work: () => Promise<void>, machine?: Machine) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      fail((e as Error)?.message ?? '', machine);
    } finally {
      setBusy(current => (current === name ? null : current));
      await refreshResources().catch(() => {});
    }
  };
  const setEnabled = async (enabled: boolean) => {
    if (!status.data) return;
    if (
      !enabled &&
      !(await feedback.confirm({title: 'Turn off machine control?', body: offText, confirm: 'Turn off', danger: true}))
    )
      return;
    const revision = status.data.revision;
    await act('switch', async () => {
      await apiPost('/machines/settings', {enabled, revision});
      feedback.toast(enabled ? 'Machine control is on.' : 'Machine control is off.');
    });
  };
  const setMachine = async (machine: Machine, enabled: boolean) => {
    if (
      !enabled &&
      machine.jobs > 0 &&
      !(await feedback.confirm({
        title: `Turn off ${machine.name}?`,
        body: jobsText(machine) + offText,
        confirm: 'Turn off',
        danger: true,
      }))
    )
      return;
    await act(
      'enable:' + machine.id,
      async () => {
        await apiPost('/machines/' + machine.id, {enabled, revision: machine.revision});
      },
      machine,
    );
  };
  const test = (machine: Machine) =>
    act(
      'test:' + machine.id,
      async () => {
        const {result} = await apiPost<MachineTest>(`/machines/${machine.id}/test`, {});
        if (result.ok) feedback.toast(`${machine.name} is ready${result.system ? ': ' + result.system : ''}.`);
        else fail(result.error ?? '', machine);
      },
      machine,
    );
  const copyKey = async (machine: Machine) => {
    if (await copyText(machine.public_key)) {
      setShownKey(null);
      feedback.toast(`The public key of ${machine.name} is copied.`);
    } else setShownKey(machine.id);
  };
  const trust = async (machine: Machine) => {
    if (
      !(await feedback.confirm({
        title: `Trust a new host key for ${machine.name}?`,
        body: trustText,
        confirm: 'Forget the old key',
        danger: true,
      }))
    )
      return;
    await act(
      'trust:' + machine.id,
      async () => {
        await apiPost(`/machines/${machine.id}/forget-host-key`, {});
        feedback.toast(`Press Test to trust the host key ${machine.name} shows now.`);
      },
      machine,
    );
  };
  const remove = async (machine: Machine) => {
    if (
      !(await feedback.confirm({
        title: `Remove ${machine.name}?`,
        body: removeText(machine),
        confirm: 'Remove',
        danger: true,
      }))
    )
      return;
    await act(
      'remove:' + machine.id,
      async () => {
        await apiPost(`/machines/${machine.id}/remove`, {});
        feedback.toast(`${machine.name} is removed.`);
      },
      machine,
    );
  };

  if (status.error && !status.data) return <LoadError what="your machines" onRetry={() => void refreshResources()} />;
  if (!status.data)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  const data = status.data;
  return (
    <>
      {!data.available ? (
        <Notice tone="info" title="Machine control isn’t running">
          Nocheh’s machine service isn’t set up on this computer, so no job can work on a machine. Run ./bin/nocheh up
          to start it.
        </Notice>
      ) : (
        !data.enabled && (
          <Notice tone="warn" title="Machine control is off">
            No job can work on your machines until you turn it on.
          </Notice>
        )
      )}
      <Card aria-labelledby="machines-title">
        <CardHeader
          id="machines-title"
          title="Machines"
          description="Your own machines, such as a VM, that jobs you approve can work on over SSH. Nocheh makes each machine’s key and keeps it; the assistant never sees it."
        />
        <div className="mt-3 border-t border-line">
          <SettingRow
            title="Machine control"
            htmlFor="machine-control"
            description="Off: no job can work on a machine. Cards waiting for approval are withdrawn, and running machine jobs stop and their programs end."
          >
            <div className="flex sm:justify-end">
              <Switch
                id="machine-control"
                label="Machine control"
                checked={data.enabled}
                disabled={busy === 'switch'}
                onChange={next => void setEnabled(next)}
              />
            </div>
          </SettingRow>
          {problem && (
            <div className="border-t border-line px-5 py-4">
              <Notice tone="bad">{problem}</Notice>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
            <h3 className="text-sm font-medium">Your machines</h3>
            <Button size="sm" variant="primary" disabled={!data.available} onClick={() => setAdding(true)}>
              <Plus aria-hidden /> Add machine
            </Button>
          </div>
          {!data.machines.length ? (
            <Empty icon={Server} title="No machines yet" className="border-t border-line">
              Add a machine, put its public key on it, then press Test. A job you ask for in your private chat or a
              project’s group can then work on it after you approve its plan.
            </Empty>
          ) : (
            <ul className="divide-y divide-line border-t border-line" aria-label="Machines">
              {data.machines.map(machine => (
                <MachineRow
                  key={machine.id}
                  machine={machine}
                  available={data.available}
                  busy={busy}
                  keyShown={shownKey === machine.id}
                  onEnable={next => void setMachine(machine, next)}
                  onTest={() => void test(machine)}
                  onCopy={() => void copyKey(machine)}
                  onHideKey={() => setShownKey(null)}
                  onEdit={() => setEditing(machine)}
                  onTrust={() => void trust(machine)}
                  onRemove={() => void remove(machine)}
                />
              ))}
            </ul>
          )}
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            {loginHint} Every command a job runs is in System ›{' '}
            <a className="underline" href={href('system', {view: 'machines'})}>
              Machine log
            </a>
            .
          </p>
        </div>
      </Card>
      <AddMachine open={adding} onClose={() => setAdding(false)} taken={data.machines.map(machine => machine.name)} />
      {editing && (
        <EditMachine
          key={editing.id}
          machine={data.machines.find(machine => machine.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
          taken={data.machines.filter(machine => machine.id !== editing.id).map(machine => machine.name)}
        />
      )}
    </>
  );
}

function MachineRow(props: {
  machine: Machine;
  available: boolean;
  busy: string | null;
  keyShown: boolean;
  onEnable: (enabled: boolean) => void;
  onTest: () => void;
  onCopy: () => void;
  onHideKey: () => void;
  onEdit: () => void;
  onTrust: () => void;
  onRemove: () => void;
}) {
  const {machine, available, busy, keyShown} = props;
  const state = machineStatus(machine);
  const error = state.tone === 'warn' ? machine.test_error : null;
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-all">{machine.name}</span>
            <Badge tone={state.tone} dot>
              {state.label}
            </Badge>
          </p>
          <p className="mt-0.5 font-mono text-[13px] break-all text-muted">{endpoint(machine)}</p>
          <p className="mt-1 text-xs text-muted">
            {machine.tested_at ? (
              <>
                Last good test <time title={dateTime(machine.tested_at)}>{ago(machine.tested_at)}</time>
              </>
            ) : (
              'No good test yet'
            )}
            {machine.jobs > 0 && ` · ${machine.jobs === 1 ? '1 job works' : `${machine.jobs} jobs work`} on it`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Host key:{' '}
            {machine.host_key ? (
              <span className="font-mono break-all">{machine.host_key}</span>
            ) : (
              'trusted on the first good test'
            )}
          </p>
          {error && <p className="mt-1 text-[13px] text-warn">{machineAdvice(error, machine.login)}</p>}
        </div>
        <Switch
          label={'Use ' + machine.name}
          checked={machine.enabled}
          disabled={busy === 'enable:' + machine.id}
          onChange={props.onEnable}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          busy={busy === 'test:' + machine.id}
          disabled={!available}
          onClick={props.onTest}
        >
          <PlugZap aria-hidden /> Test
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onEdit}>
          <Pencil aria-hidden /> Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCopy}>
          <Copy aria-hidden /> Copy public key
        </Button>
        {machine.host_key && (
          <Button size="sm" variant="ghost" busy={busy === 'trust:' + machine.id} onClick={props.onTrust}>
            <KeyRound aria-hidden /> Trust a new host key
          </Button>
        )}
        <LinkButton href={href('system', {view: 'machines', machine: machine.id})} variant="ghost">
          <ScrollText aria-hidden /> Log
        </LinkButton>
        <Button size="sm" variant="ghost" busy={busy === 'remove:' + machine.id} onClick={props.onRemove}>
          <Trash2 aria-hidden /> Remove
        </Button>
      </div>
      {keyShown && (
        <div className="mt-3 space-y-2">
          <p className="text-[13px] text-muted">
            This browser didn’t allow copying. Select the key and copy it. {setupLine(machine.login)}
          </p>
          <PublicKey value={machine.public_key} label={'Public key of ' + machine.name} />
          <Button size="sm" variant="ghost" onClick={props.onHideKey}>
            Hide the key
          </Button>
        </div>
      )}
    </li>
  );
}

const emptyDraft: MachineDraft = {name: '', address: '', port: '22', login: ''};

/** The name, address, port and login of a machine: the same fields and checks to add one and to edit one. */
function MachineFields({
  id,
  draft,
  onChange,
  problems,
  problem,
  onSubmit,
}: {
  id: string;
  draft: MachineDraft;
  onChange: React.Dispatch<React.SetStateAction<MachineDraft>>;
  problems: Partial<Record<keyof MachineDraft, string>>;
  problem: string | null;
  onSubmit: () => void;
}) {
  const edit = (key: keyof MachineDraft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    onChange(current => ({...current, [key]: value}));
  };
  // localhost is Nocheh's own container: a warning, since the store takes it.
  const local = localAddress(draft.address);
  return (
    <form
      id={id}
      className="grid gap-4 sm:grid-cols-[1fr_7rem]"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label="Name" htmlFor={id + '-name'} error={problems.name} className="sm:col-span-2">
        <Input
          id={id + '-name'}
          placeholder="build-vm"
          autoComplete="off"
          maxLength={40}
          value={draft.name}
          onChange={edit('name')}
        />
      </Field>
      <Field
        label="Address"
        htmlFor={id + '-address'}
        error={problems.address}
        hint={local ? <span className="text-warn">{localHint}</span> : addressHint}
      >
        <Input
          id={id + '-address'}
          placeholder="192.0.2.10"
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          value={draft.address}
          onChange={edit('address')}
        />
      </Field>
      <Field label="Port" htmlFor={id + '-port'} error={problems.port}>
        <Input
          id={id + '-port'}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          value={draft.port}
          onChange={edit('port')}
        />
      </Field>
      <Field label="Login" htmlFor={id + '-login'} error={problems.login} hint={loginHint} className="sm:col-span-2">
        <Input
          id={id + '-login'}
          placeholder="nocheh"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          value={draft.login}
          onChange={edit('login')}
        />
      </Field>
      {problem && (
        <Notice tone="bad" className="sm:col-span-2">
          {problem}
        </Notice>
      )}
    </form>
  );
}

/** Add machine: the form, then the public key to put on the machine and a first Test. */
function AddMachine({open, onClose, taken}: {open: boolean; onClose: () => void; taken: string[]}) {
  const feedback = useFeedback();
  const [draft, setDraft] = useState<MachineDraft>(emptyDraft);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<'' | 'add' | 'test'>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<Machine | null>(null);
  const [tested, setTested] = useState<MachineTest['result'] | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const problems = machineProblems(draft, taken);
  const close = () => {
    onClose();
    setDraft(emptyDraft);
    setChecked(false);
    setProblem(null);
    setAdded(null);
    setTested(null);
    setCopyFailed(false);
  };
  const add = async () => {
    setChecked(true);
    if (Object.keys(problems).length) return;
    setBusy('add');
    setProblem(null);
    try {
      setAdded(await apiPost<Machine>('/machines', machineBody(draft)));
    } catch (e) {
      setProblem(failure((e as Error)?.message ?? '', draft.login.trim()));
    } finally {
      setBusy('');
      await refreshResources().catch(() => {});
    }
  };
  const test = async () => {
    if (!added) return;
    setBusy('test');
    setProblem(null);
    setTested(null);
    try {
      const {result} = await apiPost<MachineTest>(`/machines/${added.id}/test`, {});
      setTested(result);
    } catch (e) {
      setProblem(failure((e as Error)?.message ?? '', added.login));
    } finally {
      setBusy('');
      await refreshResources().catch(() => {});
    }
  };
  const copy = async () => {
    if (!added) return;
    if (await copyText(added.public_key)) {
      setCopyFailed(false);
      feedback.toast('The public key is copied.');
    } else setCopyFailed(true);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => !next && close()}
      title={added ? `Put the key on ${added.name}` : 'Add a machine'}
      description={
        added
          ? 'Nocheh made a key for this machine and keeps it. Only this public half leaves Nocheh.'
          : 'A machine you run, such as a VM, that Nocheh reaches over SSH.'
      }
      footer={
        added ? (
          <>
            <Button onClick={close}>{tested?.ok ? 'Done' : 'Later'}</Button>
            <Button variant="primary" busy={busy === 'test'} onClick={() => void test()}>
              <PlugZap aria-hidden /> {tested ? 'Test again' : 'Test'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="add-machine" busy={busy === 'add'}>
              Add machine
            </Button>
          </>
        )
      }
    >
      {added ? (
        <div className="space-y-3">
          <p className="text-sm">{setupLine(added.login)}</p>
          <PublicKey value={added.public_key} label={'Public key of ' + added.name} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copy()}>
              <Copy aria-hidden /> Copy public key
            </Button>
            {copyFailed && (
              <span className="text-[13px] text-muted">This browser didn’t allow copying. Select the key above.</span>
            )}
          </div>
          {tested?.ok && (
            <Notice tone="good" title={`${added.name} is ready`}>
              {tested.system ? `It runs ${tested.system}. ` : ''}Nocheh now trusts its host key
              {tested.host_key ? ` ${tested.host_key}` : ''}.
            </Notice>
          )}
          {tested && !tested.ok && (
            <Notice tone="warn" title={machineErrorWords(tested.error)}>
              {machineAdvice(tested.error ?? '', added.login)}
            </Notice>
          )}
          {problem && <Notice tone="bad">{problem}</Notice>}
        </div>
      ) : (
        <MachineFields
          id="add-machine"
          draft={draft}
          onChange={setDraft}
          problems={checked ? problems : {}}
          problem={problem}
          onSubmit={() => void add()}
        />
      )}
    </Dialog>
  );
}

/**
 * Edit a machine's name, address, port or login over the revision it was opened at. A new address,
 * port or login asks first: the store forgets the host key, stops the machine's jobs and withdraws
 * its waiting cards, and the machine needs a new Test. Its key stays. `machine` is the machine as
 * the page has it now: after a change made meanwhile is refused, Save goes over that one.
 */
function EditMachine({machine, onClose, taken}: {machine: Machine; onClose: () => void; taken: string[]}) {
  const feedback = useFeedback();
  const [draft, setDraft] = useState<MachineDraft>(() => machineDraft(machine));
  // The revision the fields were read at; none once a save over it was refused.
  const [read, setRead] = useState<number | null>(machine.revision);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problems = machineProblems(draft, taken);
  const save = async () => {
    setChecked(true);
    if (Object.keys(problems).length) return;
    const {body, moved, changed} = machineEdit({...machine, revision: read ?? machine.revision}, draft);
    if (!changed) return onClose();
    if (
      moved &&
      !(await feedback.confirm({
        title: `Change where Nocheh reaches ${machine.name}?`,
        body: moveText(machine),
        confirm: 'Change and forget the host key',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setProblem(null);
    try {
      await apiPost<Machine>('/machines/' + machine.id, body);
      feedback.toast(moved ? `${body.name} is changed. Press Test to trust its host key.` : `${body.name} is saved.`);
      onClose();
    } catch (e) {
      const code = (e as Error)?.message ?? '';
      if (code === 'configuration_conflict') setRead(null);
      setProblem(failure(code, body.login));
    } finally {
      setBusy(false);
      await refreshResources().catch(() => {});
    }
  };
  return (
    <Dialog
      open
      onOpenChange={next => !next && onClose()}
      title={`Edit ${machine.name}`}
      description="A new address, port or login needs a new Test. Its key stays the same."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-machine" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <MachineFields
        id="edit-machine"
        draft={draft}
        onChange={setDraft}
        problems={checked ? problems : {}}
        problem={problem}
        onSubmit={() => void save()}
      />
    </Dialog>
  );
}
