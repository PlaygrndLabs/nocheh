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

- **Owns the source.** Every message, edit, reaction and file it sees is saved as an original, with where it came from, before any AI work starts. A slow or broken model never loses anything. Your messages and files are always kept. In **Settings › Privacy & data** you only choose how long Nocheh keeps its own work records, such as work history.
- **Reads what you send.** Documents and photos are read into text and recordings are transcribed, live or imported, so you can search and ask about them. The text is checked for secrets like anything typed, and the original is kept.
- **Remembers people and projects.** Honcho long-term memory learns facts about people and projects, and each chat keeps its own assistant notes in Hermes. Who said something, and whether it was said, reported or inferred, stays attached.
- **Understands context.** It learns how a group works, like a ✅ reaction meaning "done", and follows the state of tasks and commitments even when it doesn't reply. You can inspect and correct what it learned.
- **Keeps your tasks.** Say "remind me to renew the domain on Friday" in your private chat, or use the **Tasks** page. Your personal list and each project's list stay apart, with due dates, repeats, reminders, a board view and your own columns. A project's chats see only that project's list.
- **Organizes knowledge.** With your permission it groups conversations into projects. In **Memory** you can look through people, projects and facts, and fix any of them.
- **Keeps audiences apart.** A group recalls only its own conversations plus facts you approve to share. Your private chat can use everything.
- **Masks secrets.** A secret check finds passwords, keys and tokens and masks them before the assistant, memory or search ever sees them. You can review and edit every masked copy.
- **Asks before it acts.** Sending a message to another chat or running a shell, browser or MCP tool is proposed first, as a card with Approve and Reject. Decide with one tap in Telegram, or in the Inbox of the dashboard or the mini app. A big background job gets the same card in Telegram, with its estimated cost. With **Do what I ask** in **Settings › Assistant**, messages and tools you ask for in your private chat run without a separate yes.
- **Forgets on request.** Hide any message from the assistant and Nocheh stops using it, including in what it learned. You can hide its replies to that message too. The original stays in your archive, and Undo hiding brings it back.
- **Meets you where you talk.** Today that is Telegram: privately, and in the groups you pick, with the people you allow there. By default it answers in a group only when called: a reply to it, an @mention, or a message that starts with one of its names. It quietly saves everything else, and when called it also sees what was just said. Your private chat is yours alone: anyone else who writes to Nocheh privately gets one short fixed reply a day and never reaches a model. An optional Telegram mini app puts Home, Inbox, Tasks and Health on your phone.
- **Tells you when something breaks.** Your private chat gets a short notice about each new problem, such as failed work or a model that refused, with an **Open** button, plus **Retry failed** when failed work can run again. Turn notices off in **Settings › Telegram**.
- **A role and skills per project and chat.** Set the role and skills for every chat in **Settings › Assistant**, then give a project (in **Memory › Projects**) or a single chat (in **Chats**) its own. A chat's own role replaces its project's, which replaces the one for every chat. Skills add up. Only you can change them; the assistant can only update its notes.
- **Your models, your keys.** Use Anthropic, OpenAI or your own gateway (any OpenAI-compatible HTTPS address, with or without `/v1`). Pick one main model, or a different one for replies, memory, the secret check and images. Memory search and voice notes have their own choice. Keys stay on the server, replies on Anthropic use its prompt cache, and the Usage page shows what each part costs and how fast it answers.
- **Works with Notion.** Connect it and turn on **Use Notion** in **Settings › Connections**, and Nocheh can search, read and change your Notion from your private chat. By default reads run and changes ask you first, and groups never reach it.
- **Instructions you can edit.** In **Settings › Assistant** you can edit Nocheh's instructions to models and the fixed texts it sends, such as approval cards, reminders, problem notices and the reply to strangers. Each one can be reset to its default.
- **Yours to take with you.** Import chat history (Telegram Desktop exports today), export everything in a portable format, and back up or restore the whole installation. Backups also run on their own every day.

## Quick start

