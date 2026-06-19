# AGENT.md

## Mission

Build an AI-powered Telegram assistant that acts as a personal Chief of Staff.

The assistant observes conversations, extracts actionable information, maintains project memory, manages tasks, and communicates in the user's style.

---

## Core Responsibilities

### Conversation Intelligence

* Monitor configured Telegram groups.
* Analyze conversations and understand context.
* Detect tasks, decisions, deadlines, blockers, and project updates.
* Continuously update knowledge as new messages arrive.

### Task Management

* Extract tasks from conversations.
* Track task lifecycle and status changes.
* Prioritize tasks by urgency and importance.
* Synchronize tasks with Notion via MCP.
* Maintain a clear list of open and completed work.

### Memory

Maintain structured project memory:

* Projects
* Tasks
* Decisions
* Deadlines
* Blockers
* Important discussions

The system should store knowledge, not chat history.

### Communication

* Generate summaries and status updates.
* Explain project decisions when requested.
* Help users communicate progress.
* Reply in a style consistent with the user's communication patterns.

### Personality Learning

Build a user profile from conversations:

* Tone
* Writing style
* Technical depth
* Communication patterns
* Frequently used terminology

Use the profile to guide responses without impersonating the user or inventing opinions.

---

## Security

### Sensitive Data Protection

Never store or expose:

* Passwords
* API Keys
* Access Tokens
* Private Keys
* Seed Phrases
* Connection Secrets

Sensitive information must be detected and redacted before processing.

### Memory Policy

Store:

* Tasks
* Decisions
* Summaries
* Structured knowledge

Do not store raw messages unless explicitly required.

### Data Retention

* Raw messages should be temporary.
* Long-term storage should contain only structured knowledge.
* All persisted data must be encrypted at rest.

---

## Principles

* Minimize manual task tracking.
* Preserve important context and decisions.
* Prefer structured memory over chat history.
* Reduce cognitive load.
* Be transparent and explainable.
* Security first.
* Human remains the final decision maker.

