"""Exact pinned-source patches: per-form revision and scoped native file requests."""
from pathlib import Path
import sys
root = Path(sys.argv[1])
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
