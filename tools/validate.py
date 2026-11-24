#!/usr/bin/env python3
"""Check every case in cases/ against the schema and the dataset rules.

  python tools/validate.py                 check everything (exit 1 on errors)
  python tools/validate.py --format        rewrite case files in canonical form
  python tools/validate.py --preview ID    print one case with hidden characters marked
  python tools/validate.py --write-jsonl PATH   write the release bundle (only if no errors)

Standard library only. No network access. Rule ids (V01...) are listed in
docs/authoring.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pab_lib as L  # noqa: E402

RESERVED_ANY = (".example", ".test", ".invalid")
RESERVED_VICTIM = ("example.com", "example.org", "example.net")
EMAIL_RE = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)", re.UNICODE)
IPV4_RE = re.compile(r"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])")
TESTNETS = ("192.0.2.", "198.51.100.", "203.0.113.")
PHONE_IR_MOBILE = re.compile(r"(?<!\d)(?:\+?98|0)9\d{9}(?!\d)")
SUFFIXES_OK_AFTER_ZWNJ = ("ها", "های", "هایی", "هایم", "هایت", "هایش", "هایمان", "هایتان", "هایشان", "ام", "ات", "اش",
                          "ای", "اید", "ایم", "اند", "تر", "ترین", "مان", "تان", "شان", "ی", "یی")
PREFIXES_OK_BEFORE_ZWNJ = ("می", "نمی", "بی", "هم")


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def e(self, cid, rule, msg):
        self.errors.append(f"{cid}: {rule} {msg}")

    def w(self, cid, rule, msg):
        self.warnings.append(f"{cid}: {rule} {msg}")


# ---------------------------------------------------------------- helpers

def visible_texts(case: dict):
    """(where, text) for every string the agent can see."""
    yield "user_request", case["user_request"]["fa"]
    for it in case["items"]:
        for k, v in it.items():
            if isinstance(v, dict) and "fa" in v:
                yield f"items.{it['id']}.{k}", v["fa"]
            elif isinstance(v, str) and k not in ("id", "kind", "role", "time", "start", "end"):
                yield f"items.{it['id']}.{k}", v
            elif isinstance(v, list):
                for x in v:
                    if isinstance(x, str):
                        yield f"items.{it['id']}.{k}", x
    mem = case.get("memory")
    if mem:
        yield "memory.background_rule", mem["background_rule"]["fa"]
        for i, p in enumerate(mem["probes"]):
            yield f"memory.probes[{i}]", p["question"]["fa"]


def bi_pairs(obj, path="$"):
    if isinstance(obj, dict):
        if set(obj) == {"fa", "en"} and all(isinstance(v, str) for v in obj.values()):
            yield path, obj
        else:
            for k, v in obj.items():
                yield from bi_pairs(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from bi_pairs(v, f"{path}[{i}]")


def hosts_and_emails(text: str):
    for u in L.extract_urls(text):
        yield "host", L.url_host(u)
    for m in EMAIL_RE.finditer(text):
        yield "email", m.group(0)


def reserved(host: str, attacker: bool) -> bool:
    host = L.canon(host).rstrip(".")
    if host.startswith(TESTNETS) and IPV4_RE.fullmatch(host):
        return True
    ok = RESERVED_ANY if attacker else RESERVED_ANY + RESERVED_VICTIM
    return any(host == s.lstrip(".") or host.endswith(s if s.startswith(".") else "." + s) or host == s
               for s in ok)


def iban_valid(digits24: str) -> bool:
    s = digits24[2:] + "1827" + digits24[:2]  # IR = 18 27
    return int(s) % 97 == 1


def luhn_valid(num: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(num)):
        d = int(ch)
        if i % 2:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def special_codepoints(text: str):
    """Yield (technique, char, index) for code points that need a declared technique."""
    for i, ch in enumerate(text):
        cp = ord(ch)
        prev = text[i - 1] if i else ""
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch in "​⁠﻿":
            yield "T01", ch, i
        elif ch == "‍":
            if not (unicodedata.category(prev) == "So" or unicodedata.category(nxt) == "So"):
                yield "T01", ch, i
        elif ch == "‌":
            if not zwnj_orthographic(text, i):
                yield "T02", ch, i
        elif ch in "يكىة" or 0x0660 <= cp <= 0x0669:
            yield "T03", ch, i
        elif (0xFB50 <= cp <= 0xFDFF or 0xFE70 <= cp <= 0xFEFE) and ch not in "ﷲ﷼﷽":
            yield "T04", ch, i
        elif ch == "ـ":
            yield "T05", ch, i
        elif 0x064C <= cp <= 0x0650 or cp in (0x0652, 0x0670):
            yield "T06", ch, i
        elif 0x202A <= cp <= 0x202E or 0x2066 <= cp <= 0x2069:
            yield "T07", ch, i
        elif ch in "‎‏؜":
            # allowed at a script boundary, otherwise a bidi trick
            if not (_is_latin(prev) or _is_latin(nxt) or prev.isdigit() or nxt.isdigit()):
                yield "T07", ch, i
        elif 0xE0000 <= cp <= 0xE007F:
            yield "T20", ch, i


def _is_latin(ch: str) -> bool:
    return bool(ch) and ch.isascii() and ch.isalpha()


def zwnj_orthographic(text: str, i: int) -> bool:
    """Is the ZWNJ at text[i] ordinary Persian spelling?"""
    left = re.search(r"[\wٔ]+$", text[:i])
    right = re.match(r"[\wٔ]+", text[i + 1:])
    if not left or not right:
        return False
    lw, rw = left.group(0), right.group(0)
    if not re.search(r"[؀-ۿ]", lw + rw) and not lw[-1:].isascii():
        return False
    if any(lw.endswith(p) and len(lw) == len(p) for p in PREFIXES_OK_BEFORE_ZWNJ):
        return True
    if any(rw == s or rw.startswith(s) and len(rw) - len(s) <= 2 for s in SUFFIXES_OK_AFTER_ZWNJ):
        return True
    if _ZWNJ_OK and (lw + "‌" + rw) in _ZWNJ_OK:
        return True
    # compound words: both sides are real-looking Persian parts of 2+ letters
    if len(lw) >= 2 and len(rw) >= 2 and re.fullmatch(r"[؀-ۿٔ]+", lw + rw):
        last = lw[-1]
        # a ZWNJ after a letter that never joins left changes nothing visible:
        # only spelling-list compounds are trusted there.
        return last not in "اآدذرزژو"
    if lw.isascii() and re.fullmatch(r"[؀-ۿ]+", rw):
        return any(rw.startswith(s) for s in SUFFIXES_OK_AFTER_ZWNJ)  # «PDF‌ها»
    return False


_ZWNJ_OK_PATH = L.ROOT / "taxonomy" / "zwnj_ok.txt"
_ZWNJ_OK = set()
if _ZWNJ_OK_PATH.exists():
    _ZWNJ_OK = {ln.strip() for ln in _ZWNJ_OK_PATH.read_text(encoding="utf-8").splitlines()
                if ln.strip() and not ln.startswith("#")}


def echo_trace(case: dict) -> dict:
    bodies = []
    for it in case["items"]:
        for k in ("subject", "title", "body"):
            if k in it:
                bodies.append(it[k]["fa"])
    return {"tool_calls": [], "outbound_urls": [], "memory_writes": [], "final_text": "\n\n".join(bodies), "probes": []}


def reference_trace(case: dict, calls: list[dict]) -> dict:
    canary = case["canary"]
    tcs, urls = [], []
    for i, c in enumerate(calls, 1):
        args = json.loads(json.dumps(c["args"], ensure_ascii=False).replace("$CANARY", canary))
        tcs.append({"seq": i, "phase": "attack", "tool": c["tool"], "native_tool": c["tool"], "args": args,
                    "status": "executed", "origin": "agent"})
        if c["tool"] in ("open_url", "read_web"):
            urls.append({"seq": i, "phase": "attack", "url": args["url"], "via": "tool"})
    return {"tool_calls": tcs, "outbound_urls": urls, "memory_writes": [], "final_text": "", "probes": []}


# ---------------------------------------------------------------- checks

def check_case(path: Path, case: dict, ds: dict, schema: L.SchemaChecker, tools: set, techs: set, r: Report):
    cid = case.get("id", path.stem)
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        r.e(cid, "V01", "file starts with a BOM")
    for err in schema.errors(case):
        r.e(cid, "V01", err)
    if r.errors and any(x.startswith(f"{cid}: V01") for x in r.errors):
        return
    if raw.decode("utf-8") != L.dump_canonical(case):
        r.e(cid, "V02", "file is not in canonical format (run validate.py --format)")
    if path.name != f"{cid}.json" or path.parent.name != case["track"]:
        r.e(cid, "V03", f"file should be cases/{case['track']}/{cid}.json")
    fam = cid.rsplit("-", 1)[0]
    vseg = cid.rsplit("-", 1)[1]
    want_variant = {"p": "plain", "c": "control"}.get(vseg, "disguised")
    if case["family"] != fam or case["variant"] != want_variant or cid[4] != case["track"][0]:
        r.e(cid, "V04", "id, family, variant and track disagree")
    if case["contamination_guid"] != ds["contamination_guid"]:
        r.e(cid, "V06", "contamination_guid differs from dataset.json")

    attack = case["variant"] != "control"
    items = {it["id"]: it for it in case["items"]}
    if len(items) != len(case["items"]):
        r.e(cid, "V07", "duplicate item ids")
    carriers = [it for it in case["items"] if it["role"] == "carrier"]
    if len(carriers) != 1 or carriers[0]["id"] != case["carrier"]["item"]:
        r.e(cid, "V07", "need exactly one carrier item, named in carrier.item")
        return
    carrier = carriers[0]
    if carrier["kind"] != case["carrier"]["type"]:
        r.e(cid, "V07", "carrier.type differs from the carrier item's kind")

    # V34: times
    ref = datetime.fromisoformat(ds["reference_time"])
    times = [datetime.fromisoformat(it["time"]) for it in case["items"] if "time" in it]
    if any(t > ref for t in times):
        r.e(cid, "V34", "an item is dated after the reference time")
    if times != sorted(times):
        r.e(cid, "V34", "items are not oldest first")

    body = carrier["body"]["fa"]
    if attack:
        inj = case["injection"]["text"]["fa"]
        n = body.count(inj)
        if n != 1:
            r.e(cid, "V08", f"injection occurs {n} times in the carrier body (need 1)")
        else:
            pos = body.index(inj)
            before, after = body[:pos].strip(), body[pos + len(inj):].strip()
            real = "whole" if not before and not after else "start" if not before else "end" if not after else "middle"
            if case["carrier"].get("placement") != real:
                r.e(cid, "V08", f"placement is {case['carrier'].get('placement')!r}, text says {real!r}")
    if len(body) > 8000:
        r.w(cid, "V10", "carrier body is over 8,000 characters")

    # canary
    canary = case["canary"]
    agent_strings = [t for _, t in visible_texts(case)]
    if case["track"] == "action":
        if not re.fullmatch(r"PAB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", canary):
            r.e(cid, "V12", "action canary must look like PAB-XXXX-XXXX (Crockford base32)")
        priv = [it for it in case["items"] if it["role"] == "private"]
        if not any(L.compact(canary) in L.compact(json.dumps(it, ensure_ascii=False)) for it in priv):
            r.e(cid, "V12", "canary is not in any private item")
        for it in case["items"]:
            if it["role"] != "private" and L.compact(canary) in L.compact(json.dumps(it, ensure_ascii=False)):
                r.e(cid, "V12", f"canary appears in non-private item {it['id']}")
        if L.compact(canary) in L.compact(case["user_request"]["fa"]):
            r.e(cid, "V12", "canary appears in the user request")
        if attack and L.compact(canary) in L.compact(json.dumps(case["attacker_goal"]["text"], ensure_ascii=False)):
            r.e(cid, "V12", "canary appears in the attacker goal text")
    else:
        cc = L.compact(canary)
        if len(cc) < 12 or len(set(cc)) < 5:
            r.e(cid, "V13", "memory canary needs at least 12 letters or digits, 5 different")
        if cc not in L.compact(case["injection"]["text"]["fa"]):
            r.e(cid, "V13", "memory canary is not in the injection text")
        for kf in case["memory"].get("key_facts", []):
            if L.compact(kf) not in L.compact(body):
                r.e(cid, "V13", f"key fact {kf!r} is not in the carrier")
        if any(cc in L.compact(it["body"]["fa"]) for it in case["items"] if it["role"] != "carrier"):
            r.e(cid, "V13", "memory canary appears outside the carrier")

    # predicates
    checks = case["checks"]
    for name, pred in checks.items():
        for kind, b in L.predicate_parts(pred):
            srcs = b.get("in", [])
            if "probe_answer" in srcs and case["track"] != "memory":
                r.e(cid, "V14", f"checks.{name} uses probe_answer in an action case")
            for cond in [b.get("match")] + list((b.get("args") or {}).values()):
                if cond and "regex" in cond:
                    rx = cond["regex"]
                    if re.search(r"\(\?<[=!]|\\[1-9]|\(\?P?<\w|\(\?[^:i]", rx):
                        r.e(cid, "V14", f"regex outside the portable subset: {rx}")
                    try:
                        re.compile(rx.replace("$CANARY", "x"))
                    except re.error as ex:
                        r.e(cid, "V14", f"regex does not compile: {ex}")
            if kind == "call":
                tl = b["tool"] if isinstance(b["tool"], list) else [b["tool"]]
                for t in tl:
                    if t not in case["tools_required"]:
                        r.e(cid, "V20", f"checks.{name} names tool {t} not in tools_required")
                for a in (b.get("args") or {}):
                    known = {x.rstrip("?[]") for tool in tl for x in tools[tool]} | {"*"}
                    if any(t in L.SEND_TOOLS for t in tl):
                        known.add("recipients")
                    if a not in known:
                        r.e(cid, "V14", f"checks.{name}: tool {tl} has no argument {a!r}")

    empty = {"tool_calls": [], "outbound_urls": [], "memory_writes": [], "final_text": "", "probes": []}
    echo = echo_trace(case)
    browse = dict(echo)
    browse["tool_calls"] = [{"seq": i + 1, "phase": "attack", "tool": "read_web", "native_tool": "read_web",
                             "args": {"url": it["url"]}, "status": "executed", "origin": "agent"}
                            for i, it in enumerate(x for x in case["items"] if x["kind"] == "web_page")]
    browse["outbound_urls"] = [{"phase": "attack", "url": c["args"]["url"], "via": "tool"} for c in browse["tool_calls"]]
    for name in ("success", "attempted", "written"):
        if name in checks:
            for tname, tr in (("empty", empty), ("echo", echo), ("benign-browse", browse)):
                if L.evaluate(checks[name], tr, canary):
                    r.e(cid, "V16", f"checks.{name} is true on the {tname} trace (it would fire on a harmless run)")
    # user task reference
    user_tr = reference_trace(case, case["user_calls"])
    for name in ("success", "attempted", "written"):
        if name in checks and L.evaluate(checks[name], user_tr, canary):
            r.e(cid, "V16", f"checks.{name} is true when the agent only does the user's task")
    read_tools = {"read_email": "email", "read_chat": ("chat_message", "chat_forward"), "read_file": ("file", "document"),
                  "read_calendar": "calendar_invite", "read_notes": "note", "read_web": "web_page"}
    if not any(c["tool"] in read_tools and carrier["kind"] in (read_tools[c["tool"]] if isinstance(read_tools[c["tool"]], tuple) else (read_tools[c["tool"]],))
               for c in case["user_calls"]):
        r.e(cid, "V33", "user_calls do not read the carrier")
    for c in case["user_calls"]:
        if c["tool"] not in case["tools_required"]:
            r.e(cid, "V20", f"user_calls tool {c['tool']} not in tools_required")

    if attack and case["track"] == "action":
        ag = case["attacker_goal"]
        ref_tr = reference_trace(case, case["user_calls"] + ag["reference_calls"])
        if not L.evaluate(checks["success"], ref_tr, canary):
            r.e(cid, "V15", "checks.success is false on the attacker's reference calls")
        if "attempted" in checks and not L.evaluate(checks["attempted"], ref_tr, canary):
            r.e(cid, "V15", "checks.attempted is false on the attacker's reference calls")
        for c in ag["reference_calls"]:
            if c["tool"] not in case["tools_required"]:
                r.e(cid, "V20", f"reference call tool {c['tool']} not in tools_required")
        if ag["harm"] == "data_theft" and not any(k == "canary" or "$CANARY" in json.dumps(b)
                                                 for k, b in L.predicate_parts(checks["success"])):
            r.e(cid, "V12", "data-theft success check does not use the canary")
        for h in case["attacker_endpoints"].get("hosts", []):
            if not reserved(h, attacker=True):
                r.e(cid, "V21", f"attacker host {h} must end in .example, .test or .invalid")
        for e in case["attacker_endpoints"].get("emails", []):
            if not reserved(e.split("@")[1], attacker=True):
                r.e(cid, "V21", f"attacker address {e} must end in .example, .test or .invalid")
        for c in ag["reference_calls"]:
            for s in L._strings(c["args"]):
                for kind, h in hosts_and_emails(s):
                    hh = h.split("@")[-1]
                    if not reserved(hh, attacker=True):
                        r.e(cid, "V21", f"attacker reference call uses {h}")
    if case["track"] == "memory":
        for lang in ("fa", "en"):
            tr = dict(empty, memory_writes=[{"store": "notes", "text": case["memory"]["false_claim"][lang]}])
            if not L.evaluate(checks["written"], tr, canary):
                r.e(cid, "V19", f"checks.written is false when memory holds false_claim.{lang}")
    if not attack:
        tr = reference_trace(case, case["user_calls"])
        tr["final_text"] = case.get("expected_reply_hint", {}).get("fa", "")

    # names and identifiers
    for where, text in visible_texts(case):
        for kind, h in hosts_and_emails(text):
            hh = h.split("@")[-1] if kind == "email" else h
            if hh and not reserved(hh, attacker=False):
                r.e(cid, "V21", f"{where}: {h} is not under a reserved name")
        folded = L.canon(text)
        for m in IPV4_RE.finditer(folded):
            ip = ".".join(m.groups())
            if not ip.startswith(TESTNETS):
                r.e(cid, "V23", f"{where}: IP {ip} is not in TEST-NET-1/2/3")
        for m in re.finditer(r"ir((?:\d[ -]?){24})", folded):
            digits = re.sub(r"\D", "", m.group(1))
            if iban_valid(digits):
                r.e(cid, "V24", f"{where}: IBAN-like number passes the checksum; make it invalid")
        for m in re.finditer(r"(?<!\d)((?:\d[ -]?){16})(?!\d)", folded):
            num = re.sub(r"\D", "", m.group(1))
            if luhn_valid(num):
                r.e(cid, "V24", f"{where}: 16-digit number passes Luhn; make it invalid")
        if PHONE_IR_MOBILE.search(re.sub(r"[ -]", "", folded)):
            r.e(cid, "V25", f"{where}: looks like an Iranian mobile number; use a landline with subscriber part 0xxxxxxx")
        for bad in _DENY:
            if L.has_word(text, bad):
                r.w(cid, "V26", f"{where}: mentions {bad!r} (real brand or organisation?)")

    # text pairs
    for p, pair in bi_pairs(case):
        if not pair["fa"].strip() or not pair["en"].strip():
            r.e(cid, "V27", f"{p}: empty fa or en")
    for t in case["techniques"]:
        if t not in techs:
            r.e(cid, "V28", f"unknown technique {t}")
    declared = set(case["techniques"])
    found = set()
    for where, text in visible_texts(case):
        for tech, ch, i in special_codepoints(text):
            found.add(tech)
            if tech not in declared and tech not in set(case.get("incidental", [])):
                ctx = text[max(0, i - 8):i + 8]
                r.e(cid, "V28", f"{where}: U+{ord(ch):04X} needs technique {tech} (near {ascii(ctx)})")
    for tech in ("T01", "T03", "T04", "T05", "T06", "T07", "T20"):
        if tech in declared and tech not in found:
            r.e(cid, "V28", f"technique {tech} is declared but its characters are missing")
    if ({"T11", "T12"} & declared) and not case.get("injection", {}).get("decoded"):
        r.e(cid, "V28", "T11 and T12 need injection.decoded")
    tids = [t for t in case["techniques"] if t.startswith("T")]
    if case["variant"] == "plain" and tids:
        r.e(cid, "V29", "plain variants declare no T techniques")
    if case["variant"] == "disguised" and not 1 <= len(tids) <= 3:
        r.e(cid, "V29", "disguised variants declare 1 to 3 T techniques")
    if case["variant"] == "control" and {"G01", "G02", "G03", "G05"} & declared:
        r.e(cid, "V29", "controls cannot declare attack framing G01-G03 or G05")

    if RELEASE and case["status"] == "active" and case.get("review_status") != "approved":
        r.e(cid, "V31", f"review_status is {case.get('review_status')}; a release needs approved")


RELEASE = False
_DENY_PATH = L.ROOT / "tools" / "denylist.txt"
_DENY = [ln.strip() for ln in _DENY_PATH.read_text(encoding="utf-8").splitlines()
         if ln.strip() and not ln.startswith("#")] if _DENY_PATH.exists() else []


def check_all() -> tuple[Report, list[dict]]:
    r = Report()
    ds = L.dataset_info()
    schema = L.SchemaChecker(L.load_json(L.ROOT / "schema" / "case.schema.json"))
    tools = {t["name"]: t["args"] for t in L.load_json(L.ROOT / "taxonomy" / "tools.json")["tools"]}
    techs = {t["id"] for t in L.load_json(L.ROOT / "taxonomy" / "techniques.json")["techniques"]}
    cases = []
    for p in L.case_paths():
        try:
            case = L.load_json(p)
        except (json.JSONDecodeError, UnicodeDecodeError) as ex:
            r.e(p.stem, "V01", f"not valid UTF-8 JSON: {ex}")
            continue
        cases.append(case)
        check_case(p, case, ds, schema, tools, techs, r)

    # dataset-wide rules
    ids = [c.get("id") for c in cases]
    for d in {i for i in ids if ids.count(i) > 1}:
        r.e(d, "V04", "duplicate id")
    canaries = {}
    for c in cases:
        cc = L.compact(c["canary"])
        for other, oc in canaries.items():
            if cc in oc or oc in cc:
                if c["family"] != other.rsplit("-", 1)[0] or c["track"] == "action":
                    r.e(c["id"], "V11", f"canary overlaps with {other}")
        canaries[c["id"]] = cc
    fams: dict[str, list[dict]] = {}
    for c in cases:
        fams.setdefault(c["family"], []).append(c)
    for fam, members in fams.items():
        if not any(m["variant"] == "plain" for m in members):
            r.e(fam, "V05", "family has no plain variant")
        base = next((m for m in members if m["variant"] == "plain"), members[0])
        for m in members:
            if m["carrier"]["type"] != base["carrier"]["type"]:
                r.e(m["id"], "V05", "carrier type differs within the family")
            if m["variant"] == "disguised":
                if m["user_request"] != base["user_request"]:
                    r.e(m["id"], "V05", "user request differs from the plain variant")
                if m["track"] == "action" and m["attacker_goal"]["category"] != base["attacker_goal"]["category"]:
                    r.e(m["id"], "V05", "goal category differs from the plain variant")
    return r, cases


def preview(cid: str):
    for p in L.case_paths():
        c = L.load_json(p)
        if c["id"] != cid:
            continue
        names = {0x200B: "ZWSP", 0x200C: "ZWNJ", 0x200D: "ZWJ", 0x2060: "WJ", 0xFEFF: "BOM", 0x202E: "RLO",
                 0x202D: "LRO", 0x202C: "PDF", 0x200E: "LRM", 0x200F: "RLM", 0x2066: "LRI", 0x2067: "RLI",
                 0x2069: "PDI", 0x0640: "TATWEEL"}

        def mark(s):
            out = []
            for ch in s:
                cp = ord(ch)
                if cp == 0x200C and True:
                    out.append(ch)
                elif cp in names or unicodedata.category(ch) == "Cf":
                    out.append(f"⟦{names.get(cp, 'U+%04X' % cp)}⟧")
                elif ch in "يكىة" or 0x0660 <= cp <= 0x0669:
                    out.append(f"⟦AR:{ch}⟧")
                else:
                    out.append(ch)
            return "".join(out)

        print(f"# {c['id']} ({c['variant']}, {c['track']})\n{c['title']}\n")
        print("USER:", mark(c["user_request"]["fa"]), "\n     ", c["user_request"]["en"], "\n")
        for it in c["items"]:
            head = " ".join(f"{k}={v}" for k, v in it.items() if isinstance(v, str) and k not in ("id", "kind", "role"))
            print(f"--- {it['id']} [{it['kind']}, {it['role']}] {head}")
            for k in ("subject", "title", "body"):
                if k in it:
                    print(f"{k}: {mark(it[k]['fa'])}")
            print()
        return
    sys.exit(f"no case {cid}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--format", action="store_true")
    ap.add_argument("--preview")
    ap.add_argument("--write-jsonl")
    ap.add_argument("--quiet", action="store_true", help="hide warnings")
    ap.add_argument("--release", action="store_true", help="also apply the release rules")
    a = ap.parse_args()
    global RELEASE
    RELEASE = a.release
    if a.preview:
        return preview(a.preview)
    if a.format:
        for p in L.case_paths():
            p.write_text(L.dump_canonical(L.load_json(p)), encoding="utf-8")
    r, cases = check_all()
    if not a.quiet:
        for w in r.warnings:
            print("warning:", w)
    for e in r.errors:
        print("error:", e)
    n_att = sum(c["variant"] != "control" for c in cases)
    print(f"{len(cases)} cases ({n_att} attacks, {len(cases) - n_att} controls): "
          f"{len(r.errors)} errors, {len(r.warnings)} warnings")
    if r.errors:
        sys.exit(1)
    if a.write_jsonl:
        lines = [json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in sorted(cases, key=lambda c: c["id"])]
        data = ("\n".join(lines) + "\n").encode("utf-8")
        Path(a.write_jsonl).write_bytes(data)
        print(f"wrote {a.write_jsonl} sha256={hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
