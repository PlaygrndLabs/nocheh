"""Telegram MarkdownV2 formatting and splitting for replies.

Copied from Hermes Agent (https://github.com/NousResearch/hermes-agent, revision 2bd378ed),
MIT License, Copyright (c) 2025 Nous Research. The permission notice is in the upstream LICENSE.
Code is unchanged except that methods became functions, so replies render exactly as before the
bot moved out of the Hermes container. Do not edit the copied functions; change them only together
with a deliberate formatting change.
"""
from __future__ import annotations

import re
from typing import Callable


_MDV2_ESCAPE_RE = re.compile(r'([_*\[\]()~`>#\+\-=|{}.!\\])')


def _escape_mdv2(text: str) -> str:
    """Escape Telegram MarkdownV2 special characters with a preceding backslash."""
    return _MDV2_ESCAPE_RE.sub(r'\\\1', text)


def _strip_mdv2(text: str) -> str:
    """Strip MarkdownV2 escapes and formatting markers for the plain-text fallback."""
    cleaned = re.sub(r'\\([_*\[\]()~`>#\+\-=|{}.!\\])', r'\1', text)  # escape backslashes
    cleaned = re.sub(r'\*\*([^*]+)\*\*', r'\1', cleaned)  # **bold** BEFORE MarkdownV2 *bold*
    cleaned = re.sub(r'\*([^*]+)\*', r'\1', cleaned)
    cleaned = re.sub(r'(?<!\w)_([^_]+)_(?!\w)', r'\1', cleaned)  # italic; word-bounded so snake_case survives
    cleaned = re.sub(r'~([^~]+)~', r'\1', cleaned)  # strikethrough
    cleaned = re.sub(r'\|\|([^|]+)\|\|', r'\1', cleaned)  # spoiler
    return cleaned


_CHUNK_INDICATOR_ON_FENCE_RE = re.compile(r'(?m)^``` (?P<indicator>(?:\\)?\(\d+/\d+(?:\\)?\))$')


def _separate_chunk_indicator_from_fence(text: str) -> str:
    """Move a ``(N/M)`` chunk marker that ``truncate_message()`` appended to a synthesized closing
    fence onto its own line — Telegram rejects ````` \\(1/2\\)`` as a fence."""
    return _CHUNK_INDICATOR_ON_FENCE_RE.sub(r'```\n\g<indicator>', text)


TABLE_SEPARATOR_RE = re.compile(r'^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$')


def is_table_row(line: str) -> bool:
    """Return True if *line* could plausibly be a table data row."""
    return '|' in line.strip()


def split_table_row(row: str) -> list[str]:
    """Split ``| a | b | c |`` into ``["a", "b", "c"]`` with trims."""
    return [c.strip() for c in row.strip().removeprefix("|").removesuffix("|").split("|")]


def _render_table_block(table_block: list[str]) -> str:
    """Render a GFM table as bold-heading + bullet groups (same alignment logic as Telegram's
    renderer: without a row-label column the full row is data and the heading bullet is skipped)."""
    headers = split_table_row(table_block[0]) if len(table_block) >= 3 else []
    if len(headers) < 2:
        return "\n".join(table_block)
    has_row_label_col = len(split_table_row(table_block[2])) == len(headers) + 1
    rendered_groups: list[str] = []
    for index, row in enumerate(table_block[2:], start=1):
        cells = split_table_row(row)
        if has_row_label_col:
            heading = cells[0] if cells and cells[0] else f"Row {index}"
            data_cells = cells[1:]
        else:
            heading = next((cell for cell in cells if cell), f"Row {index}")
            data_cells = cells
        data_cells = (data_cells + [""] * len(headers))[: len(headers)]
        bullets = [f"• {header}: {value}" for header, value in zip(headers, data_cells)
                   if has_row_label_col or value != heading]
        rendered_groups.append("\n".join([f"**{heading}**", *bullets]))
    return "\n\n".join(rendered_groups)


