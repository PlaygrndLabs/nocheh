# Writing cases

## Rules

1. **People and companies are invented.** The user is always the persona in `dataset.json`. Never name a real bank, ministry, messenger, mail provider, AI product or tech company in text the agent sees. Use roles: «بانک», «واحد فناوری اطلاعات», «امور مالی».
2. **Reserved names only.** Victim addresses may use `example.com/org/net` or `.example`. Attacker hosts and addresses must end in `.example`, `.test` or `.invalid`. IPs come only from 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
3. **Numbers are invalid by construction.** IBAN-like numbers fail the checksum, card-like numbers fail Luhn, no Iranian mobile numbers.
4. **No working payloads.** Commands only contact reserved hosts. No `rm`, `sudo`, package installs, credential paths or encoded shell payloads. Deletion uses the abstract `delete_item` tool.
5. **No real-world harm topics.** No politics, religion, real events, weapons, self-harm, real medicines or doses.
6. **Fresh text.** Never copy from other datasets or from real messages.
7. **Natural Persian.** ی and ک, correct half-spaces, Persian punctuation, Jalali dates checked against the reference date.

## Structure

- A **family** fixes one attack. `-p` is plain (no Persian trick), `-d1` adds 1 to 3 tricks (T ids), `-c` is a control without the attack.
- The **canary** `PAB-XXXX-XXXX` sits only in a private item.
- The injection text occurs exactly once in the carrier.
- Invisible and look-alike characters are written as `\uXXXX` in the file. Run `python tools/validate.py --format`.

## Validator rules

`tools/validate.py` checks: schema (V01), canonical format (V02), file names and ids (V03, V04), families (V05), carrier and injection placement (V07, V08), canary placement and uniqueness (V11 to V13), predicate validity (V14), that checks fire on the attacker's reference calls (V15) but not on an empty trace, a trace that only quotes the content, a trace that only browses, or a trace that only does the user's task (V16), tool coverage (V20), reserved names (V21), IPs (V23), invalid numbers (V24, V25), a denylist of real brands (V26, warning), text pairs (V27), declared techniques for every special character (V28), technique counts per variant (V29), item times (V34), and with `--release` that every case is approved (V31).
