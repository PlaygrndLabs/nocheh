"""Nocheh's door to a profile's Hermes session store (Hermes's storage interface, ``persistence_assembly``).

Hermes keeps each profile's sessions in ``<profile>/state.db``. An isolated turn may write only the profile's data
folders, so Nocheh keeps that file in ``<profile>/native-state/`` (``isolated_profile.database_path``).
``install_store_paths`` maps every store Hermes opens in this process to that file; ``writer`` and ``reader`` open
it for Nocheh's own code."""
import contextlib
from pathlib import Path

from .isolated_profile import database_path, native_path


def install_store_paths():
    """Map each ``state.db`` Hermes's storage layer opens to the profile's durable one. The holder registry keys
    stores by path, so it maps before keying: one writer per database. Returns a function that undoes it."""
    import persistence_assembly
    from persistence.sqlite import _holder, _registry
    if getattr(persistence_assembly._state_db, '_nocheh_data_path', False): return lambda: None
    location, acquire, initialize = persistence_assembly._state_db, _registry.acquire, _holder.StoreHolder.__init__
    def state_db(scope): return native_path(location(scope))
    def mapped_acquire(db_path): return acquire(native_path(db_path))
    def mapped_initialize(self, db_path, *args, **kwargs): return initialize(self, native_path(db_path), *args, **kwargs)
    state_db._nocheh_data_path = True
    persistence_assembly._state_db, _registry.acquire, _holder.StoreHolder.__init__ = state_db, mapped_acquire, mapped_initialize
    def restore():
        persistence_assembly._state_db, _registry.acquire, _holder.StoreHolder.__init__ = location, acquire, initialize
    return restore


def open_writer(profile):
    """A writable handle on ``profile``'s store, created when it does not exist yet; the caller closes it."""
    from persistence_assembly import open_persistence, profile_scope
    install_store_paths()
    return open_persistence(profile_scope(home=Path(profile)), eager=True)


@contextlib.contextmanager
def writer(profile):
    """``open_writer`` for one block."""
    store = open_writer(profile)
    try: yield store
    finally: store.close()


@contextlib.contextmanager
def reader(profile):
    """A read-only handle on ``profile``'s existing store: it never creates, migrates or repairs one."""
    from persistence_assembly import open_persistence_reader
    with open_persistence_reader(database_path(profile)) as store: yield store


def session_row(store, session_id):
    """The session's row as a dict, or None when the profile has no such session."""
    record = store.sessions.get(session_id)
    return None if record is None else record.as_session_row()


def conversation(store, session_id):
    """The session's active messages as the model reads them."""
    from persistence.conversation.messages import ConversationRequest
    return [message.as_openai_message() for message in store.messages.read_conversation(session_id, ConversationRequest())]


def messages(store, session_id, limit=None, offset=0, latest=False):
    """The session's active transcript rows, oldest first."""
    from persistence.conversation.messages import TranscriptRead
    request = TranscriptRead(limit=limit, offset=offset, latest=latest)
    return [row.as_wire_row() for row in store.messages.read_transcript(session_id, request)]


def recent_sessions(store, limit, offset=0):
    """Hermes's own session list, most recently active first: no empty or hidden sessions, and a conversation that
    went on after its history was shortened listed once, by its latest part."""
    from persistence.conversation.sessions import SessionOrder, SessionQuery, SessionWindow
    query = SessionQuery(min_message_count=1, order=SessionOrder.LAST_ACTIVE)
    return [entry.as_list_row() for entry in store.sessions.list_sessions(query, SessionWindow(limit=limit, offset=offset))]
