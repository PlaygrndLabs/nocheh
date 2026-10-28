<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/nocheh-logo-dark.svg" />
    <img src="docs/assets/logo/nocheh-logo-light.svg" alt="Nocheh" width="220" />
  </picture>
</p>

# Nocheh: a personal AI brain that you own

**Your data, your memory and the reasoning over them, owned by you.** Nocheh keeps what you and the people around you say in an archive you own, turns it into memory, and reasons over it to answer, organize and act for you. Chat apps, the agent runtime and the memory engine are replaceable parts around it.

## Why Nocheh

Today's AI assistants are rented brains. What they learn about you lives inside one app, one model and one company's memory, and switching tools means starting over.

Nocheh turns that around. The source data is yours and portable, memory is built from it and can be rebuilt from it, and everything around it can be replaced. Telegram is the first chat adapter, Hermes is the first agent runtime, and Honcho is the current long-term memory. You decide what Nocheh may use, what it may share and what it may do.

## What Nocheh does for you

- **Owns the source.** Every message, edit, reaction and file it sees is saved as an original, with where it came from, before any AI work starts. A slow or broken model never loses anything, and data is kept forever unless you set a limit.
- **Remembers people and projects.** Honcho long-term memory learns facts about people and projects, and each chat keeps its own Hermes notes. Who said something, and whether it was said, reported or inferred, stays attached.
- **Understands context.** It learns how a group works, like a ✅ reaction meaning "done", and follows the state of tasks and commitments even when it doesn't reply. You can inspect and correct what it learned.
- **Organizes knowledge.** With your permission it groups conversations into projects, and the dashboard shows people, projects and facts as a map you can edit.
- **Keeps audiences apart.** A group recalls only its own conversations plus facts you approve to share. Your private chat can use everything.
- **Masks secrets.** A secret check finds passwords, keys and tokens and masks them before the agent, memory or search ever sees them. You can review and edit every masked copy.
- **Asks before it acts.** Sending a message somewhere else or running a shell, browser or MCP tool is proposed first. You approve it in the dashboard's Inbox or in your private chat.
- **Forgets on request.** Retire any message and Nocheh stops using it, including in what it learned. The original stays in your archive, and Undo brings it back.
- **Meets you where you talk.** Today that is Telegram: privately, and in the groups you pick, where it answers only when addressed (a reply, an @mention or one of its names) and quietly saves the rest.
- **A role and skills per chat.** Give each group its own role and skills from the dashboard. Only you can change them; the agent can only update its notes.
- **Your models, your keys.** Use Anthropic, OpenAI or your own gateway (any OpenAI-compatible HTTPS address). Pick one default model, or a different one for replies, memory and the secret check. Keys stay on the server, and the Usage page shows what each part costs and how fast it answers.
- **Nothing hard-coded.** Every instruction Nocheh gives a model is editable in Settings › Assistant and can be reset to its default.
- **Yours to take with you.** Import chat history (Telegram Desktop exports today), export everything in a portable format, and back up or restore the whole installation.

## Quick start

