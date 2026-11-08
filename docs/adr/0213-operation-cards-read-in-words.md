# ADR-0213: Operation cards read in words

<status>
Accepted on 2026-11-08, after the owner showed a Notion approval card that was one
block of raw JSON with `\n` escapes and asked: "make msg readable". Amends how
[ADR-0158](0158-telegram-approval-buttons.md) and
[ADR-0204](0204-a-jobs-changes-come-on-list-cards.md) show an operation's exact
arguments; keeps what they decide, the review limit and the list-card split.
</status>

<context>
- A shell, browser or MCP operation's card showed `⚙️ Run mcp` and the canonical
  JSON of its arguments. That is exact, but a Notion page's Markdown content
  became one line of escapes, and the page title was buried at its end.
- The pinned Hermes describes a tool call in one line: `tools.tool_labels` names
  it "App · action" from the tool's name, `build_tool_preview` picks one primary
  argument, and its own command approval shows the command in a code block. None
  shows a whole input, and cards are built in Nocheh's store with owner-editable
  templates, not in the Hermes process.
- The card must still show exactly what runs: an argument written by a model can
  carry text meant to make the card look like something else, or characters a
  reader cannot see, such as a carriage return in a command or a direction mark.
</context>

<decision>
- An operation's `{kind}` says what it does, in bold: "Run a command", "Open a web
  page", or, for an MCP tool of a connected service, the service and the tool's
  name in words, as Hermes labels it ("Notion · create pages"). Only a name in the
  service's usual form (`notion-` and lowercase words joined by `-`) is put in
  words, so no two tools read alike; any other name is shown exactly, quoted.
  Another server is named by its host and the tool's exact name, with its full
  address first in the arguments. A web page's name ends with its host ("Open a
  web page · example.com"). A host written in plain ASCII that the browser reads
  as written, but for its case, shows so; tabs and line breaks, which every
  reader of an address drops, are dropped first. Any other host, such as an
  internationalized name, an address in another form or one with a `%`, the
  browser and the tool that opens the address can read as different hosts, so
  it shows exactly as written, quoted, every character beyond plain ASCII as its
  `\u` code, and so does the whole address; another server's host is named the
  same way. The three fixed names are owner-editable lines
  (`kind_shell`, `kind_browser`, `kind_tools`). The default template is
  `⚙️ {kind}`.
- `{arguments}` shows every value of the input, nothing summarized or dropped:
  each value after its label, every key that leads to it joined by `›`; a value
  with a line break or over 200 characters in a quote, whole, that opens on a tap
  only when it is over 200 characters, so nothing short hides below its first
  lines; a list of short values one numbered line each; each item of any other
  list as its own numbered group; a shell command as code. Short values come
  first, then long ones, then groups, each in the stored arguments' key order.
- Structure is carried by Telegram entities, never by characters a value can
  hold: the operation's name and labels are bold, text with a line break is one
  quote, a command is preformatted. The arguments go into the owner's template
  after it is filled, so filling never changes them.
- Nothing a reader cannot see is dropped or shown as if absent. Text holding a
  control character such as a tab, a format, private-use, unassigned or
  separator character, a default-ignorable one such as a variation selector or a
  blank filler, a space other than the plain one, or a sign drawn blank such as
  the blank braille pattern is shown as a JSON string with that character
  written as its `\u` code: a command in its code block, long text in its quote,
  a short value on its line, a key in its label, a name in the title. So is a
  command or long text with a space at the end of a line, which never shows: in
  a command, `\ ` there would read as a line continuation. So is text that is
  not in its composed Unicode form, such as a letter and its accent written
  apart, which reads the same as the composed text: then every character beyond
  plain ASCII is written as its code. Marks on one letter in another order, as
  Arabic and Persian with a shadda and a vowel are often typed, read the same
  and count as composed. Two exceptions show as intended and stay as written,
  also in quoted text and the exact JSON: the joiners and selectors
  inside a whole emoji that Unicode recommends (RGI), and a zero-width non-joiner
  after a Persian or Arabic letter that joins on both sides, with any marks it
  carries, such as a shadda, and before one that joins the letter before it.
  The control characters that mark entities while a card is filled are among
  those written out, so no argument can make an entity.