You need Docker with Compose, Node 26 and Python 3, a model provider key, and an OpenAI API key (or a gateway that offers the same models) for memory search and voice notes. To talk to Nocheh through Telegram, you also need a bot token from [BotFather](https://t.me/BotFather).

1. Install and create your local settings. `init` writes an ignored `.env` with generated internal passwords:

   ```bash
   npm ci
   ./bin/nocheh init
   ```

2. Start Nocheh. `up` builds it and runs it in the background:

   ```bash
   ./bin/nocheh up
   ```

3. Open the dashboard at <http://127.0.0.1:8783/> and create your Nocheh password. The same password signs you in to the Telegram mini app.
4. In **Settings › Models**, add a provider and choose the main model. Until then, replies and memory wait. If your main provider is not OpenAI, also add OpenAI, or a gateway with the same models, for **Memory search** and **Voice notes**.
5. Connect a chat adapter. For Telegram, open **Settings › Telegram**, paste the bot token and save. Send your bot a private message, then press **Find my ID** and choose your account. Turn Telegram on and save. Home shows a **Get started** checklist of what is still missing.
6. Say hello in your private chat. To bring Nocheh into a group, add it there, then pick the group and who may talk to it in **Chats**.

Full setup: [Telegram and the mini app](docs/telegram.md), [model providers](docs/provider.md) and [operations](docs/deploy.md).

## Use it

- **Ask what you know.** "What did Sara say about the launch?" or "Sum up last week in the design group." Nocheh answers from your archive and memory, within what that chat is allowed to see. It can read a whole chat in order, or just between two dates. In chats that long-term memory has learned from, it also finds messages by meaning.
- **Let it follow along.** Leave it in a group and let people talk. Later, ask "What's still open in the design group?" and it answers from what it followed.
- **Ask it to act.** By default, "Tell the design group the meeting moved to 4" becomes a proposal you approve before anything is sent.
- **Hand it big work.** Ask for something too big for one reply, like "read the whole design chat and list every decision", and Nocheh offers a background job with its estimated time and cost. Once it is approved, the job runs on its own and sends its report to that chat. Watch or stop it in **System › Background work**, or stop it with Stop on its card. A job you ask for in your private chat can also run commands and Python in a sealed box with no internet and no keys, and read a copy of a GitHub repository you make in **Settings › Connections**; turn that off with **Sealed box for jobs** in **Settings › Assistant**. A job you ask for can also work on your own VM over SSH: add it in **Settings › Machines**, approve the job's plan once in your private chat, and read every command it ran in **System › Machine log**. Nocheh keeps the machine's key, and Stop ends every program its login runs there.
- **Bring in your history.** Import old chats in **Messages › Import**. Before you start, it shows what checking and learning will cost, and you choose whether long-term memory may learn from them. Every message is saved, read and checked for secrets, and your private chat gets a message when the import is ready to ask about.
- **Look inside its head.** The dashboard shows what it knows and why. **Home** shows status, **Inbox** what waits on you, and **Tasks** your task lists. **Chats** shows who can see what, **Messages** every original and your imports, and **Memory** people, projects, facts and notes. **Usage** shows cost and speed, **System** health, background work, the machine log and backups, and **Settings** models, adapters, connections, machines and every instruction.
- **Correct it.** Fix a fact, rename a person, hide a message or undo an organization change. Nocheh rebuilds the affected memory from what remains.

## Run it

```bash
./bin/nocheh status      # each service and its state
./bin/nocheh diagnose    # health, credentials present, stuck jobs
./bin/nocheh backup      # back up the archive, memory and settings now
./bin/nocheh down        # stop everything; your data stays
./bin/nocheh up          # start again in the background
```

## How it works

Every message goes through four steps. Capture keeps working even when everything else is down, and the rest runs as durable [Inngest](https://www.inngest.com) workflows with retries and history:

1. **Capture.** An adapter (Telegram today, through Hermes) hands each message to Nocheh, which saves the original before anything else. The runtime's own tools turn documents, voice notes and photos into text, and Nocheh prepares a masked copy of all of it.
2. **Learn.** In the background, Honcho learns about people and projects, Hermes updates each chat's notes, and Nocheh learns conventions and the state of tasks, whether or not a reply is needed. Imported history is learned by long-term memory only.
3. **Reason.** When a message needs an answer, an isolated Hermes turn replies with what that chat may recall. Its model calls leave only through the security broker, so agents never hold your keys. A request too big for one reply becomes a background job: one isolated Hermes run of up to 50 minutes that starts once approved.
4. **Act.** Messages to other chats, tools and background jobs follow your approval rules, and most wait for a yes from you or the person who asked. Every proposal, approval and result is recorded.

```
adapter ──► capture ──► read ──► secret check ──► learn ──► recall ──► Hermes turn ──► reply, proposal or job
               │                                    │                       │
               ▼                                    ▼                       ▼
            archive                           Honcho memory          security broker ──► your model provider
```

## Under the hood

Nocheh is TypeScript services, a React dashboard and mini app, and a thin Python plugin for Hermes, all in one Docker Compose project.

- **Adapters.** Sources are stored in a platform-independent model (platform, kind, ID, relationships), so new chat platforms such as Slack or Discord fit without changing existing data. Telegram is the first adapter.
- **Three databases.** `nocheh_archive` keeps original messages and file records and is never rewritten; file bytes are saved on disk beside it, named by their checksum. `nocheh_derived` keeps masked copies and everything generated. `nocheh_control` keeps settings, access rules, approvals and jobs. Hermes, Honcho and Inngest keep their own stores.
- **Capture first.** Incoming messages land in a durable spool before they are acknowledged, then commit once. Restarts, retries and database outages don't drop or duplicate messages.
- **Workflows.** Inngest runs every reply, learning step, import and background job as a durable workflow with retries, waits and full history.
- **Runtime.** [Hermes](https://github.com/NousResearch/hermes-agent) is the agent runtime. It owns the Telegram connection, sessions, schedules, the role and skills of each chat and project, and each chat's notes. Its own tools read documents, transcribe voice notes and read images. It is the first runtime, not the only one: the archive is portable across runtimes.
- **Memory.** [Honcho](https://github.com/plastic-labs/honcho) is the long-term memory, behind a swappable boundary, using Honcho's own model of people and sessions. Its model calls go through a metered gateway that records their cost. When the agent searches it by meaning, it gets back only the matching messages from your archive that chat may see, as their masked copies.
- **Isolation.** Agent turns run in containers with one profile and scoped access: no provider keys, no Docker socket and no unrestricted internet. Approved shell work runs in disposable containers with no network.
- **Approvals.** Every external effect records its proposal, approval, start and result separately. An uncertain send is never repeated automatically.
- **Sign-in.** One Nocheh password signs in to the dashboard and the optional Telegram mini app. The mini app is a small separate service with no credentials of its own, and it reaches only a short list of owner pages.

Service map: [docs/services.md](docs/services.md).

## Good to know

- Nocheh answers only while its services are running. Telegram holds new messages for up to 24 hours, so short breaks lose nothing there.
- Dependable answers come before speed. A reply usually takes around half a minute, a bit longer when it first reads a new file, photo or voice note. While Nocheh works on it, Telegram shows "typing…" and the bot puts 👀 on the message it answers, then 👍 when it answered or 👎 when it failed.
- Photos are read by the **Images** model, which is your main model unless you pick another. Voice notes, audio files and round video notes are transcribed by the **Voice notes** model, OpenAI by default. Both are in **Settings › Models**. Recordings saved before you add a key are transcribed once you do. Stickers, animations and other videos are kept as originals only.
- Nocheh backs up the archive, memory and settings every day and keeps the newest seven automatic copies by default. Copies stay on the same machine, so copy one elsewhere to be safe. Change the schedule in **Settings › Privacy & data**.
- No local models. Replies, learning, the secret check, images, memory search and voice notes all run on model providers you pay.
- Nocheh is in development and not released yet. Live release checks are tracked in [docs/mvp-acceptance-status.md](docs/mvp-acceptance-status.md).

## Develop

```bash
npm ci
./bin/nocheh test        # PostgreSQL, TypeScript and Python integration tests
make dev                 # run from your checkout and reload on code changes
make dev-status          # is the development stack running?
make dev-stop            # stop it; your data stays
make dev-build           # rebuild after dependency or Dockerfile changes
```

`make dev` runs your checkout on `main` with the same settings and data as `up`. It starts only while Telegram is on and the background stack is stopped, so finish the Quick start, run `./bin/nocheh down`, then start `make dev`. See [Start and develop](docs/deploy.md#start-and-develop).

[SPECS.md](SPECS.md) defines what Nocheh must be and do, [TASK.md](TASK.md) tracks status and open checks, and [AGENTS.md](AGENTS.md) holds the working rules. Decisions live in the [ADRs](docs/adr/README.md), and [docs/repository-layout.md](docs/repository-layout.md) explains every folder. Agent skills for [admin inspection](.agent/skills/nocheh-admin-cli/SKILL.md), [deployment](.agent/skills/nocheh-deploy/SKILL.md) and [Graphify](.agent/skills/graphify/SKILL.md) live in `.agent/skills`. Code from before Hermes is kept on the `archive/pre-hermes-nocheh` branch.

## License

MIT. See [LICENSE](LICENSE).

Built by [PlaygrndLabs](https://github.com/PlaygrndLabs).
