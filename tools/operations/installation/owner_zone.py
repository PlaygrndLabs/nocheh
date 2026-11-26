"""The owner's time zone (Settings › General, ADR-0312) for the dashboard's own work: daily backups at their set time,
and the times in the owner's problem notices.

Nocheh is asked each time. The last zone it gave is kept here, so while Nocheh restarts nothing moves, and UTC is used
only before its first answer."""
import json
import os
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

RECORD = 'admin/owner-time-zone.json'


def known(zone):
    """Whether `zone` is a time zone this machine knows."""
    try: return isinstance(zone, str) and 0 < len(zone) <= 64 and ZoneInfo(zone) is not None
    except Exception: return False


def ask():
    """The owner's time zone as Nocheh has it now; raises when Nocheh can't answer."""
    from tools.operations.archive.archive import API
    return API().call('/internal/owner-time-zone', timeout=5).get('time_zone')


def _saved(state):
    try: zone = json.loads((Path(state) / RECORD).read_text()).get('time_zone')
    except (OSError, ValueError, AttributeError): return None
    return zone if known(zone) else None


def _save(state, zone):
    path = Path(state) / RECORD; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as file:
        json.dump({'time_zone': zone}, file); file.flush(); os.fsync(file.fileno()); temporary = Path(file.name)
    temporary.chmod(0o600); temporary.replace(path)


def owner_zone(state):
    """The owner's time zone: Nocheh's answer, else the last one it gave, else UTC."""
    saved = _saved(state)
    try:
        zone = ask()
        if known(zone):
            if zone != saved:
                try: _save(state, zone)
                except OSError: pass
            return zone
    except Exception: pass
    return saved or 'UTC'
