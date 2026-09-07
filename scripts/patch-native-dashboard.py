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
replace('const PROFILE_SCOPED_PREFIXES = [', 'const PROFILE_SCOPED_PREFIXES = [\n  "/api/files",')
path.write_text(source)
