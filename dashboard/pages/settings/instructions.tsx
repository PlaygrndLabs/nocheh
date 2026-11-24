/**
 * "Built-in instructions": the texts Nocheh's code tells the models behind the
 * scenes, as a table a page at a time. The owner can replace any of them in a
 * drawer; resetting brings back the built-in text, which then follows future updates.
 */
import {useState} from 'react';
import {RotateCcw, Search} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dot,
  Input,
  LoadError,
  LoadingRows,
  Pager,
  Table,
  Td,
  Textarea,
  Th,
  type Tone,
} from '../../ui/core';
import {Drawer} from '../../ui/overlay';

const PAGE = 12;
const statusTone: Record<string, Tone> = {'Built-in': 'neutral', Changed: 'accent'};

type Prompts = {
  revision: string;
  defaults: Record<string, string>;
  texts: Record<string, string>;
  limit: number;
  placeholders: Record<string, string[]>;
};

export const instructions: {key: string; title: string; hint: string}[] = [
  {
    key: 'reply.common',
    title: 'Reply rules for every chat',
    hint: 'Sent with every reply, in your private chat and in groups.',
  },
  {key: 'reply.owner', title: 'Your private chat', hint: 'Added after the rules above when Nocheh replies to you.'},
  {
    key: 'reply.group',
    title: 'Groups',
    hint: 'Added after the rules above in groups. [NO_REPLY] is how Nocheh stays quiet.',
  },
  {
    key: 'reply.private',
    title: 'Private answers',
    hint: 'Added after the rules above when Nocheh answers a group question in the asker’s private chat, after a tap on Answer privately. Such an answer only reads.',
  },
  {
    key: 'reply.member',
    title: 'Members’ private chats',
    hint: 'Added after the rules above when Nocheh replies to a member in their own private chat with it. There it only reads the groups they joined and their own chat, and shows the whole task list of each project with a group they joined, without changing it. Keep the line that says you can read the chat: Nocheh never tells a member their chat is private from you.',
  },
  {
    key: 'reply.member_read',
    title: 'Your questions about a member',
    hint: 'Added when Nocheh answers your question about what a member said in their own private chat with it. That answer reads only that member’s chat, comes as a separate message in your private chat and is not kept in your conversation.',
  },
  {
    key: 'reply.schedules',
    title: 'Setting schedules',
    hint: 'Added in your private chat: how Nocheh sets a schedule, such as a morning brief, when you ask for one.',
  },
  {
    key: 'reply.member_schedules',
    title: 'Members setting schedules',
    hint: 'Added in a member’s private chat when they have Personal assistant on: how Nocheh sets their own schedules when they ask.',
  },
  {
    key: 'reply.scheduled',
    title: 'Scheduled runs',
    hint: 'Added when a schedule runs. Its answer is sent to its chat by itself; [SILENT] means there is nothing to send.',
  },
  {
    key: 'memory.evidence',
    title: 'Using remembered facts',
    hint: 'Explains the remembered facts that come with each message.',
  },
  {
    key: 'memory.limited',
    title: 'When long-term memory is unavailable',
    hint: 'Told to Nocheh when long-term memory can’t be reached.',
  },
  {
    key: 'memory.notes_review',
    title: 'Notes review',
    hint: 'Guides how Nocheh updates its Hermes notes after a conversation.',
  },
  {
    key: 'learning.interpret',
    title: 'Learning from conversations',
    hint: 'Tells long-term memory what to learn from each message. Keep {trigger_id} and {citable_ids}; Nocheh fills them in.',
  },
  {
    key: 'sharing.group_filter',
    title: 'Group sharing filter',
    hint: 'Decides what private knowledge a sharing rule set to Filter automatically may pass on to a group. That rule’s privacy notes are added after it. It sees only the words that were searched for, at most the 12 longest and in sorted order, never the question as it was asked.',
  },
  {
    key: 'telegram.not_allowed',
    title: 'Reply to people who may not talk in a group',
    hint: 'Sent in a group, as a reply, when someone who may not talk to Nocheh there asks it something: someone who isn’t a member, or a member who is paused or switched off there. At most once a UTC day per person in each group. No model is used.',
  },
  {
    key: 'telegram.member_daily_limit',
    title: 'Reply to a member past the daily limit',
    hint: 'Sent in a group, as a reply, when a member asks Nocheh something after using up the daily messages you set on the Members page. At most once a UTC day in each group. No model is used.',
  },
  {
    key: 'telegram.member_private_daily_limit',
    title: 'Reply to a member past the daily limit, in private',
    hint: 'Sent in a member’s private chat with Nocheh when they write after using up the daily messages you set on the Members page, which count their group and private messages together. At most once a UTC day. No model is used.',
  },
  {
    key: 'telegram.not_allowed_private',
    title: 'Reply to people who may not talk in private',
    hint: 'Sent when someone who may not talk to Nocheh privately writes to it in a private chat: someone who isn’t a member, or a member who is paused or has their private chat switched off. At most once a day per person. No model is used.',
  },
  {
    key: 'members.local_laws',
    title: 'Local laws line on the Members page',
    hint: 'Shown only to you, at the top of the Members page: a reminder to check what your local laws allow before you read your members’ private chats with Nocheh. Never sent to anyone.',
  },
  {
    key: 'telegram.approval_card',
    title: 'Approval card for a message',
    hint: 'The card with Approve and Reject buttons in Telegram. {destination} is where it goes, {origin} where it was asked, {text} the exact message. A line whose value is missing is left out.',
  },
  {
    key: 'telegram.approval_action',
    title: 'Approval card for a tool',
    hint: 'The same card for shell, browser and online tool actions. {kind} says what it does, such as “Notion · create pages”, {summary} the assistant’s own short line about it, which Nocheh always starts with its “AI says:” line, {origin} where it was asked, {arguments} exactly what it will run, field by field, with long text in a quote that opens on a tap. With a summary, {arguments} folds into one quote that opens on a tap, unless it is a command. A web address and another server’s input of at most 300 characters always stay open, a longer address shows its start and how many more characters it carries, and a card for another server’s tool always says how many characters of input it sends and to which site.',
  },
  {
    key: 'telegram.approval_task',
    title: 'Approval card for a project’s task',
    hint: 'The card in your private chat before a change you ask for there reaches a project’s task list. {change} says what changes in which project’s list, {chats} names every group and topic that sees that list, {private} says what stays private, and {fields} shows exactly what those chats will see. A line whose value is missing is left out.',
  },
  {
    key: 'telegram.approval_texts',
    title: 'Approval buttons and results',
    hint: 'One “name: text” line each for the buttons, the note above a site’s or command’s “where asked” buttons that says the rule covers you and every member who can talk in that chat or topic (rule_note), the note above an “Always allow” button that says what a rule for a site, a shared file or another server’s tool lets Nocheh do without asking (site_note, document_note, tool_note), the result added to a decided card and its {reason}, the name of a job or schedule that asked, the names of a command, a web page and a tool list (the lines starting with kind), the heading of a tool’s folded details (details), the label before the assistant’s summary (ai_says), the line under a long web address with its {count} (long_address), the line saying how many characters of input another server’s tool gets, with {count} and {site} (sends), the card that lists a job’s changes (the lines starting with list), a project task’s card and its results (the lines starting with task), and the short notices after a press. The chat words a send card, a notice and a reminder line share: your private chat (private_chat); a group and a topic (group_chat, topic, topic_name); a member’s private chat with a group they are a member in (person_chat, person_chat_more with {count} more groups, person_chat_other); a chat with no name (unnamed_group, unnamed_topic, unnamed_person); a chat Nocheh no longer knows (unknown_chat) or doesn’t serve now (not_served); and a name that reads like another’s, told apart by its project on cards in your private chat (name_project) or by its short ID, the one the Chats page shows after the name (name_id). Then the result of an approved message that wasn’t sent (not_sent) with its reasons (reason_not_served, reason_settings_changed, and reason_member_changed when the member who asked was paused or removed, or a switch for them was turned off), and the notices when a scheduled task’s result wasn’t sent (schedule_not_sent), a scheduled task didn’t run (schedule_not_run) or a job’s report wasn’t sent (job_report_not_sent). A line you remove keeps its default; keep the values in braces, such as {name} and {reason}, in these lines, as Nocheh fills them in.',
  },
  {
    key: 'telegram.group_tools_texts',
    title: 'Tool runs a group allows without a card',
    hint: 'Told to the agent, not the chat, when a web page or an outside tool asked for in a group runs without an approval card: the member who asked may use web pages and outside tools (Members page), or you asked. One “name: text” line each: allowed_follow_up when its answer follows as a reply, and allowed when it doesn’t. A line you remove keeps its default.',
  },
  {
    key: 'telegram.action_continued',
    title: 'After an approved operation ends',
    hint: 'Sent to the agent, not to the chat, when operations a message asked for have ended, so it answers in that chat as a reply to the message. {actions} lists each operation’s ID, tool and state.',
  },
  {
    key: 'telegram.private_answer',
    title: 'Private answer’s first line',
    hint: 'Sent to the agent, not to the chat, before the question when it answers privately. {group} is where the question was asked and {groups} every group of that project it may read.',
  },
  {
    key: 'telegram.private_answer_texts',
    title: 'Answer privately button and notices',
    hint: 'One “name: text” line each for the button under your answer in a group (button, up to 40 characters), the notice when the tap opens your private chat (open), and the short notices when someone else taps it (only_asker), it has expired (expired), it was already used (used), the project’s groups or the question changed (changed), a private chat link was meant for someone else (not_yours), or your private chat can’t be opened right now (retry). No model is used. A line you remove keeps its default.',
  },
  {
    key: 'telegram.member_read',
    title: 'Question about a member’s first line',
    hint: 'Sent to the agent, not to the chat, before your question when you ask what a member said in their private chat with Nocheh. {member} is the name Telegram shows for them.',
  },
  {
    key: 'telegram.member_read_texts',
    title: 'Answers about a member',
    hint: 'One “name: text” line each for the first line of the separate answer, which names the member’s chat it comes from (source), and the short notices in your private chat when that chat can’t be read now (closed) or no answer came (failed). {member} is the name Telegram shows for them. No model is used for the notices. A line you remove keeps its default.',
  },
  {
    key: 'tasks.reminder',
    title: 'Task reminder',
    hint: 'Sent to your private chat when a task reminder is due. {title} is the task, {due} its due day, {list} its project and {notes} its notes. A line whose value is missing is left out. Reminders set or changed in a group start with lines from “Reminder lines: who set it and where”.',
  },
  {
    key: 'tasks.reminder_texts',
    title: 'Reminder lines: who set it and where',
    hint: 'Reminders that members set in a group start with a 👤 line naming who and where. Theirs that come due together in one group arrive as one message, at most one message per group every 10 minutes, so with many due at once the last can come tens of minutes late (about 10 minutes per further message). Nothing is dropped. Your own reminders arrive at their time. One “name: text” line each: you and person, person_gone or unnamed_person for who; set_by for who set it and where ({who}, {place}); written_by with field_title, field_notes and field_due for who last wrote the task elsewhere; closed_by for who closed it; merged and more_waiting for the header and the last line of a merged message ({count}, {place}); note_line, the mark before each line of a person’s notes ({line}); place_app, the place “the members’ app” for reminders a member set there; and removed_in_group, the notice when a message from you in a group removed reminders set elsewhere. {place} uses the chat words from “Approval buttons and results”. A line you remove keeps its default; keep the values in braces in these lines, as Nocheh fills them in.',
  },
  {
    key: 'members.reminder',
    title: 'Task reminder to a member',
    hint: 'Sent to a member’s own private chat with Nocheh when a reminder they set is due, in a group or in the members’ app. {title} is the task, {due} its due day in your task time zone, {list} its project and {notes} its notes. A line whose value is missing is left out. It starts with lines from “Reminder lines to a member”.',
  },
  {
    key: 'members.reminder_texts',
    title: 'Reminder lines to a member',
    hint: 'One “name: text” line each for a reminder a member gets: set_by, the line saying they set it themselves, and note_line, the mark before each line of the task’s notes ({line}). These lines never name who wrote or closed the task, or where. A line you remove keeps its default; keep the values in braces.',
  },
  {
    key: 'memory.source_texts',
    title: 'Note sources on the Notes page',
    hint: 'Under each note in Memory › Notes, where it came from. One “name: text” line each. Messages: said and reaction ({who}, {place}); person_not_allowed for someone not allowed there now ({name}); anonymous; forward with its {origin}, one of origin_person, origin_hidden, origin_channel, origin_group, origin_bot or origin_unnamed; file and file_unnamed; audio; quote, and quote_nocheh for a quote of Nocheh’s own message; pinned, for someone else’s message {who} pinned; held, for a message {who} sent that holds someone else’s words, such as a shared checklist or poll; pinned_held, for {who}’s own such message {who} pinned; and pinned_nocheh for a pin of Nocheh’s own message; and unknown_message. Nocheh’s own messages: nocheh_reply, nocheh_about_forward, nocheh_follow_up, nocheh_private_answer, nocheh_job_report, nocheh_scheduled_run, nocheh_approved_post and nocheh_unlearned. Notes: review_owner, review ({sources}), rules, and rules_others for rules learned from other people’s messages, forwards or files, turn_own, turn, turn_read and job_turn ({place}, {date}, {read}), and earlier for a note that replaced an older one. What a turn read: read_message, read_forward, read_file, read_recent, read_reply (the message it replied to, when not your own), read_archive, read_memory (long-term memory), read_tasks (tasks other people wrote), read_web, read_notion, read_tools, read_commands, read_past and read_other. Then unknown, unavailable and more ({count}). {who} uses the words from “Reminder lines: who set it and where” and {place} the chat words from “Approval buttons and results”. Code picks each line from Nocheh’s own records, never from what a message says; the assistant reads fixed words instead and never sees these. A line you remove keeps its default; keep the values in braces in these lines, as Nocheh fills them in.',
  },
  {
    key: 'imports.ready',
    title: 'Import ready',
    hint: 'Sent to your private chat once an imported chat is saved, read and checked for secrets. {chats} is the chat, {messages} how many messages and {failed} how many could not be prepared. A line whose value is missing is left out.',
  },
  {
    key: 'system.problems',
    title: 'Problem notice',
    hint: 'Sent to your private chat when a failure or other problem is new or worse, at most once an hour for the same problem. {problems} is the list, one line each. Turn it off in Settings › Telegram.',
  },
  {
    key: 'system.problem_buttons',
    title: 'Problem notice buttons',
    hint: 'One “name: text” line each for the Open and Retry failed buttons under a problem notice and the short answers to a press. {count} is how many tasks are retried. A line you remove keeps its default.',
  },
  {
    key: 'guard.secret_check',
    title: 'Secret check',
    hint: 'Finds passwords and keys before anything is stored. Keep its JSON reply format, or the check fails and messages wait.',
  },
  {
    key: 'images.read',
    title: 'Reading images',
    hint: 'Sent with each photo or image when it is saved, live or imported. Its answer is checked for secrets and becomes the image’s searchable text.',
  },
  {
    key: 'background.job',
    title: 'Background job: first message',
    hint: 'Starts an approved background job in its own session. {instruction} is what the person asked; {title}, {chat}, {period}, {size} and {limits} are filled in.',
  },
  {
    key: 'background.resume',
    title: 'Background job: after an interruption',
    hint: 'Sent when a job restarts after an interruption and its work so far is still there. {title} is the job’s name.',
  },
  {
    key: 'background.restart',
    title: 'Background job: fresh restart',
    hint: 'Added to the first message when a job restarts and its earlier work could not be kept. {todo} is its last to-do list, left out when it may no longer be shown.',
  },
  {
    key: 'background.limit',
    title: 'Background job: stopped at a limit',
    hint: 'Sent to the chat instead of a report when a job reaches its cost or time limit. {title} and {limit} (cost or time) are filled in; {done} and {left} come from its last to-do list, and {none} is said when it kept none.',
  },
  {
    key: 'background.card',
    title: 'Background job card',
    hint: 'The Approve and Reject card for a job. {instruction} is what the person asked; {title}, {size}, {minutes}, {cost}, {cost_limit}, {minutes_limit}, {checked}, {unpriced}, {notion}, {box}, {repo}, {machine} and {steps} are filled in. {cost_limit} is missing on a model without a price, and {unpriced} then says only the time limit applies; {notion} says what the job may do in your Notion without asking; {box} says that it runs in a sealed box; {repo} names the GitHub copy it reads; {machine} names the machine it works on and {steps} lists its plan; {origin} names the group and topic a job was asked in when the card is in another chat. Hidden characters in a job’s title, instruction and plan show as [U+XXXX] where they stand. A line whose value is missing is left out; a card without {origin}, {unpriced}, {notion}, {box}, {repo}, {machine} or {steps} still shows that line, at its end.',
  },
  {
    key: 'background.texts',
    title: 'Background job card answers',
    hint: 'One “name: text” line each for what a decided job card says: running, running_elsewhere (the running line of a card in your private chat for a job asked in another chat), queued, paused (a job a member approved while member jobs are paused), stopping, done, limited, stopped, failed and rejected. checked is the card’s secret check line, unpriced its line for a model without a price, notion_reads its Notion line and box its sealed box line. box_repo is the sealed box line of a job that reads a GitHub copy, repo its copy line with {repo_name}, {repo_branch}, {repo_commit}, {repo_copied} and {repo_size}, and repo_removed what a card says when Remove withdrew it. machine is the line of a job that works on one of your machines, with {machine_name}, {machine_login} and {machine_address}; steps is the heading of its plan; machine_off is what a card says when its machine was turned off or changed. A line you remove keeps its default.',
  },
  {
    key: 'background.box',
    title: 'Background job: sealed box',
    hint: 'Added to each run of a job in its sealed box: what /chat and /work hold and in what order, that the box has no internet, and that its work is lost when the job ends.',
  },
  {
    key: 'background.repo',
    title: 'Background job: GitHub copy',
    hint: 'Added after the sealed box text to each run of a job that reads a GitHub copy: where the copy is, how to read it, and when to run its code. {repo}, {branch}, {commit} and {copied} are filled in.',
  },
  {
    key: 'background.machine',
    title: 'Background job: your machine',
    hint: 'Added to each run of a job that works on one of your machines over SSH: that its terminal and file tools run there, the plan you approved, and what it must never do there. {machine_name}, {machine_login}, {machine_address} and {steps} are filled in.',
  },
  {
    key: 'background.member_spend',
    title: 'Member jobs: spend notice',
    hint: 'Sent to your private chat, with a Pause button, once a UTC day when jobs members approved themselves pass your notice mark (Settings › Assistant › Background jobs). {spent} is what they spent today, {mark} the notice mark, {pause_mark} the mark where member jobs pause by themselves, and {members} one line for each member in each group.',
  },
  {
    key: 'background.member_paused',
    title: 'Member jobs: paused by themselves',
    hint: 'Sent to your private chat, with a Resume button, when member jobs pause by themselves past your pause mark, until 00:00 UTC. {spent}, {mark} (the pause mark) and {members} are filled in as in the spend notice.',
  },
  {
    key: 'schedules.notice_texts',
    title: 'Schedules: when one is set in your chat',
    hint: 'One “name: text” line each: set ({name}), when ({when}), next ({next}) and note are the lines of the message after a reply sets a schedule in your private chat; pause and delete are its buttons; paused and deleted answer a press; unnamed and no_next stand in for a missing name or next run; changed and only_owner answer a press that cannot act; quiet is what Run now sends there when there is nothing new ({name}). A line you remove keeps its default.',
  },
  {
    key: 'telegram.chat_adds',
    title: 'Groups: when someone adds Nocheh',
    hint: 'One “name: text” line each: left_member, left_anonymous and could_not_leave are your notes when someone else adds Nocheh to a group ({name}, {group}), and someone stands in for a hidden adder; removed is the line when Nocheh is removed from a group it was on in ({group}); card is the card after you add Nocheh ({group}, {project}); move ({project}), no_project and turn_off are its buttons; moved, unassigned and turned_off answer a press; changed and only_owner answer a press that cannot act. A line you remove keeps its default.',
  },
  {
    key: 'background.member_texts',
    title: 'Member jobs: notice lines and buttons',
    hint: 'One “name: text” line each: member is a line of {members} with {name}, {group} and {spent}; more sums the rest with {count} and {spent}; unnamed_member ({id}) and unnamed_group stand in for a missing name; pause and resume are the buttons; paused and resumed answer a press and are added under the notice; only_owner answers anyone else. A line you remove keeps its default.',
  },
];