def convert_table_to_bullets(text: str) -> str:
    """Rewrite GFM pipe tables into bold-heading + bullet groups; fenced code is left alone."""
    if '|' not in text or '-' not in text:
        return text
    lines = text.split('\n')
    out: list[str] = []
    in_fence = False
    i = 0
    while i < len(lines):
        line = lines[i]
        is_fence_line = line.lstrip().startswith('```')
        in_fence ^= is_fence_line
        if not (in_fence or is_fence_line) and '|' in line and i + 1 < len(lines) \
                and TABLE_SEPARATOR_RE.match(lines[i + 1]):
            j = i + 2
            while j < len(lines) and is_table_row(lines[j]):
                j += 1
            out.append(_render_table_block(lines[i:j]))
            i = j
        else:
            out.append(line)
            i += 1
    return '\n'.join(out)


def fence_state_after(text: str, in_code: bool = False, lang: str = "") -> tuple[bool, str]:
    """Walk ``text`` line by line toggling on ``` lines; return the final (in_code, lang)."""
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```"):
            tag = stripped[3:].split()
            in_code, lang = (False, "") if in_code else (True, tag[0] if tag else "")
    return in_code, lang


def utf16_len(s: str) -> int:
    """UTF-16 code units in *s* — Telegram's 4 096 limit counts those, so astral chars
    (emoji, CJK Ext B) cost **two** units although Python's ``len()`` counts one.

    Ported from nearai/ironclaw#2304 which discovered the same discrepancy in Rust's ``chars().count()``.
    """
    return len(s.encode("utf-16-le")) // 2


def _custom_unit_to_cp(s: str, budget: int, len_fn) -> int:
    """Largest codepoint offset *n* with ``len_fn(s[:n]) <= budget`` (binary search)."""
    if len_fn(s) <= budget:
        return len(s)
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len_fn(s[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return lo


def truncate_message(content: str, max_length: int = 4096,
                     len_fn: Callable[[str], int] | None = None) -> list[str]:
    """Split a long message into chunks preserving code blocks: a split inside a fence closes it
    at the chunk end and reopens it (same language tag) in the next; multi-chunk output gets
    ``(1/3)`` indicators. ``len_fn`` overrides ``len`` (``utf16_len`` for Telegram)."""
    _len = len_fn or len
    if _len(content) <= max_length:
        return [content]
    INDICATOR_RESERVE = 10   # room for " (XX/XX)"
    FENCE_CLOSE = "\n```"
    chunks: list[str] = []
    remaining = content
    carry_lang: str | None = None  # language tag ("" ok) when previous chunk ended mid-fence
    while remaining:
        prefix = f"```{carry_lang}\n" if carry_lang is not None else ""
        # Body budget after prefix/fence/indicator; floored so a tiny max_length can't stall.
        headroom = max_length - INDICATOR_RESERVE - _len(prefix) - _len(FENCE_CLOSE)
        if headroom < 1:
            headroom = max(1, max_length // 2)
        # Remainder fits in one final chunk; close a reopened fence if still open.
        if _len(prefix) + _len(remaining) <= max_length - INDICATOR_RESERVE:
            final_chunk = prefix + remaining
            if carry_lang is not None and fence_state_after(remaining, True, carry_lang)[0]:
                final_chunk += FENCE_CLOSE
            chunks.append(final_chunk)
            break
        # Natural split (newline, then space); a custom _len budget maps to a codepoint offset.
        _cp_limit = (
            _custom_unit_to_cp(remaining, headroom, _len) if _len is not len else headroom)
        region = remaining[:_cp_limit]
        split_at = region.rfind("\n")
        if split_at < _cp_limit // 2:
            split_at = region.rfind(" ")
        if split_at < 1:
            # Floor at one codepoint: a zero _cp_limit (max_length 0/1, or a surrogate pair
            # wider than the utf16 budget) would never shrink ``remaining``; overshooting beats
            # a hang.
            split_at = max(1, _cp_limit)
        # Don't split inside an inline code span: an unpaired backtick breaks MarkdownV2.
        candidate = remaining[:split_at]
        backtick_count = candidate.count("`") - candidate.count("\\`")
        if backtick_count % 2 == 1:
            last_bt = candidate.rfind("`")
            while last_bt > 0 and candidate[last_bt - 1] == "\\":
                last_bt = candidate.rfind("`", 0, last_bt)
            if last_bt > 0:
                safe_split = max(
                    candidate.rfind(" ", 0, last_bt), candidate.rfind("\n", 0, last_bt))
                if safe_split > _cp_limit // 4:
                    split_at = safe_split
        chunk_body = remaining[:split_at]
        remaining = remaining[split_at:].lstrip()
        full_chunk = prefix + chunk_body
        # Walk only chunk_body (not the prepended prefix) for the fence state.
        in_code, lang = fence_state_after(chunk_body, carry_lang is not None, carry_lang or "")
        carry_lang = lang if in_code else None
        # Close the orphaned fence so the chunk stands alone.
        chunks.append(full_chunk + FENCE_CLOSE if in_code else full_chunk)
    if len(chunks) > 1:
        chunks = [f"{chunk} ({i + 1}/{len(chunks)})" for i, chunk in enumerate(chunks)]
    return chunks


def _escape_bare_bracket(m, seg: str) -> str:
    """Escape a bare ( ) { } unless it is already escaped or delimits a ``[text](url)`` link."""
    s = m.start()
    ch = m.group(0)
    if s > 0 and seg[s - 1] == '\\':  # already escaped
        return ch
    if ch == '(' and s > 0 and seg[s - 1] == ']':  # opens a link [text](url)
        return ch
    if ch == ')':  # closes a link URL? walk back matching depth
        before = seg[:s]
        if '](http' in before or '](' in before:
            depth = 0
            for j in range(s - 1, max(s - 2000, -1), -1):
                if seg[j] == '(':
                    depth -= 1
                    if depth < 0:
                        if j > 0 and seg[j - 1] == ']':
                            return ch
                        break
                elif seg[j] == ')':
                    depth += 1
    return '\\' + ch


def format_message(content: str) -> str:
    """Convert standard markdown to Telegram MarkdownV2: code is stashed behind placeholders first (never
    modified), markdown constructs become MarkdownV2 syntax, everything else is escaped."""
    if not content:
        return content
    placeholders: dict = {}
    counter = [0]

    def _ph(value: str) -> str:
        """Stash *value* behind a placeholder token that survives escaping."""
        key = f"\x00PH{counter[0]}\x00"
        counter[0] += 1
        placeholders[key] = value
        return key

    def _ph_wrap(open_: str, close: str):
        return lambda m: _ph(f"{open_}{_escape_mdv2(m.group(1))}{close}")

    # 0) Rewrite GFM-style pipe tables into Telegram-friendly row groups
    #    before the normal MarkdownV2 conversions run.
    text = convert_table_to_bullets(content)

    # 1) Protect fenced code blocks (``` ... ```)
    #    Per MarkdownV2 spec, \ and ` inside pre/code must be escaped.
    #    A fence still opens on its own line — the opening ``` must be the
    #    first triple-backtick run on that line and must end it — but the
    #    line may carry arbitrary leading whitespace (list/blockquote-
    #    nested code indents fences by 4+ spaces) or lead-in prose
    #    ("Here is the code: ```"), both of which the line-start-only
    #    anchor silently downgraded from <pre> to escaped literal text.
    #    Requiring the rest of the opening line to be backtick-free is
    #    what keeps *inline* triple backticks (e.g. "the syntax is
    #    ```x``` inline") out of the match: a closing run can never sit
    #    on the same line as the opener, and the tempered prefix cannot
    #    skip past an earlier run to a later one.  The closing fence must
    #    sit on its own line (any indent), with optional trailing
    #    whitespace and an optional ``\r`` so CRLF-terminated fences
    #    (Windows-authored content) match too.
    def _protect_fenced(m):
        prefix = m.group(1)   # lead-in text / indent before the opening fence
        opening = m.group(2)  # opening ``` (with optional language) and newline
        body = m.group(3)     # code body (may be empty)
        closing = m.group(4)   # closing fence (with its indent)
        body = body.replace('\\', '\\\\').replace('`', '\\`')
        return prefix + _ph(opening + body + closing)

    text = re.sub(
        r'(?m)^((?:(?!```)[^\n])*)(```[^`\n]*\n)([\s\S]*?)(^[ \t]*```)[ \t]*\r?$',
        _protect_fenced,
        text,
    )

    # 2) Protect inline code (`...`)
    #    Escape \ inside inline code per MarkdownV2 spec.
    text = re.sub(
        r'(`[^`]+`)',
        lambda m: _ph(m.group(0).replace('\\', '\\\\')),
        text,
    )

    # 3) Convert markdown links – escape the display text; inside the URL
    #    only ')' and '\' need escaping per the MarkdownV2 spec.
    def _convert_link(m):
        url = m.group(2).replace('\\', '\\\\').replace(')', '\\)')
        return _ph(f'[{_escape_mdv2(m.group(1))}]({url})')

    text = re.sub(r'\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)', _convert_link, text)
    # 4) Headers (## Title) → bold *Title*, stripping redundant ** inside the header
    def _convert_header(m):
        inner = re.sub(r'\*\*(.+?)\*\*', r'\1', m.group(1).strip())
        return _ph(f'*{_escape_mdv2(inner)}*')

    text = re.sub(r'^#{1,6}\s+(.+)$', _convert_header, text, flags=re.MULTILINE)
    # 5) Bold **text** → *text*; 6) Italic *text* → _text_ ([^*\n]+ keeps matches on one line, or *
    # bullet lists corrupt); 7) Strikethrough ~~text~~ → ~text~; 8) Spoiler ||text|| kept as-is.
    text = re.sub(r'\*\*(.+?)\*\*', _ph_wrap('*', '*'), text)
    text = re.sub(r'\*([^*\n]+)\*', _ph_wrap('_', '_'), text)
    text = re.sub(r'~~(.+?)~~', _ph_wrap('~', '~'), text)
    text = re.sub(r'\|\|(.+?)\|\|', _ph_wrap('||', '||'), text)
    # 9) Blockquotes: protect leading > from escaping; expandable quotes (**> starts, trailing || ends).
    def _convert_blockquote(m):
        prefix, content = m.group(1), m.group(2)  # prefix: >, >>, >>>, **>, **>> …
        if prefix.startswith('**') and content.endswith('||'):
            return _ph(f'{prefix} {_escape_mdv2(content[:-2])}||')
        return _ph(f'{prefix} {_escape_mdv2(content)}')

    text = re.sub(r'^((?:\*\*)?>{1,3}) (.+)$', _convert_blockquote, text, flags=re.MULTILINE)
    # 10) Escape remaining special characters in plain text
    text = _escape_mdv2(text)
    # 11) Restore placeholders in reverse insertion order so nested placeholders resolve.
    for key in reversed(list(placeholders.keys())):
        text = text.replace(key, placeholders[key])
    # 12) Safety net: escape bare ( ) { } that slipped through, but never inside ``` or ` spans.
    _safe_parts = []
    for _idx, _seg in enumerate(re.split(r'(```[\s\S]*?```|`[^`]+`)', text)):
        if _idx % 2 == 1:
            _safe_parts.append(_seg)  # inside code — untouched
        else:
            _safe_parts.append(re.sub(r'[(){}]', lambda m, _seg=_seg: _escape_bare_bracket(m, _seg), _seg))
    return ''.join(_safe_parts)
