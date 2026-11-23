"""Test helpers that write a profile's Hermes session store through Hermes's storage interface (``native_store``)."""


def add_session(store, session_id, source='telegram', **fields):
    from persistence.conversation.sessions import NewSession
    return store.sessions.create(NewSession(session_id=session_id, source=source, **fields))


def add_message(store, session_id, role, content, **fields):
    from persistence.conversation.messages import NewMessage
    return store.messages.append(session_id, NewMessage.from_live({'role': role, 'content': content, **fields}))
