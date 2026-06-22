import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditRecord } from "../api/client.js";
import { botReplyText } from "../sim/flow-model.js";

export interface Member {
  readonly id: string;
  readonly name: string;
}

export interface UserEntry {
  readonly kind: "user";
  readonly sender: string;
  readonly text: string;
  readonly at: string;
}

export interface AssistantEntry {
  readonly kind: "assistant";
  readonly auditId: string;
  readonly record: AuditRecord;
}

export interface BotEntry {
  readonly kind: "bot";
  readonly auditId: string;
  readonly text: string;
}

export type SimEntry = UserEntry | AssistantEntry | BotEntry;

interface SimState {
  readonly entries: SimEntry[];
  readonly seenAuditIds: string[];
  readonly members: Member[];
  readonly activeMemberId: string;
}

const DEFAULT_MEMBERS: Member[] = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "you", name: "You" },
];

function emptyState(): SimState {
  return { entries: [], seenAuditIds: [], members: DEFAULT_MEMBERS, activeMemberId: "alice" };
}

function storageKey(conversationId: string): string {
  return `nocheh.sim.${conversationId}`;
}

export function loadState(conversationId: string): SimState {
  try {
    const raw = localStorage.getItem(storageKey(conversationId));
    if (raw === null) {
      return emptyState();
    }
    const parsed = JSON.parse(raw) as Partial<SimState>;
    const members = Array.isArray(parsed.members) && parsed.members.length > 0 ? parsed.members : DEFAULT_MEMBERS;
    const activeMemberId = typeof parsed.activeMemberId === "string" && members.some((m) => m.id === parsed.activeMemberId)
      ? parsed.activeMemberId
      : (members[0]?.id ?? "alice");
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      seenAuditIds: Array.isArray(parsed.seenAuditIds) ? parsed.seenAuditIds : [],
      members,
      activeMemberId,
    };
  } catch {
    return emptyState();
  }
}

export interface Simulation {
  readonly entries: SimEntry[];
  readonly members: Member[];
  readonly activeMemberId: string;
  readonly activeMemberName: string;
  readonly lastAssistant: AssistantEntry | undefined;
  addUserEntry(sender: string, text: string): void;
  /** Appends an analysis trace + system result for each audit record not already seen. Returns how many were new. */
  ingestRecords(records: readonly AuditRecord[]): number;
  addMember(name: string): void;
  removeMember(id: string): void;
  setActiveMember(id: string): void;
  clear(): void;
}

/** Owns the per-conversation simulator state (roster + transcript), persisted to localStorage. */
export function useSimulation(conversationId: string): Simulation {
  const [state, setState] = useState<SimState>(emptyState);
  const seenRef = useRef<Set<string>>(new Set());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    const loaded = loadState(conversationId);
    seenRef.current = new Set(loaded.seenAuditIds);
    setState(loaded);
    loadedFor.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (loadedFor.current !== conversationId) {
      return;
    }
    try {
      const isPristine = state.entries.length === 0 && state.seenAuditIds.length === 0
        && state.members === DEFAULT_MEMBERS && state.activeMemberId === "alice";
      if (isPristine) {
        localStorage.removeItem(storageKey(conversationId));
      } else {
        localStorage.setItem(storageKey(conversationId), JSON.stringify(state));
      }
    } catch {
      // Ignore quota / unavailable storage; the simulator still works in-memory.
    }
  }, [state, conversationId]);

  const addUserEntry = useCallback((sender: string, text: string): void => {
    setState((current) => ({
      ...current,
      entries: [...current.entries, { kind: "user", sender, text, at: new Date().toISOString() }],
    }));
  }, []);

  const ingestRecords = useCallback((records: readonly AuditRecord[]): number => {
    const fresh = records.filter((record) => !seenRef.current.has(record.id));
    if (fresh.length === 0) {
      return 0;
    }
    for (const record of fresh) {
      seenRef.current.add(record.id);
    }
    setState((current) => {
      const appended: SimEntry[] = [];
      for (const record of fresh) {
        appended.push({ kind: "assistant", auditId: record.id, record });
        appended.push({ kind: "bot", auditId: record.id, text: botReplyText(record) });
      }
      return {
        ...current,
        entries: [...current.entries, ...appended],
        seenAuditIds: [...current.seenAuditIds, ...fresh.map((record) => record.id)],
      };
    });
    return fresh.length;
  }, []);

  const addMember = useCallback((name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return;
    }
    setState((current) => {
      const id = `${trimmed.toLowerCase().replace(/\s+/g, "-")}-${current.members.length}`;
      return { ...current, members: [...current.members, { id, name: trimmed }] };
    });
  }, []);

  const removeMember = useCallback((id: string): void => {
    setState((current) => {
      if (current.members.length <= 1) {
        return current;
      }
      const members = current.members.filter((member) => member.id !== id);
      const activeMemberId = current.activeMemberId === id ? (members[0]?.id ?? "") : current.activeMemberId;
      return { ...current, members, activeMemberId };
    });
  }, []);

  const setActiveMember = useCallback((id: string): void => {
    setState((current) => ({ ...current, activeMemberId: id }));
  }, []);

  const clear = useCallback((): void => {
    seenRef.current = new Set();
    setState((current) => ({ ...emptyState(), members: current.members, activeMemberId: current.activeMemberId }));
  }, []);

  const lastAssistant = [...state.entries]
    .reverse()
    .find((entry): entry is AssistantEntry => entry.kind === "assistant");
  const activeMemberName = state.members.find((member) => member.id === state.activeMemberId)?.name ?? "Unknown";

  return {
    entries: state.entries,
    members: state.members,
    activeMemberId: state.activeMemberId,
    activeMemberName,
    lastAssistant,
    addUserEntry,
    ingestRecords,
    addMember,
    removeMember,
    setActiveMember,
    clear,
  };
}
