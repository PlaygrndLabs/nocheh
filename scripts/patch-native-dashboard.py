"""Exact pinned-source patches: per-form revision and scoped native file requests."""
from pathlib import Path
import sys
root = Path(sys.argv[1])
(root / 'web/src/lib/nocheh-browser-delivery.ts').write_text(Path(__file__).with_name('native-browser-delivery.ts').read_text())
path = root / 'web/src/lib/api.ts'
source = path.read_text()
def replace(old, new):
    global source
    if source.count(old) != 1: raise SystemExit('native dashboard compatibility anchor changed')
    source = source.replace(old, new)
replace('''  saveConfig: (config: Record<string, unknown>, profile = getManagementProfile()) =>
    fetchJSON<{ ok: boolean }>(appendProfileParam("/api/config", profile), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),''', '''  saveConfig: (config: Record<string, unknown>, profile = getManagementProfile()) =>
    fetchJSON<{ ok: boolean; revision: string }>(appendProfileParam("/api/config", profile), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(config._nocheh_revision || "") },
      body: JSON.stringify({ config }),
    }).then(result => { config._nocheh_revision = result.revision; return result; }),''')
replace('const PROFILE_SCOPED_PREFIXES = [', 'const PROFILE_SCOPED_PREFIXES = [\n  "/api/files",\n  "/api/chat/image-upload",')
path.write_text(source)
path = root / 'web/src/contexts/ProfileProvider.tsx'
source = path.read_text()
replace('''        const next = new URLSearchParams(prev);
        if (profile) next.set("profile", profile);''', '''        const next = new URLSearchParams(prev);
        next.delete("resume"); // Reasserting a new scope must not restore a stale session.
        if (profile) next.set("profile", profile);''')
replace('''          const next = new URLSearchParams(prev);
          if (name) next.set("profile", name);''', '''          const next = new URLSearchParams(prev);
          next.delete("resume"); // A session ID belongs to its previous profile.
          if (name) next.set("profile", name);''')
path.write_text(source)
path = root / 'web/src/components/ChatSidebar.tsx'
source = path.read_text()
source = 'import {receiveBrowserDelivery, resumeBrowserDeliveries} from "@/lib/nocheh-browser-delivery";\n' + source
replace('''  const [state, setState] = useState<ConnectionState>("idle");''', '''  useEffect(() => resumeBrowserDeliveries(api.acknowledgeBrowserDelivery), []);
  const [state, setState] = useState<ConnectionState>("idle");''')
replace('''        const { type, payload } = frame.params;''', '''        const { type, payload } = frame.params;
        if (type === "message.complete") void receiveBrowserDelivery(payload, api.acknowledgeBrowserDelivery).catch(() => {});''')
replace('const url = await buildWsUrl("/api/events", { channel });', 'const url = await buildWsUrl("/api/events", { channel, profile: profile || "" });')
path.write_text(source)
path = root / 'web/src/pages/ChatPage.tsx'
source = path.read_text()
replace('  const { profile: scopedProfile } = useProfileScope();', '''  const { profile: scopedProfile } = useProfileScope();
  const [nochehContext, setNochehContext] = useState("Checking conversation scope…");
  useEffect(() => {
    let active = true;
    setNochehContext("Checking conversation scope…");
    api.getProfiles().then(data => {
      const profiles = data.profiles as Array<{name: string; description?: string; is_default?: boolean}>;
      const selected = profiles.find(p => p.name === scopedProfile) || profiles.find(p => p.is_default);
      if (active) setNochehContext(selected?.description || "Scope unavailable");
    }).catch(() => { if (active) setNochehContext("Scope unavailable"); });
    return () => { active = false; };
  }, [scopedProfile]);''')
replace('      <PluginSlot name="chat:top" />', '''      <PluginSlot name="chat:top" />
      <div className="border border-border rounded px-3 py-2 text-xs" role="status">
        Context: {nochehContext}. Select a profile to change context. Originals are archived before execution.
        Shell, public-page inspection and HTTPS MCP requests appear in Nocheh Activity for approval. Scheduled runs are being integrated.
      </div>''')
path.write_text(source)
path = root / 'web/src/lib/api.ts'
source = path.read_text()
replace('''export const api = {''', '''export const api = {
  acknowledgeBrowserDelivery: (receipt: {receipt: string; sha256: string}) =>
    fetchJSON("/api/nocheh/browser-delivered", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(receipt)}),''')
replace('''  createCronJob: (job: CronJobMutation, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },''', '''  createCronJob: (job: CronJobMutation, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },''')
replace('''    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger?profile=${encodeURIComponent(profile)}`, { method: "POST" }),''', '''    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger?profile=${encodeURIComponent(profile)}`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } }),
  managedCronAction: (id: string, action: "catch-up" | "cancel", profile: string) =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/${action}?profile=${encodeURIComponent(profile)}`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } }),''')
