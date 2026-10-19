# Nocheh: a personal AI brain you talk to on Telegram

**It remembers what you tell it, and everything it knows stays yours.** Nocheh saves every message in an archive you own, learns what matters from your conversations, and answers with what it remembers, in your private chat and in the groups you pick.

## Why Nocheh

Chat assistants either forget what you told them last week or keep it in someone else's cloud. Your conversations are the most useful record you have, and they end up scattered, locked in, or gone.

Nocheh turns your Telegram into a memory you own. The originals stay in an archive you control, the AI parts can be swapped, and you decide what it may use, what it may share, and what it may do.

## What Nocheh does for you

- **Lives in Telegram.** Talk to it privately like a person. Add it to groups and it answers only when addressed: a reply, an @mention or one of its names ("Nocheh" and "نوچه" by default). It still saves everything else said there.
- **Keeps everything.** Every message, edit, reaction, file and delivered reply is saved before any AI work starts, so a slow or broken model never loses a message. Data is kept forever unless you set a limit.
- **Remembers.** Honcho long-term memory learns facts from your conversations, and each chat keeps its own Hermes notes. A group recalls only its own conversations plus facts you approve to share.
- **Masks secrets.** A secret check finds passwords, keys and tokens and masks them before the agent, memory or search ever sees them. You can review and edit every masked copy.
- **Asks before it acts.** Sending a Telegram message somewhere else or running a shell, browser or MCP tool is proposed first. You approve it in the dashboard's Inbox or in your private chat.
- **A role and skills per chat.** Give each group its own role and skills from the dashboard. Only you can change them; the agent can only update its notes.
- **Forget on request.** Retire any message and Nocheh stops using it, including in what it learned. The original stays in your archive, and Undo brings it back.
- **Your models, your keys.** Use Anthropic, OpenAI or your own gateway (any OpenAI-compatible HTTPS address). Pick one default model, or a different one for replies, memory and the secret check. Keys stay on the server, and the Usage page shows what each part costs and how fast it answers.
- **Nothing hard-coded.** Every instruction Nocheh gives a model is editable in Settings › Assistant and can be reset to its default.
- **Yours to take with you.** Import Telegram Desktop exports, export everything in a portable format, and back up or restore the whole installation from the dashboard or the command line.

## Quick start

You need Docker with Compose, Node 24 and Python 3, a Telegram bot token from [BotFather](https://t.me/BotFather), a model provider key, and an OpenAI API key for memory search.

1. Install and create your local settings. `init` writes an ignored `.env` with generated internal passwords:

   ```bash
   npm ci
   ./bin/nocheh init
   ```

2. Start Nocheh. `make dev` runs the whole stack and reloads it when the code changes:

   ```bash
   make dev
   ```

3. Open the dashboard at <http://127.0.0.1:8783/>.
4. In **Settings › Models**, add a provider and choose the default model. Until then, replies and memory wait.
5. In **Settings › Telegram**, turn Telegram on and paste the bot token and your numeric Telegram user ID. To find the ID, message your bot and run `./bin/nocheh discover-telegram` while Telegram is still off.
6. Message your bot. To use a group, add the bot there, then pick the group and who may talk to Nocheh in **Chats**.

Full setup: [Telegram](docs/telegram.md), [model providers](docs/provider.md) and [operations](docs/deploy.md).

## Day to day

```bash
make dev-status          # is the stack running?
make dev-stop            # stop it; your data stays
make dev-build           # rebuild after dependency or Dockerfile changes
./bin/nocheh up          # run in the background without watching the code
./bin/nocheh status      # each service and its state
./bin/nocheh diagnose    # health, credentials present, stuck jobs
./bin/nocheh backup      # back up the archive, memory and settings
./bin/nocheh down        # stop everything; your data stays
```

The dashboard has Home, Inbox (approvals), Chats, Messages, Memory, Usage, System (health, backups, databases) and Settings. Hermes' own dashboard opens from the sidebar.

## How it works

```
Telegram ──► Hermes ──► nocheh-app ──► archive (PostgreSQL)
                            │
                            ▼
                     Inngest workflow ──► secret check ──► Honcho memory
                            │
                            ▼
              Hermes turn in an isolated container ──► reply in Telegram
                            │
                            └─► security broker ──► your model provider
```

Hermes receives a message and hands it to Nocheh, which saves it before anything else. A durable Inngest workflow prepares the masked copy, recalls what Honcho and the chat's notes know, and runs the reply as an isolated Hermes turn. Model calls leave only through the security broker, so agents never hold your keys.

## Under the hood

Nocheh is TypeScript services, a React dashboard and a thin Python plugin for Hermes, all in one Docker Compose project.

- **Three databases.** `nocheh_archive` keeps original messages and files and is never rewritten. `nocheh_derived` keeps masked copies and everything generated. `nocheh_control` keeps settings, access rules, approvals and jobs. Hermes, Honcho and Inngest keep their own stores.
- **Capture first.** Incoming Telegram updates land in a durable spool before they are acknowledged, then commit once. Restarts, retries and database outages don't drop or duplicate messages.
- **Workflows.** Inngest runs every reply, learning and import as a durable workflow with retries, waits and full history.
- **Runtime.** [Hermes](https://github.com/NousResearch/hermes-agent) is the agent runtime and owns Telegram, sessions, schedules and per-chat roles, skills and notes. It is the first runtime, not the only one: the archive is portable across runtimes.
- **Memory.** [Honcho](https://github.com/plastic-labs/honcho) is the long-term memory, behind a swappable boundary, using Honcho's own model of people and sessions.
- **Isolation.** Agent turns run in containers with one profile and scoped access: no provider keys, no Docker socket and no unrestricted internet. Approved shell work runs in disposable containers with no network.
- **Approvals.** Every external effect records its proposal, approval, start and result separately. An uncertain send is never repeated automatically.

Service map: [docs/services.md](docs/services.md).

## Good to know

- Nocheh answers only while its services are running. Telegram holds new messages for up to 24 hours, so short breaks lose nothing.
- Dependable answers come before speed. A reply usually takes around half a minute.
- Voice notes are saved but not transcribed.
- No local models. You pay your model provider for replies and learning, plus OpenAI embeddings for memory search.
- Nocheh is in development and not released yet. Live release checks are tracked in [docs/mvp-acceptance-status.md](docs/mvp-acceptance-status.md).

## Develop

```bash
npm ci
./bin/nocheh test        # PostgreSQL, TypeScript and Python integration tests
```

[SPECS.md](SPECS.md) defines what Nocheh must be and do, [TASK.md](TASK.md) tracks status and open checks, and [AGENTS.md](AGENTS.md) holds the working rules. Decisions live in the [ADRs](docs/adr/README.md), and [docs/repository-layout.md](docs/repository-layout.md) explains every folder. Agent skills for [admin inspection](.agent/skills/nocheh-admin-cli/SKILL.md), [deployment](.agent/skills/nocheh-deploy/SKILL.md) and [Graphify](.agent/skills/graphify/SKILL.md) live in `.agent/skills`. Code from before Hermes is kept on the `archive/pre-hermes-nocheh` branch.
