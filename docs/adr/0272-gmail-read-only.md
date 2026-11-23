# ADR-0272: The owner's own Gmail, read only

<status>
Accepted on 2026-11-22, as step 4 of the shared and private connectors plan. On 2026-11-20 the owner
asked for Gmail read only, as a person's own connection. Follows the GitHub lookups of
[ADR-0270](0270-github-live-lookups.md) and the Connections page of
[ADR-0271](0271-connections-page.md).
</status>

## Context

Reading mail is a "restricted" Google permission. An app in Google's Testing status loses its
sign-in every 7 days. A public app needs Google's review and a paid security assessment. A
Google Cloud project in **Personal** mode needs neither: no review, no warning screen, and no
sign-in that runs out. Only the Google account that made the project can sign in, and the
mode can't be changed later.

## Decision

1. **The owner's own keys.** The owner makes a Personal mode project and a Web application
   OAuth client, adds the dashboard's return address `<origin>/?connect=gmail`, turns on the
   Gmail API, and pastes the client ID and secret into Connections › Yours › Your Gmail. A new
   client forgets the old sign-in.
2. **Sign-in.** OAuth with PKCE, offline access and the one scope `gmail.readonly`. A sign-in
   without that scope is refused (`gmail_scope_missing`). The client, the secret and the tokens
   live in `admin/connections/gmail.json` (0600), readable only by the management and executor
   services. No view returns the secret or a token. Disconnect asks Google to revoke the sign-in.
3. **Three reads.** A lookup is a controlled `mcp` operation with
   `{connection:'gmail', tool, input}`:
   - `search_mail {query}`: up to 20 messages, with sender, subject, date and snippet.
   - `read_message {id}`: one message's text, up to 20,000 characters, with its attachments
     named but never opened.
   - `read_thread {id}`: a whole conversation, up to 60,000 characters in all.

   Each input is checked (`src/gmail-arguments.ts`).
4. **Only the owner's private chat.** The owner's private chat, in a live turn or a schedule's
   running run, runs a lookup with no card (authority `gmail_read:own`). A lookup is refused, with
   403 `gmail_not_here`, in a group (even a project's), a member's or stranger's private chat, or
   a background job. It is checked
   again right before it runs (`gmailRunRefusal`).
5. **The answer** goes through the same secret check as every operation result. Nothing is
   copied into memory.

## Consequences

- A schedule's running run in the owner's private chat, such as a morning brief, reads mail
  as a live turn does, with no card (added 2026-11-23, as for Notion and GitHub in ADR-0278).
  It is checked again before it runs and refused once the run has ended. Background jobs still
  can't read mail.
- Each member who later connects their own Gmail (step 5) needs their own Personal mode project.
- If the Gmail API is off in the project, the owner sees `gmail_api_off` in plain words.
- Checks: `services/hermes/test_gmail_connection.py`, `test/store-gmail-lookups.test.ts`, the
  MCP unit test, and the "your Gmail" dashboard browser test.
