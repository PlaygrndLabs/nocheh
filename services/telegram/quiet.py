"""Quiet hours (ADR-0297): a message Nocheh starts on its own arrives silently, with no sound or buzz, in the hours set
in Settings › Telegram, in the time zone of the person whose private chat it goes to. A reminder or a scheduled
result the person set for that time still rings, and so does a reply to their own message, as it always did.

Only private chats of the owner and of active members have a time zone (core's /internal/quiet-hours). A group has
none, so nothing sent there is held quiet. When core cannot say, the message rings: a missed problem is worse than a
buzz at night."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .settings import archive_url, secret

WINDOW = re.compile(r'([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)')
# What still rings in quiet hours: the person set it for that time.
RINGING = frozenset({'reminder', 'scheduled_run'})
REFRESH = 60.0


def window(value=None):
    """(start, end) in minutes after midnight, or None when quiet hours are off or the setting does not read."""
    value = os.environ.get('NOCHEH_QUIET_HOURS', '') if value is None else value
    match = WINDOW.fullmatch(value or '')
    if not match: return None
    start, end = int(match[1]) * 60 + int(match[2]), int(match[3]) * 60 + int(match[4])
    return None if start == end else (start, end)


def inside(span, zone, now=None):
    """Whether `now` falls in `span` on the clock of `zone`; a window past midnight wraps."""
    try: local = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(zone))
    except Exception: return False
    minute, (start, end) = local.hour * 60 + local.minute, span
    return start <= minute < end if start < end else minute >= start or minute < end


def fetch_zones():
    request = urllib.request.Request(archive_url() + '/internal/quiet-hours', headers={'Authorization': 'Bearer ' + secret('SERVICE_TOKEN')})
    with urllib.request.urlopen(request, timeout=10) as response: body = json.loads(response.read(1024 * 1024))
    zones = body.get('zones') if isinstance(body, dict) else None
    if not isinstance(zones, dict): raise ValueError('invalid_quiet_hours')
    return {str(chat): zone for chat, zone in zones.items() if isinstance(zone, str) and len(zone) <= 64}


class QuietHours:
    def __init__(self, fetch=fetch_zones, clock=time.monotonic, setting=None):
        self.fetch, self.clock, self.setting = fetch, clock, setting
        self.zones, self.read_at, self.lock = {}, None, threading.Lock()

    def _zones(self):
        with self.lock:
            if self.read_at is None or self.clock() - self.read_at >= REFRESH:
                # A failed read keeps the last zones it had; with none, every message rings.
                try: self.zones = self.fetch()
                except Exception: pass
                self.read_at = self.clock()
            return self.zones

    def silent(self, chat, send_class=None, now=None):
        """True when a message of `send_class` to the Telegram chat `chat` goes without sound now."""
        span = window(self.setting)
        if span is None or send_class in RINGING: return False
        zone = self._zones().get(str(chat))
        return bool(zone) and inside(span, zone, now)
