# ADR-0266: Schedules set by asking in the owner's private chat

<status>
Accepted on 2026-11-20, as step 2 of "Add morning brief and focus list". The owner
approved, on 2026-11-20: a schedule approved once sends its results to the owner's
private chat with no card each time, while a group's results keep their card; a
Schedules list in both the dashboard and the mini app; no card when a schedule is
set, only Nocheh's own message with Pause and Delete; and the brain's own schedule
tool instead of a Nocheh tool. Extends [ADR-0031](0031-native-managed-schedules.md)
(the same captured fires; a new way to set and change a schedule). Amends
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md) for one kind of send: a
scheduled result to the owner's private chat. Members are a later step.
</status>

## Context

Nocheh already ran Hermes's schedules (ADR-0031): Nocheh's scheduler reads each
chat's Hermes schedule store, captures every new or changed schedule in the archive
before it may run, fires each due run as a sealed turn and asks the owner with a
card before a result is sent. Only the owner could set one, from the command line.
A personal assistant should take "every weekday at 8, send me a short brief" in
chat, and send that brief without asking each morning.

Hermes has its own schedule tool, `cronjob_manage`, and the `[SILENT]` marker for a
run with nothing to say. Its gateway, which runs schedules and sends their results,
is not what Nocheh runs: Nocheh keeps the bot, the sealed runs and the archive.

## Decision

1. **Hermes's own tool, in the owner's own reply.** A reply in the owner's private
   chat to the owner's own Telegram message (not a forward), and only such a reply,
   gets Hermes's `cronjob` toolset. Nocheh's `/v1/schedules/turn` says whether the
   reply may, and gives the owner's time zone (Settings › Tasks). A job's run, a
   box, a machine, a review, a member and a scheduled run never get it.
2. **The chat's schedule store, mounted.** For that reply the launcher mounts the
   owner chat's Hermes schedule folder read-write into the sealed turn at
   `/profile/cron`. Hermes's lock in that folder keeps the turn and Nocheh's
   scheduler from writing at once.
3. **A gate over the tool.** A plugin hook allows only create, list, update, pause,
   resume and remove; refuses running a schedule inside the reply and every option
   Nocheh does not run (scripts, other models, skills, webhooks and so on); and sets
   each schedule to send to this chat. A time zone the owner names is kept (an unknown
   name is refused); a new schedule without one takes the owner's time zone.
   A result keeps Hermes's fields and replaces its notes about its own gateway with
   what Nocheh does. Without the turn's binding the tool is refused.
4. **Captured as before.** Nocheh's scheduler captures a schedule the tool made like
   any other. A schedule Hermes changed in place since its last capture gets a new
   definition version and is captured again before it may run; the old one's
   waiting runs are cancelled. A schedule Hermes removed is never run again.
   Schedules run in their own time zone.
5. **Nocheh's message, no card.** Once captured, a schedule set by asking gets one
   message in the owner's private chat, written by code from its fields: its name,
   when it runs and its next run, with Pause and Delete. Only the owner's press in
   that chat acts on them. Its texts are editable (`schedules.notice_texts`).
6. **Results with no card in the owner's private chat.** A scheduled result for the
   owner's private chat is sent there as a trusted `scheduled_run` send, through the
   usual guard and delivery path, with no card. A group's result still waits for the
   owner's card. A result that is only `[SILENT]` or `[NO_REPLY]` is not sent, except
   after Run now in the owner's private chat: the owner is waiting, so one fixed,
   editable line names the schedule and says there was nothing new.
7. **One Schedules page.** The dashboard's Schedules page and the mini app's
   Schedules tab list every chat's schedules in one table (name, chat, when, next
   run, last result) with Pause or Resume, Run now and Delete, through the brain's
   `manageSchedules` operation and the same owner adapter as the command line.
8. **A run reads the owner's tasks and views.** A schedule's run in the owner's
   private chat, while it runs and not stopped, reads every task list and the
   owner's read views (chats, projects, people, memory map), as a morning brief
   needs, and changes none. A group's schedule run reads neither.

## Consequences

- The owner sets, changes and removes schedules by asking; nothing new runs
  without its capture.
- The brain's notes and tools in a scheduled run are the chat's own, as before.
- A member's own schedules (their chat, their approval, a per-member cap) build on
  the same gate in a later step.