/** A plain-language problem with an edited text, or null. */
export function instructionProblem(text: string, limit: number, placeholders: string[] = []): string | null {
  if (!text.trim()) return 'Write something, or reset it to the built-in text.';
  if (text.length > limit) return `Keep it under ${limit.toLocaleString()} characters.`;
  const missing = placeholders.filter(name => !text.includes(name));
  if (missing.length)
    return `Keep ${missing.join(' and ')} in the text; Nocheh fills ${missing.length === 1 ? 'it' : 'them'} in.`;
  return null;
}

export function BuiltInInstructions() {
  const prompts = useResource<Prompts>('/prompts');
  const data = prompts.data;
  // A string is a new text; null means use the built-in text again.
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [revision, setRevision] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [page, setPage] = useState(0);
  const value = (key: string) =>
    changes[key] === null
      ? (data?.defaults[key] ?? '')
      : (changes[key] ?? data?.texts[key] ?? data?.defaults[key] ?? '');
  const problem = (key: string) =>
    changes[key] == null ? null : instructionProblem(changes[key]!, data!.limit, data!.placeholders[key]);
  const edit = (key: string, text: string | null) => {
    setRevision(current => current ?? data?.revision ?? null);
    setChanges(current => {
      const next = {...current};
      const custom = data?.texts[key] !== undefined;
      const target = text ?? data?.defaults[key];
      if (target === (data?.texts[key] ?? data?.defaults[key])) delete next[key];
      else if (custom && target === data?.defaults[key]) next[key] = null;
      else next[key] = text;
      return next;
    });
  };
  const reset = () => {
    setChanges({});
    setRevision(null);
    setChecked(false);
  };
  const title = (key: string) => instructions.find(item => item.key === key)?.title ?? key;

  useDraftSource({
    id: 'built-in-instructions',
    labels: Object.keys(changes).map(key => 'Instruction: ' + title(key)),
    save: async () => {
      setChecked(true);
      // A failed save opens the text it is about.
      const bad = Object.keys(changes).find(problem);
      if (bad) {
        setOpen(current => (current && problem(current) ? current : bad));
        throw new Error('Fix the marked instructions, then save again.');
      }
      try {
        await apiPost('/prompts', {
          texts: Object.fromEntries(
            Object.entries(changes).map(([key, text]) => [key, text === null ? null : text.trim()]),
          ),
          revision: revision ?? data?.revision,
        });
        reset();
        await refreshResources();
      } catch (e) {
        const code = (e as ApiError)?.message ?? '';
        throw new Error(
          /conflict|changed/.test(code)
            ? 'The instructions were changed somewhere else. Your edits are kept; check them and save again.'
            : code === 'prompt_placeholder_missing'
              ? 'A “name: text” line lost a value in braces that Nocheh fills in, such as {name} or {who}. Your edits are kept; put it back and save again.'
              : 'Couldn’t save the instructions.',
        );
      }
    },
    discard: reset,
  });

  const status = (key: string) =>
    key in changes
      ? changes[key] === null
        ? 'Reset when saved'
        : 'Not saved'
      : data?.texts[key] !== undefined
        ? 'Changed'
        : 'Built-in';
  const needle = typed.trim().toLowerCase();
  const found = needle
    ? instructions.filter(item => (item.title + ' ' + item.hint).toLowerCase().includes(needle))
    : instructions;
  const last = Math.max(0, Math.ceil(found.length / PAGE) - 1);
  const at = Math.min(page, last);
  const rows = found.slice(at * PAGE, (at + 1) * PAGE);
  const editing = instructions.find(item => item.key === open);
  const custom = (key: string) => (changes[key] === null ? false : key in changes || data?.texts[key] !== undefined);

  return (
    <Card>
      <CardHeader
        title="Built-in instructions"
        description="What Nocheh is told behind the scenes. Change any of them, or reset one to bring back the built-in text. No restart needed."
      />
      <div className="px-5 pb-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
          <Input
            type="search"
            aria-label="Find an instruction"
            className="pl-9"
            placeholder="Find an instruction"
            value={typed}
            onChange={event => {
              setTyped(event.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      {prompts.error && !data ? (
        <CardBody>
          <LoadError what="the instructions" error={prompts.error} />
        </CardBody>
      ) : !data ? (
        <CardBody>
          <LoadingRows rows={3} />
        </CardBody>
      ) : !rows.length ? (
        <CardBody>
          <p className="text-[13px] text-muted">No instruction matches. Try other words.</p>
        </CardBody>
      ) : (
        <Table aria-label="Built-in instructions">
          <thead>
            <tr>
              <Th scope="col">Instruction</Th>
              <Th scope="col">Status</Th>
              <Th scope="col">
                <span className="sr-only">Edit</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({key, title, hint}) => {
              const state = status(key);
              const error = checked ? problem(key) : null;
              return (
                <tr
                  key={key}
                  onClick={() => setOpen(key)}
                  className="cursor-pointer transition-colors hover:bg-subtle/60"
                >
                  <Td className="py-2">
                    <span className="block text-[13px] font-medium">{title}</span>
                    <span className="line-clamp-1 text-xs text-muted" title={hint}>
                      {hint}
                    </span>
                    {error && (
                      <span className="block text-xs text-bad" role="alert">
                        {error}
                      </span>
                    )}
                  </Td>
                  <Td className="py-2 text-[13px] whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Dot tone={statusTone[state] ?? 'warn'} />
                      {state}
                    </span>
                  </Td>
                  <Td className="py-1.5 text-right">
                    <Button size="sm" variant="ghost" aria-label={'Edit ' + title}>
                      Edit
                    </Button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {data && (
        <Pager
          page={at}
          hasNext={at < last}
          onPage={setPage}
          summary={
            found.length === instructions.length
              ? `${instructions.length} instructions`
              : `${found.length} of ${instructions.length} instructions`
          }
        />
      )}
      <Drawer
        wide
        open={!!editing && !!data}
        onOpenChange={next => !next && setOpen(null)}
        title={editing?.title ?? ''}
        description={editing?.hint}
        footer={
          <>
            <Button variant="primary" onClick={() => setOpen(null)}>
              Done
            </Button>
            <Button disabled={!editing || !custom(editing.key)} onClick={() => editing && edit(editing.key, null)}>
              <RotateCcw aria-hidden /> Reset to built-in
            </Button>
            <p className="ml-auto self-center text-xs text-muted">Save from the top of the page.</p>
          </>
        }
      >
        {editing && data && (
          <InstructionText
            title={editing.title}
            status={status(editing.key)}
            value={value(editing.key)}
            limit={data.limit}
            error={checked ? problem(editing.key) : null}
            onChange={text => edit(editing.key, text)}
          />
        )}
      </Drawer>
    </Card>
  );
}

function InstructionText(props: {
  title: string;
  status: string;
  value: string;
  limit: number;
  error: string | null;
  onChange: (text: string) => void;
}) {
  const {title, status, value, limit, error, onChange} = props;
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={title}
        aria-invalid={!!error || undefined}
        dir="auto"
        rows={18}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {error ? (
          <p className="text-xs text-bad" role="alert">
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted">
            {value.length.toLocaleString()} of {limit.toLocaleString()} characters
          </p>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Dot tone={statusTone[status] ?? 'warn'} />
          {status}
        </p>
      </div>
    </div>
  );
}
