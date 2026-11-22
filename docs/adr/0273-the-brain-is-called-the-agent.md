# ADR-0273: The brain is called the agent

<status>
Accepted on 2026-11-22, after the owner chose "Agent" as the new name for the swappable part
Hermes fills, and asked for the rename in code too: "not just docs and dashboard, want change
it in code like variables, functions and etc." Renames the words of
[ADR-0234](0234-brain-socket.md) and the ADRs that use them; changes no behaviour.
</status>

<context>
- Nocheh itself is the personal AI brain, the second brain its owner keeps. Calling Hermes's
  part "the brain" too made two things share one name.
- Code comments, dashboard texts and the sealed box network already called the same part
  "the agent".
</context>

<decision>
- The part behind the socket is the agent, and the socket is the agent socket. Every name
  follows: `src/agent/agent.ts` defines `Agent`, `src/agent/agents.ts` picks it,
  `src/agent/hermes.ts` is `hermesAgent`; the error codes are `agent_unavailable`,
  `agent_rejected`, `agent_invalid_response` and `agent_capability_unavailable`; the owner
  route is `/v1/agent/manage` with the admin operation `agent.manage`; `/v1/runtime` reports
  `agent`; a turn's pass and `security_events` name its `agent`; Hermes's turn journal is
  `services/hermes/agent_turns.py` (`AgentTurns`) in `spool/agent-turns`.
- Texts say "the agent" and "the connected agent". Health shows "Agent: Hermes".
- "Brain" stays only for Nocheh itself ("a personal AI brain"), its pixel brain logo and the
  names of earlier ADR files.
- Hermes's own internals keep their names, such as `AIAgent` and its `agent.*` settings.
- Development mode: no aliases for the old names. Old rows keep their `brain` column and old
  codes, and a turn left in `spool/brain-turns` is not resumed.
</decision>

<consequences>
- One word, "agent", means the part that answers; "brain" means Nocheh.
- A running install picks the new names up on its next start; the Hermes container needs
  recreating for its new `spool/agent-turns` mount.
</consequences>
