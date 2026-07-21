import { useState } from "react";
import { Send, X } from "lucide-react";
import type { Member, SimEntry } from "../state/useSimulation.js";

/** Quick reactions offered on each user message; the LLM interprets them against the message's knowledge. */
const REACTION_EMOJIS = ["✅", "👍", "🎯", "❌", "👀"] as const;

interface GroupChatProps {
  readonly entries: SimEntry[];
  readonly members: Member[];
  readonly activeMemberId: string;
  readonly busy: boolean;
  onSetActiveMember(id: string): void;
  onAddMember(name: string): void;
  onRemoveMember(id: string): void;
  onSend(text: string): void;
  onReact(messageId: string, emoji: string): void;
}

/** Mock Telegram group: member roster, transcript, and a composer. */
export function GroupChat({
  entries,
  members,
  activeMemberId,
  busy,
  onSetActiveMember,
  onAddMember,
  onRemoveMember,
  onSend,
  onReact,
}: GroupChatProps): JSX.Element {
  const [text, setText] = useState("hey, I think we should ship the beta this week — can someone own the release notes?");
  const [newMember, setNewMember] = useState("");

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="group-chat">
      <div className="roster">
        <span className="roster-label">Send as</span>
        {members.map((member) => (
          <span key={member.id} className={`member-chip${member.id === activeMemberId ? " active" : ""}`}>
            <button className="member-pick" onClick={() => onSetActiveMember(member.id)}>{member.name}</button>
            {members.length > 1 && (
              <button className="member-remove" title="Remove member" aria-label={`Remove ${member.name}`} onClick={() => onRemoveMember(member.id)}>
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        <span className="member-add">
          <input
            value={newMember}
            placeholder="Add member"
            onChange={(e) => setNewMember(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onAddMember(newMember);
                setNewMember("");
              }
            }}
          />
        </span>
      </div>

      <div className="transcript">
        {entries.length === 0 ? (
          <p className="muted empty-chat">No messages yet. Pick a sender and post a mock Telegram message.</p>
        ) : (
          entries.map((entry, index) => <Bubble key={index} entry={entry} busy={busy} onReact={onReact} />)
        )}
      </div>

      <div className="composer-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              send();
            }
          }}
          placeholder="Message the group..."
        />
        <button className="action" disabled={busy} onClick={send}>
          <Send size={15} aria-hidden="true" />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function Bubble({
  entry,
  busy,
  onReact,
}: {
  readonly entry: SimEntry;
  readonly busy: boolean;
  onReact(messageId: string, emoji: string): void;
}): JSX.Element {
  if (entry.kind === "user") {
    const reactions = entry.reactions ?? [];
    return (
      <div className="bubble user">
        <span className="who">{entry.sender}</span>
        {entry.text}
        <div className="reaction-bar" role="group" aria-label="React to this message">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-btn"
              disabled={busy}
              aria-label={`React with ${emoji}`}
              onClick={() => onReact(entry.messageId, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        {reactions.length > 0 && (
          <div className="reaction-chips" aria-label="Reactions">
            {reactions.map((emoji) => (
              <span key={emoji} className="reaction-chip">{emoji}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (entry.kind === "bot") {
    return (
      <div className="bubble bot">
        <span className="who">Nocheh system result</span>
        {entry.text}
      </div>
    );
  }

  const { record } = entry;
  return (
    <div className="bubble assistant">
      <span className="who">system analysis result</span>
      <div>{summarize(record.extractedTasks.length)}</div>
      {record.extractedTasks.length > 0 && (
        <ul className="tasks-out">
          {record.extractedTasks.map((task, index) => (
            <li key={index}>
              {task.title || "(empty)"} — <b>{task.confidence.toFixed(2)}</b>{" "}
              <span className={task.accepted ? "ok" : "warn"}>{task.accepted ? "accepted" : "rejected"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="meta">
        {record.redactionFindingCount} redacted · {record.totalLatencyMs.toFixed(0)} ms
      </div>
    </div>
  );
}

function summarize(taskCount: number): string {
  return taskCount === 0 ? "Analyzed — no tasks extracted." : `Extracted ${taskCount} task${taskCount === 1 ? "" : "s"}.`;
}