path.write_text(source)
path = root / 'web/src/pages/CronPage.tsx'
source = path.read_text()
replace('''      await api.updateCronJob(
        editJob.id,''', '''      (payload as unknown as Record<string, unknown>)._nocheh_revision = (editJob as CronJob & {_nocheh_revision: string})._nocheh_revision;
      await api.updateCronJob(
        editJob.id,''')
replace('''      <PluginSlot name="cron:top" />''', '''      <PluginSlot name="cron:top" />
      <div className="border border-border rounded px-3 py-2 text-sm">
        Prompt schedules run in the selected profile, with a fresh session for each fire.
        Local results appear in Nocheh Activity. Telegram results require review before sending.
        Missed runs are skipped; Catch up once runs one missed occurrence. Pause stops future starts; Cancel run stops active work.
        <a className="underline ml-2" href="/#activity">Open run evidence and approvals</a>
      </div>''')
replace('''    <details className="border border-border bg-background/30 p-3" open>''', '''    <details hidden className="border border-border bg-background/30 p-3">''')
replace('''                <div className="flex items-center gap-1 shrink-0">
                  <Button''', '''                <div className="flex items-center gap-1 shrink-0">
                  {!!(job as CronJob & {nocheh_missed?: unknown}).nocheh_missed && <Button onClick={async () => {
                    try { await api.managedCronAction(job.id, "catch-up", getJobProfile(job)); loadJobs(selectedProfile); }
                    catch (e) { showToast(String(e), "error"); }
                  }}>Catch up once</Button>}
                  {!!((job as CronJob & {nocheh_running?: unknown; nocheh_pending?: unknown}).nocheh_running || (job as CronJob & {nocheh_pending?: unknown}).nocheh_pending) && <Button onClick={async () => {
                    try { await api.managedCronAction(job.id, "cancel", getJobProfile(job)); loadJobs(selectedProfile); }
                    catch (e) { showToast(String(e), "error"); }
                  }}>Cancel run</Button>}
                  <Button''')
path.write_text(source)
path = root / 'web/src/pages/CronPage.tsx'
source = path.read_text()
replace('''  scheduleState: ScheduleBuilderState;
}''', '''  scheduleState: ScheduleBuilderState;
  nochehPreferences: Record<string, string | number | null>;
}''')
replace('''    scheduleState: { ...DEFAULT_SCHEDULE_STATE },''', '''    scheduleState: { ...DEFAULT_SCHEDULE_STATE },
    nochehPreferences: {},''')
replace('''  return { ...form, scheduleState: parseScheduleString(form.schedule) };''', '''  return { ...form, scheduleState: parseScheduleString(form.schedule), nochehPreferences: (job as CronJob & {nocheh_preferences?: Record<string, string | number | null>}).nocheh_preferences || {} };''')
replace('''  const { scheduleState, ...payloadForm } = form;
  return buildCronJobPayload({
    ...payloadForm,
    schedule: buildScheduleString(scheduleState),
  });''', '''  const { scheduleState, nochehPreferences, ...payloadForm } = form;
  return { ...buildCronJobPayload({
    ...payloadForm,
    schedule: buildScheduleString(scheduleState),
  }), nocheh_preferences: nochehPreferences };''')
replace('''      <CronAdvancedFields
        idPrefix={`${idPrefix}-advanced`}''', '''      <fieldset className="grid gap-3 border border-border p-3">
        <legend>Run settings</legend>
        <p className="text-xs text-muted-foreground">Leave blank to inherit profile and global preferences. Overrides apply to this job only.</p>
        <Label htmlFor={`${idPrefix}-steps`}>Maximum agent steps (1–16)</Label>
        <Input id={`${idPrefix}-steps`} type="number" min={1} max={16} value={form.nochehPreferences["agent.max_iterations"] ?? ""}
          onChange={e => onChange({...form, nochehPreferences: {...form.nochehPreferences, "agent.max_iterations": e.target.value ? Number(e.target.value) : null}})} />
        <Label htmlFor={`${idPrefix}-seconds`}>Time per run (30–180 seconds)</Label>
        <Input id={`${idPrefix}-seconds`} type="number" min={30} max={180} value={form.nochehPreferences["agent.run_budget_seconds"] ?? ""}
          onChange={e => onChange({...form, nochehPreferences: {...form.nochehPreferences, "agent.run_budget_seconds": e.target.value ? Number(e.target.value) : null}})} />
      </fieldset>
      <CronAdvancedFields
        idPrefix={`${idPrefix}-advanced`}''')
path.write_text(source)
path = root / 'web/src/pages/CronPage.tsx'
source = path.read_text()
replace('''          Selected skills are loaded before the prompt runs — the cron
          sets when, the skill sets how.''', '''          Scheduled runs use the managed archive, native memory and proposal tools for this profile.
          Custom skill execution is not enabled.''')
path.write_text(source)