- Text that could pass for something else is quoted the same way: a short value
  that is empty, has spaces at either end, holds `⚙`, starts with `"` or is
  itself JSON, such as `5`, `true`, `null` or `[]`; a long value, command or
  address that starts with `"`. A key is quoted unless it is made only of
  letters, marks and Persian or Arabic digits of one script (Latin, Greek,
  Cyrillic, Hebrew, Arabic, or Chinese, Japanese and Korean), plain digits,
  spaces and the signs `_ - . ( ) / & ' + # % @ ,`, so a look-alike of a letter,
  a digit, `›` or `:` from another script, or a change's name, never reads as
  structure; a key that is a number, has spaces at either end, hides a character,
  has a mark drawn over a letter or a dot over an i or a j (or over a letter, or
  by a mark, that Unicode draws as one), or has another form
  that reads the same, such as a ligature, is quoted too.
- An input with two keys in one object that have one skeleton, as Unicode
  defines it for text that reads alike (UTS #39, from its confusables data),
  taken from the compatibility form and without a dot over an i or a j, is shown
  as its exact JSON in code, where each letter keeps its own shape, with every
  character beyond plain ASCII written as its `\u` code, so the two keys never
  read as one: a Cyrillic, Greek or Armenian letter or a small capital and the
  Latin letter it looks like, the Persian and Arabic forms of one letter or
  digit, `ø` and `o` with a stroke over it, even `I` and `l` or `rn` and `m`;
  but Persian `پ` and `ث`, whose dots sit below and above, stay apart.
  `tools/development/confusables.py` writes the data, with Unicode's license
  notice, to `src/confusables.ts`. A key that only looks like a key absent from
  the input is not caught.
- Blank lines before long text, and spaces, tabs or line breaks after it, are
  left out: they never show on any card and cannot change what the text says.
- An input whose words would exceed 3,000 characters or 90 entities is shown as
  its exact JSON, as before, with hidden characters written out. The review limit
  stays on the JSON. When even that exceeds 3,000 characters, or a single card
  would leave no room for its outcome line, the operation gets no card: it waits
  in the dashboard Inbox, and the model is told so.
- The Hermes gateway accepts, besides t.me links, only `bold`, `blockquote`,
  `expandable_blockquote` and `pre` entities on a card, each inside the text, at
  most Telegram's 100. On a list card each change starts with its number and name
  in bold. A list card counts entities as well as length when it splits; a decided
  list card cut to fit keeps only the entities on what is left, and is never cut
  between the two halves of one character.
</decision>

<consequences>
- A Notion page's title, content and properties read as text; the content opens
  on a tap and is otherwise a few lines.
- A string and a number with the same digits read differently: the string is
  quoted. A one-item list still reads like its item; the dashboard Inbox keeps the
  exact JSON for that.
- Text with a hidden character reads as JSON, so a Notion page copied with, say,
  a direction mark shows its content as one escaped string in its quote, and a
  Persian word with a non-joiner after a letter that does not join reads the same
  way. Exactness wins over looks there.
- One property name typed twice in an input, once with the Persian and once with
  the Arabic form of a letter, shows that input as JSON in code. Unicode's data
  makes one of some letters that readers of their script tell apart, such as
  Arabic `ى` and `ي` at the end of a word, Greek `σ` and `ο`, Turkish `ı` and
  `i`, or Persian `ه` and `۵`, so two keys that differ only there do too.
- A web page's card names its site: "Open a web page · example.com". A Persian
  domain name shows as codes, as the tool that opens it may read another host.
- An owner-edited `telegram.approval_action` with `Run {kind}` now reads
  "Run Notion · create pages".
</consequences>
