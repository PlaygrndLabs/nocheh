# ADR-0263: Only addresses no model built open without a card

<status>
Accepted on 2026-11-19, as the fourth set of fixes from the review of how text
from outside reaches Nocheh (risk 2, "Do what I ask"; risk 7, "Always allow this
site"; and the Notion "Nothing asks me" item). The owner approved each fix with
what it would lose on 2026-11-14 ("all yes"), and on 2026-11-19 chose that any
outside tool may get "Always allow this tool", covering later calls with short
input only. Amends [ADR-0214](0214-allow-a-site-or-command-in-one-chat.md)
(site rules on shared sites, rules for another server's tools),
[ADR-0225](0225-member-safety-rules.md) (Notion under Nothing asks me and Notion's
own fetching paths) and [ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md)
(what the owner freedom setting runs).
</status>

<context>
- With "Do what I ask" on, every web read and outside tool the model asked for
  in the owner's private chat ran without a card. A forwarded message or a page
  Nocheh read could steer the model to put the owner's data in an address and
  send it anywhere.
- A site rule covered every address on its site. On a shared or send-to site,
  such as Google Forms, Apps Script or a webhook service, that let any document
  there collect data. An address can also carry another address, which a proxy
  site then fetches.
- An outside tool had no rule, so with the setting off it asked on every call.
- Under Nothing asks me, every Notion tool ran without a card, including an
  outside read the model chose, an image or embed whose address carries data
  (Notion or the viewer's browser fetches it), calendar invites and Notion AI
  agents. Notion's own `/image/` and `/signed/` paths fetch another address too.
</context>

<decision>

## One address check

- `src/link-check.ts` decides it for "Do what I ask", chat rules, tool rules and
  Notion, so they cannot drift apart. An address is compared as its parser
  writes it, as https and without a fragment.
- An address carries data when more than 200 characters follow its site, or its
  path or query holds another address: one with a scheme, `//site`, or a bare
  site followed by a slash, also after percent escapes are undone again and
  again; or a query value that is a bare site.
- Shared, send-to and proxy sites are a built-in list (Google Docs, Drive, Forms,
  Apps Script and Sites, Microsoft Forms, webhook, hook, paste, archive, reader
  and tunnel services, ntfy, the Telegram bot API). A list cannot be complete; the
  data check covers what it misses.

## "Do what I ask"

- Commands the owner asks for in their private chat run as before. A web read,
  or another server's list of tools, runs without a card only when no model
  built its address (`controlled_actions.free_read`):
  - `typed`: exactly a link in the owner's own message, from Telegram's link
    entities or its text, never a quoted reply; a dashboard message's own text.
  - `forwarded`: exactly a link in a forward or an inline bot's message with at
    most 2 links. Its words name no site. A forward of the owner's own message is
    `typed`.
  - `page`: exactly a link on a page opened for the same message, resolved
    against that page. A page whose address a model built (by a rule or a card)
    gives no link that repeats 8 or more characters of that address.
  - `named`: a site the owner named in their own words, never inside an email
    address and never a shared site, bare or with a path and search (`q`,
    `query`, `search`, `s`, `term`, `text`, `keyword(s)`) made only of words the
    owner typed, carrying no data.
- Any other address asks with its card and rule buttons. Another server's tool
  call always asks unless a rule covers it.
- One message opens at most 10 reads without a card, at most 5 of them `page`;
  reads a rule covers count too (`rule`). Past that, a read asks and its card
  offers no rule. Members' group web reads (ADR-0260) are unchanged.

## Rules

- A web read's rule still covers its whole site. On a shared site it covers one
  file: a Google document, form, Drive file or folder, Apps Script or Site by its
  id, else the first path part, with a button "Always allow this file where
  asked"; a shared site with no file has no rule. An address that carries data
  has no rule key, so no rule covers it, its card offers none, and a new rule
  releases no such waiting read.
- Another server's tool gets "Always allow this tool where asked" (30 days),
  keyed by its exact server address and tool name. It covers a call only when the
  call's input has plain keys, at most 20 values, each text at most 200 characters
  with no address, at most 4 levels and 2,000 characters in all, and the server
  address carries no data. A list of tools and Notion have no rule.
- Above the buttons, a fixed owner-editable line says what the rule allows
  (`site_note`, `document_note`, `tool_note`), with `rule_note` after it in a
  group. A card the lines do not fit offers no rule.

## Notion under Nothing asks me

- In a live private turn it covers Notion's page tools only: its reads, saving,
  editing, moving, copying, deleting and restoring pages, databases, data sources
  and views, and comments. Calendar, AI agents, uploads and any tool Notion adds
  later ask.
- A read of an outside address runs only when the owner gave that exact address
  this turn (typed, or forwarded with at most 2 links).
- A change runs only when each outside address in it is one the owner gave, or a
  plain link of at most 200 characters carrying no data: a Markdown link or bare
  text, never an image, an attribute such as an embed's or a file's source, or a
  whole field such as a cover.
- `notion.so/image/…` and `notion.so/signed/…` are outside addresses everywhere.

</decision>

<consequences>
- Research and links the owner sends keep working in one reply. An address the
  model builds for a new site costs one tap the first time, with "Always allow
  this site".
- An outside tool asks once per tool, as long as its input stays short.
- A rule on a shared site costs one tap per file. A long or address-carrying
  address always asks.
- What still leaks without a card: on a site the owner allowed, up to 200
  characters a read and 10 reads a message; which links on a page the model
  picks; data in an address the check does not recognise, such as base64 on a
  proxy site that is not on the list.
- Under Nothing asks me, an outside image, embed or read the owner did not send,
  calendar and AI agents cost a card.
</consequences>
