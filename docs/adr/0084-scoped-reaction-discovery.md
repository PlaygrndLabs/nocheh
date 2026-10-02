# ADR-0084: Scoped discovery of current reaction evidence

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0051](0051-platform-independent-sources.md) and
[0053](0053-original-only-archive.md) on source relationships and guarded retrieval.
</status>

<decision>
The existing archive search tool has a current-reactions mode that does not
require message words or a target ID. It examines at most two hundred recently
updated current-state rows and returns at most ten permitted reaction source
handles with independently permitted target handles. Individual observations
and anonymous aggregates remain separate sources. The model reads those sources
through the existing guarded archive read path to inspect their evidence.

Discovery applies current generation, topic, retirement, and supersession checks
before returning handles and rechecks them before completion. Source handles do
not grant access. The control store's unguarded reaction values never become tool
content. Results explicitly remain incomplete, including an empty result.
Ordinary lexical search continues to match independent message text only.
</decision>

<consequences>
An agent can find a removed reaction even when the reaction update has no message
text and the older note's ID is unknown. A result identifies captured evidence;
it does not prove exhaustive Telegram state or assign task-completion meaning.
Large archives can exceed the bounded candidate window. Other-topic activity
cannot broaden access, and hidden candidates do not expose source identifiers.
</consequences>
