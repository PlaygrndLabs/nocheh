# Dashboard redesign plan

Status: accepted by the owner on 2026-10-12. Steps 1 (groundwork), 2 (navigation), 3 (Chats & access) and 4 (Settings sections) are implemented; step 5 is pending. Step 2 folded Graph into Memory and Imports into Archive. Step 3 replaced Sharing with Chats & access, moved group people, topics and topic memory there from Settings, and sends memory-access request links to the Inbox.

## What makes the dashboard hard to use today

I ran the dashboard with synthetic data and went through every page and the code behind it.

1. **Too many places, grouped by system parts instead of tasks.** The sidebar has 13 pages in three groups (Knowledge, Operations, Manage). The page you need most, the decisions inbox, is hidden as the first tab of "Activity" under "Operations". "Databases" (a developer tool) sits at the same level as "Archive". "Graph" and "Memory › Relations & access › Map" both draw the same relationships.
2. **Memory access is spread over six places**, and none of them answers "what can this group see?":
   - Settings › Telegram access: which groups Nocheh is in, who may talk to it in each group, reply mode.
   - Settings › Telegram groups: the topic list.
   - Sharing: rules that let one chat use another chat's knowledge, previews and "released text".
   - Memory › Relations & access: approved facts, pending requests, and (folded away at the bottom) request defaults per group or topic.
   - Activity › Decisions: the same memory-access requests again.
   - A "conversation context" drawer that only opens from Sharing and Projects.
   - Soon also the "share memory across topics" switch from the topic-sharing work.
3. **Settings is one very long page** (about 3,500 px on a laptop). Telegram, models, speed and advanced options share one review/save/apply flow, then two more panels below it save on their own, and Hermes preferences hide in a second tab. Groups are typed as comma-separated numeric IDs.
4. **Internal words everywhere**: "Guard", "Owner freedom", "Released representations", "workflow families", "uncertain effects", "Preparing current sources", "Honcho" without saying it is long-term memory.
5. **Overview shows system counters** (records, files, running workflows) rather than what needs you.

### Code problems behind it

- Half the pages are plain JavaScript built with `h(...)` calls, half are React TSX; 119 lines are longer than 400 characters, so pages are hard to read and change.
- Two big files carry too much: `pages/memory-map.tsx` (44 KB) and `pages/settings.js` (36 KB). All styling is one 107 KB `style.css`.
- `pages/access.js` and `pages/access-controls.js` (18 KB) are not used by any page.
- API paths are strings scattered through pages, with `any` types.
- Most dashboard tests check page source text with regular expressions, so any rename or move breaks them without telling us whether the page works.

## New layout

Eight sidebar items, named by what you do:

| Page | What it is for | Comes from |
| --- | --- | --- |
| **Home** | What needs you now (decisions waiting, problems), a one-line health strip, shortcuts | Overview |
| **Inbox** | Decisions to approve (actions, memory-access requests, suggestions), then history and run history | Activity |
| **Chats & access** | Every private chat, group and topic in one list; the place to manage memory access | Sharing, Settings › Telegram groups and people, Memory › access tabs, Activity › Permissions |
| **Memory** | What Nocheh knows: notes, learned facts, people and projects (list or map), long-term memory (Honcho) status and budget | Memory, Graph |
| **Archive** | Original messages and their editable copies; imports as a tab | Archive, Imports |
| **Projects** | Projects, which chats belong to them, project memory | Projects (unchanged in purpose) |
| **System** | Health and monitoring, connections (Hermes, providers), databases, backups and maintenance | Monitoring, Integrations, Databases, Maintenance |
| **Settings** | Only installation settings, split into short sections | Settings |

### Chats & access (the memory access page)

A list of chats on the left (private chat, each group, its topics under it, searchable, names not IDs). Picking one shows three plain cards:

1. **Who can talk to Nocheh here**: on/off for this group, reply mode (only when addressed / every message), people allowed or denied, names that address Nocheh.
2. **What Nocheh remembers here**:
   - this chat's own memory;
   - for a group, "topics share memory" (the switch from the topic-sharing work, folded in after that PR merges);
   - other chats whose knowledge this chat may use (today's sharing rules), with a preview of exactly what would be shared;
   - facts you approved for this chat, each with revoke, and one-time vs. always;
   - pending requests for this chat, with approve or deny.
3. **What Nocheh may do here**: standing permissions for actions.

Two more tabs on the page: **Shared facts** (all approved facts across chats, revoke) and **Defaults** (request suggestions, default approval type, request lifetime, notifications). Adding a group or an older topic happens here too, by picking from observed groups or pasting a Telegram link.

This reuses the existing "effective conversation context" API, so the backend change is small: one read that also returns the topic-sharing state and the approved facts for that chat.

### Settings sections

A short section list on the left (tabs on phones), one form per section, and one bar at the bottom that shows "unsaved / saved / applied" with Save and Apply buttons:

- **Telegram bot**: enabled, owner, bot token.
- **Models**: reasoning model, embedding model, voice transcription status.
- **Speed**: parallel runs, chats answered at once, guard checks at once.
- **Privacy**: secret guarding (renamed "Hide secrets from agents").
- **Assistant behaviour**: how much Nocheh may do without asking (today "Owner freedom"), Hermes preferences and per-profile overrides.
- **Advanced**: destinations, connections, internal credentials.

Group and people settings move to Chats & access. Every setting that exists today stays reachable.

## Refactor

- Convert every page to TSX, one component per file, readable line lengths; split `memory-map.tsx` and `settings.js` into small pieces.
- One typed API client (`dashboard/lib/api.ts`) used by all pages.
- Shared building blocks: page header, section card, chat picker, settings form with save/apply bar, access card.
- Split `style.css` by area and move simple layout to Tailwind classes.
- Delete the unused access pages.
- Replace the source-text tests with real checks: a browser smoke test that opens every page on the synthetic preview and fails on errors or missing key controls, plus unit tests for the small logic helpers. The preview already exists (`test/dashboard-preview.ts`) and runs in the cloud with a local PostgreSQL, no Docker needed.
- Plain-language pass on all labels.
- Update the Dashboard areas of `SPECS.md` with each PR (the current specs name Sharing, Activity and the Memory tabs as fixed destinations).
- Old bookmarks: keep a few cheap redirects (for example `#sharing`, `#activity`, `#monitoring`), drop the rest since this is development mode.

## Order of PRs

1. **Groundwork** (no visible change): TSX conversion, typed API client, delete unused pages, browser smoke tests replacing source-text tests.
2. **New navigation**: eight-item sidebar, Home, Inbox, System page with tabs, plain labels.
3. **Chats & access**: the memory access page, folding in Sharing, groups, people, approved facts and requests. Topic-sharing switch added as soon as that PR is merged.
4. **Settings**: sections and one save/apply bar.
5. **Memory and Archive tidy-up**: Graph inside Memory, Imports inside Archive, phone layout pass.

Each PR comes with screenshots from the synthetic preview. You see the change on your machine after it is merged and the dashboard restarts.
