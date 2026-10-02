# ADR-0086: Include guarded observations in reaction discovery

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0084](0084-scoped-reaction-discovery.md); supersedes its requirement for a
separate model-selected read to inspect every discovered observation.
</status>

<decision>
Current-reaction discovery returns the observed individual change or anonymous
counts together with its source handle and up to three independently authorized
target excerpts. Observations and excerpts use the existing guarded archive read
path. Control-store reaction values never become returned source content.

The existing ten-result and two-hundred-candidate bounds remain. Each observation
is limited to six thousand serialized characters and each target excerpt to two
thousand characters. Missing observation fields stay missing. Oversized evidence
is explicitly unavailable. Source, target, audience, generation, retirement and
supersession checks apply again before returning the combined result.
</decision>

<consequences>
An agent that discovers a reaction receives evidence of the change in the same
result, even when it does not choose another tool call. An empty individual
new-reaction list describes that actor's removal, not every participant's state
or task completion. Anonymous counts and bounded search results remain separate
and incomplete. Target excerpts may require a further read for full context.
</consequences>