You need Docker with Compose, Node 26 and Python 3, a model provider key, and an OpenAI API key for memory search. To talk to Nocheh through Telegram, you also need a bot token from [BotFather](https://t.me/BotFather).

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
5. Connect a chat adapter. For Telegram, open **Settings › Telegram**, turn it on, and paste the bot token and your numeric Telegram user ID. To find the ID, message your bot and run `./bin/nocheh discover-telegram` while Telegram is still off.
6. Say hello in your private chat. To bring Nocheh into a group, add it there, then pick the group and who may talk to it in **Chats**.

Full setup: [Telegram](docs/telegram.md), [model providers](docs/provider.md) and [operations](docs/deploy.md).

## Use it

- **Ask what you know.** "What did Sara say about the launch?" or "What's still open on the website project?" Nocheh answers from your archive and memory, within what that chat is allowed to see.
- **Let it follow along.** In groups it listens quietly, learns who is doing what and keeps track of tasks, even when nobody asks it anything.
- **Ask it to act.** "Tell the design group the meeting moved to 4" becomes a proposal you approve before anything is sent.
- **Bring in your history.** Import old chats and choose whether Nocheh may learn from them.
- **Look inside its head.** The dashboard shows what it knows and why: **Memory** for people, projects, facts and notes, **Messages** for every original, **Inbox** for what waits on you, **Chats** for who can see what, **Usage** for cost and speed, **System** for health and backups, and **Settings** for models, adapters and every instruction.
- **Correct it.** Fix a fact, rename a person, retire a message or undo an organization change. Nocheh rebuilds the affected memory from what remains.

## Run it

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

## How it works

Every message goes through four steps. Capture keeps working even when everything else is down, and the rest runs as durable [Inngest](https://www.inngest.com) workflows with retries and history:

1. **Capture.** An adapter (Telegram today, through Hermes) hands each message to Nocheh, which saves the original before anything else and prepares a masked copy.
2. **Learn.** In the background, Honcho learns about people and projects, and Nocheh learns conventions and the state of tasks, whether or not a reply is needed.
3. **Reason.** When Nocheh is addressed, an isolated Hermes turn answers with what that chat may recall. Model calls leave only through the security broker, so agents never hold your keys.
4. **Act.** Anything beyond a reply waits for your approval, and every step is recorded.

```
adapter ──► capture ──► secret check ──► learn ──► recall ──► Hermes turn ──► reply or proposal
               │                           │                       │
               ▼                           ▼                       ▼
            archive                  Honcho memory          security broker ──► your model provider
```

## Under the hood

Nocheh is TypeScript services, a React dashboard and a thin Python plugin for Hermes, all in one Docker Compose project.

- **Adapters.** Sources are stored in a platform-independent model (platform, kind, ID, relationships), so new chat platforms such as Slack or Discord fit without changing existing data. Telegram is the first adapter.
- **Three databases.** `nocheh_archive` keeps original messages and files and is never rewritten. `nocheh_derived` keeps masked copies and everything generated. `nocheh_control` keeps settings, access rules, approvals and jobs. Hermes, Honcho and Inngest keep their own stores.
- **Capture first.** Incoming messages land in a durable spool before they are acknowledged, then commit once. Restarts, retries and database outages don't drop or duplicate messages.
- **Workflows.** Inngest runs every reply, learning and import as a durable workflow with retries, waits and full history.
- **Runtime.** [Hermes](https://github.com/NousResearch/hermes-agent) is the agent runtime and owns the Telegram connection, sessions, schedules and per-chat roles, skills and notes. It is the first runtime, not the only one: the archive is portable across runtimes.
- **Memory.** [Honcho](https://github.com/plastic-labs/honcho) is the long-term memory, behind a swappable boundary, using Honcho's own model of people and sessions.
- **Isolation.** Agent turns run in containers with one profile and scoped access: no provider keys, no Docker socket and no unrestricted internet. Approved shell work runs in disposable containers with no network.
- **Approvals.** Every external effect records its proposal, approval, start and result separately. An uncertain send is never repeated automatically.

Service map: [docs/services.md](docs/services.md).

## Good to know

- Nocheh answers only while its services are running. Telegram holds new messages for up to 24 hours, so short breaks lose nothing there.
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

## License

See [LICENSE](LICENSE). Nocheh's code and docs are MIT. The Nocheh name and logo remain © PlaygrndLabs; you may use them to refer to Nocheh, but not as the name or logo of your own product. The [Graphify skill](.agent/skills/graphify/SKILL.md) comes from Graphify and keeps its own [MIT notice](.agent/skills/graphify/LICENSE). Hermes (MIT) and Honcho (AGPL-3.0) are not part of this repository: they are downloaded when you build and keep their own licenses.
