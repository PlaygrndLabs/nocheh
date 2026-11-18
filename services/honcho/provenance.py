"""Bounded ancestry and queue checks on the pinned Honcho store; never a reasoning call."""
from collections import deque
import re

NATIVE_ID = re.compile(r'^[A-Za-z0-9_-]{21}$')


async def failed_queue_items(workspace_id, db, since=None):
    """Report only whether current-workspace derivation has terminal failures.

    ``since`` limits the answer to work queued after Nocheh last saw the queue
    drained. Honcho keeps failed items for 30 days, so without it one old
    failure would hold the workspace unready for that long."""
    from sqlalchemy import text
    values = {'workspace': workspace_id, **({'since': since} if since is not None else {})}
    result = await db.execute(text('''SELECT EXISTS(
        SELECT 1 FROM queue WHERE workspace_name=:workspace
        AND task_type IN ('representation','summary','dream')
        AND processed AND error IS NOT NULL''' + (' AND created_at > :since' if since is not None else '') + ')'), values)
    return bool(result.scalar_one())


FAILED_LEARNING = '''workspace_name=:workspace AND task_type IN ('representation','summary','dream')
    AND processed AND error IS NOT NULL'''


async def failed_learning_count(workspace_id, db):
    """How many of the workspace's derivation tasks ended with a terminal error, without their payloads or errors."""
    from sqlalchemy import text
    result = await db.execute(text('SELECT count(*) FROM queue WHERE ' + FAILED_LEARNING), {'workspace': workspace_id})
    return int(result.scalar_one())


async def retry_failed_learning(workspace_id, db):
    """Return the workspace's failed derivation tasks to Honcho's own queue, as if never attempted.

    Honcho marks a terminal failure processed with its error and never retries it, so learning lost to
    a provider outage stays lost. Clearing both lets the deriver run the task again on its saved messages;
    nothing is resent and no message is changed."""
    from sqlalchemy import text
    result = await db.execute(text('''UPDATE queue SET processed=false, error=NULL, payload=payload - '_retry_attempts'::text
        WHERE ''' + FAILED_LEARNING), {'workspace': workspace_id})
    await db.commit()
    return int(result.rowcount)


async def ancestry(roots, load_documents, load_messages, max_nodes=128, max_depth=8, max_messages=256):
    """Follow conclusions to the messages behind them.

    Honcho 3.5+ records the messages an explicit conclusion cites. A conclusion without citations (written before,
    or whose model left them out) falls back to its whole derivation batch, which is not an exact citation. Each
    node says which it used: true for citations, false for a batch, null when it brought no messages. The answer is
    exact only when every node that brought messages cites them, and cited messages come first."""
    if (not isinstance(roots, list) or not 1 <= len(roots) <= 32
            or any(not isinstance(v, str) or not NATIVE_ID.fullmatch(v) for v in roots)
            or not 1 <= max_nodes <= 128 or not 1 <= max_depth <= 8 or not 1 <= max_messages <= 256):
        raise ValueError('invalid_provenance_request')
    pending = deque((v, 0) for v in dict.fromkeys(roots))
    seen, nodes, limitations, cited, batch = set(), [], set(), {}, {}
    while pending and len(seen) < max_nodes:
        identifier, depth = pending.popleft()
        if identifier in seen:
            continue
        seen.add(identifier)
        rows = await load_documents([identifier])
        if not rows:
            limitations.add('conclusion_unavailable')
            continue
        row = rows[0]
        if row.get('id') != identifier:
            raise ValueError('provenance_identity_mismatch')
        parents = row.get('source_ids') or []
        if not isinstance(parents, list):
            parents = []
            limitations.add('ancestry_unavailable')
        if len(parents) > max_nodes or row.get('parents_truncated'):
            limitations.add('ancestry_limit')
        parents = [v for v in parents[:max_nodes] if isinstance(v, str) and NATIVE_ID.fullmatch(v)]
        exact = isinstance(row.get('cited_ids'), list) and bool(row['cited_ids'])
        ids = row['cited_ids'] if exact else row.get('message_ids') or []
        if not isinstance(ids, list):
            ids = []
            limitations.add('message_links_unavailable')
        if len(ids) > max_messages or row.get('citations_truncated' if exact else 'messages_truncated'):
            limitations.add('message_limit')
        links = cited if exact else batch
        valid = [v for v in ids[:max_messages] if isinstance(v, int) and not isinstance(v, bool) and v > 0]
        for value in valid:
            if len(links) < max_messages:
                links[value] = None
            elif value not in links:
                limitations.add('message_limit')
        if valid and not exact:
            limitations.add('ancestry_is_not_an_exact_citation')
        nodes.append({'id': identifier, 'parents': parents, 'deleted': bool(row.get('deleted')), 'exact_citations': exact if valid else None})
        if not parents and not ids:
            limitations.add('message_links_unavailable')
        if depth >= max_depth and parents:
            limitations.add('depth_limit')
        elif parents:
            # The queue itself is bounded, not just the number of rows visited.
            for parent in parents:
                if parent not in seen and all(v[0] != parent for v in pending):
                    if len(seen) + len(pending) >= max_nodes:
                        limitations.add('ancestry_limit')
                        break
                    pending.append((parent, depth + 1))
    if pending:
        limitations.add('ancestry_limit')
    wanted = [*cited, *(v for v in batch if v not in cited)]
    if len(wanted) > max_messages:
        limitations.add('message_limit')
        wanted = wanted[:max_messages]
    messages = await load_messages(wanted) if wanted else []
    found, references = {}, []
    for row in messages[:max_messages]:
        if row.get('id') not in wanted:
            raise ValueError('provenance_message_mismatch')
        found[row['id']] = row
    for value in wanted:
        if value not in found:
            limitations.add('message_unavailable')
            continue
        public_id, receipt = found[value].get('public_id'), found[value].get('receipt_id')
        if isinstance(public_id, str) and NATIVE_ID.fullmatch(public_id) and isinstance(receipt, str) and re.fullmatch(r'[a-f0-9]{64}', receipt):
            references.append({'message_id': public_id, 'receipt_id': receipt})
        else:
            limitations.add('ingestion_reference_unavailable')
    exact = any(node['exact_citations'] for node in nodes) and all(node['exact_citations'] is not False for node in nodes)
    return {'roots': roots, 'nodes': nodes, 'messages': references, 'limitations': sorted(limitations), 'exact_citations': exact}


BATCH_MESSAGES = 8


async def fact_batches(body, load_documents, load_messages, max_roots=128, per_node=BATCH_MESSAGES):
    """Facts mode: the messages behind each named conclusion, one node per conclusion, parents never followed.

    Honcho's own conclusion list already names the messages a conclusion cites, so Nocheh asks here only for
    conclusions without citations. Each node brings the first few messages of the batch it was learned from,
    which is never an exact citation; a conclusion that does cite brings its citations instead. ``messages_truncated``
    says when a node had more messages than it brings."""
    if (not isinstance(body, dict) or set(body) - {'conclusion_ids', 'depth', 'per_node'}
            or body.get('per_node') is not True or body.get('depth', 0) != 0 or isinstance(body.get('depth', 0), bool)):
        raise ValueError('invalid_provenance_request')
    roots = body.get('conclusion_ids')
    if (not isinstance(roots, list) or not 1 <= len(roots) <= max_roots
            or any(not isinstance(v, str) or not NATIVE_ID.fullmatch(v) for v in roots)):
        raise ValueError('invalid_provenance_request')
    roots = list(dict.fromkeys(roots))
    rows, limitations = {}, set()
    for row in await load_documents(roots):
        if row.get('id') not in roots:
            raise ValueError('provenance_identity_mismatch')
        rows[row['id']] = row
    wanted, picked = {}, {}
    for identifier in roots:
        row = rows.get(identifier)
        if row is None:
            limitations.add('conclusion_unavailable')
            continue
        exact = isinstance(row.get('cited_ids'), list) and bool(row['cited_ids'])
        ids = row['cited_ids'] if exact else row.get('message_ids') or []
        if not isinstance(ids, list):
            ids = []
            limitations.add('message_links_unavailable')
        valid = list(dict.fromkeys(v for v in ids if isinstance(v, int) and not isinstance(v, bool) and v > 0))
        truncated = len(valid) > per_node or bool(row.get('citations_truncated' if exact else 'messages_truncated'))
        picked[identifier] = (exact, valid[:per_node], truncated)
        for value in valid[:per_node]:
            wanted[value] = None
    found = {}
    for row in (await load_messages(list(wanted), len(wanted)) if wanted else []):
        if row.get('id') not in wanted:
            raise ValueError('provenance_message_mismatch')
        found[row['id']] = row
    nodes = []
    for identifier in roots:
        if identifier not in picked:
            continue
        exact, ids, truncated = picked[identifier]
        references = []
        for value in ids:
            row = found.get(value)
            if row is None:
                limitations.add('message_unavailable')
                truncated = True
                continue
            public_id, receipt = row.get('public_id'), row.get('receipt_id')
            if isinstance(public_id, str) and NATIVE_ID.fullmatch(public_id) and isinstance(receipt, str) and re.fullmatch(r'[a-f0-9]{64}', receipt):
                references.append({'message_id': public_id, 'receipt_id': receipt})
            else:
                limitations.add('ingestion_reference_unavailable')
                truncated = True
        if truncated:
            limitations.add('message_limit')
        if references and not exact:
            limitations.add('ancestry_is_not_an_exact_citation')
        if not references:
            limitations.add('message_links_unavailable')
        parents = rows[identifier].get('source_ids') or []
        nodes.append({'id': identifier, 'parents': [v for v in parents if isinstance(v, str) and NATIVE_ID.fullmatch(v)] if isinstance(parents, list) else [],
                      'deleted': bool(rows[identifier].get('deleted')), 'exact_citations': exact if references else None,
                      'messages': references, 'messages_truncated': truncated})
    return {'roots': roots, 'nodes': nodes, 'limitations': sorted(limitations)}


async def provenance(body, load_documents, load_messages):
    """The provenance route: facts mode when the body asks for it, else the owner's flat ancestry trace."""
    if isinstance(body, dict) and 'per_node' in body:
        return await fact_batches(body, load_documents, load_messages)
    return await ancestry(body.get('conclusion_ids') if isinstance(body, dict) else None, load_documents, load_messages)


# How many of a workspace's live explicit conclusions cite their messages, know only their learning batch, or neither.
COVERAGE_SQL = '''SELECT count(*) AS explicit,
    count(*) FILTER (WHERE cited) AS cited,
    count(*) FILTER (WHERE NOT cited AND batch) AS batch_only
    FROM (SELECT EXISTS (SELECT 1 FROM conclusion_source_messages s WHERE s.tenant_id=d.tenant_id AND s.conclusion_id=d.id) AS cited,
        (jsonb_typeof(d.internal_metadata->'message_ids')='array' AND jsonb_array_length(d.internal_metadata->'message_ids')>0) AS batch
        FROM documents d WHERE d.workspace_name=:workspace AND d.level='explicit' AND d.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.tenant_id=d.tenant_id AND x.workspace_name=d.workspace_name
            AND x.name=d.session_name AND x.deleted_at IS NOT NULL)) c'''


async def citation_coverage(workspace_id, db):
    """Counts only; never a conclusion's text or ids."""
    from sqlalchemy import text
    row = (await db.execute(text(COVERAGE_SQL), {'workspace': workspace_id})).mappings().one()
    explicit, cited, batch_only = int(row['explicit']), int(row['cited']), int(row['batch_only'])
    return {'explicit': explicit, 'cited': cited, 'batch_only': batch_only, 'none': explicit - cited - batch_only}


# Scope every ancestor independently. Return neither conclusion text nor vectors. Parent links live in Honcho's
# document_sources table and cited messages in conclusion_source_messages, each in its recorded order.
DOCUMENTS_SQL = '''SELECT d.id, d.deleted_at IS NOT NULL AS deleted,
    COALESCE((SELECT jsonb_agg(p.source_id ORDER BY p.position) FROM (SELECT source_id, position FROM document_sources
        WHERE derived_id=d.id ORDER BY position LIMIT 128) p), '[]'::jsonb) AS source_ids,
    jsonb_path_query_array(d.internal_metadata->'message_ids', '$[0 to 255]') AS message_ids,
    (SELECT jsonb_agg(c.id ORDER BY c.position, c.message_id) FROM (SELECT m.id, s.message_id, s.position FROM conclusion_source_messages s
        JOIN messages m ON m.tenant_id=s.tenant_id AND m.public_id=s.message_id
        WHERE s.tenant_id=d.tenant_id AND s.conclusion_id=d.id ORDER BY s.position, s.message_id LIMIT 256) c) AS cited_ids,
    EXISTS (SELECT 1 FROM document_sources WHERE derived_id=d.id OFFSET 128) AS parents_truncated,
    EXISTS (SELECT 1 FROM conclusion_source_messages WHERE tenant_id=d.tenant_id AND conclusion_id=d.id OFFSET 256) AS citations_truncated,
    CASE WHEN jsonb_typeof(d.internal_metadata->'message_ids')='array' THEN jsonb_array_length(d.internal_metadata->'message_ids')>256 ELSE false END AS messages_truncated
    FROM documents d WHERE d.workspace_name=:workspace AND d.id=ANY(:ids) LIMIT 128'''


MESSAGES_SQL = '''SELECT id,public_id,metadata->>'nocheh_receipt' AS receipt_id
    FROM messages WHERE workspace_name=:workspace AND id=ANY(:ids) LIMIT :limit'''


SESSION_ID = re.compile(r'^[a-f0-9]{64}$')
DESCENDANTS_SQL = '''WITH RECURSIVE seed AS (
    SELECT id FROM documents WHERE workspace_name=:workspace AND session_name=:session
), messages_seed AS (
    SELECT id FROM messages WHERE workspace_name=:workspace AND session_name=:session
), tree(id, depth) AS (
    SELECT d.id, 1 FROM documents d
    WHERE d.workspace_name=:workspace AND d.deleted_at IS NULL AND d.session_name IS DISTINCT FROM :session
    AND (EXISTS (SELECT 1 FROM document_sources s JOIN seed ON seed.id=s.source_id WHERE s.derived_id=d.id)
        OR (jsonb_typeof(d.internal_metadata->'message_ids')='array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(d.internal_metadata->'message_ids') link(value)
            JOIN messages_seed m ON jsonb_typeof(link.value)='number' AND m.id=(link.value)::text::bigint)))
    UNION
    SELECT d.id, tree.depth+1 FROM tree
    JOIN document_sources s ON s.source_id=tree.id AND s.workspace_name=:workspace
    JOIN documents d ON d.id=s.derived_id
    WHERE d.workspace_name=:workspace AND d.deleted_at IS NULL AND d.session_name IS DISTINCT FROM :session AND tree.depth<8
)
SELECT DISTINCT id FROM tree ORDER BY id LIMIT :limit'''


async def session_descendants(body, load):
    """Conclusions outside a session that were derived from it, so deleting the session leaves none behind."""
    if not isinstance(body, dict) or set(body) - {'session_id', 'limit'}:
        raise ValueError('invalid_descendants_request')
    session, limit = body.get('session_id'), body.get('limit', 100)
    if not isinstance(session, str) or not SESSION_ID.fullmatch(session) or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError('invalid_descendants_request')
    ids = await load(session, limit + 1)
    if any(not isinstance(v, str) or not NATIVE_ID.fullmatch(v) for v in ids):
        raise ValueError('descendant_identity_invalid')
    return {'ids': ids[:limit], 'truncated': len(ids) > limit}


def install(app):
    from fastapi import APIRouter, Body, Depends, HTTPException
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession
    from src.dependencies import db as write_db, read_db
    from src.security import require_auth

    router = APIRouter(prefix='/v3/workspaces/{workspace_id}/nocheh', dependencies=[Depends(require_auth(workspace_name='workspace_id'))])

    @router.get('/queue-health')
    async def queue_health(workspace_id: str, since: str | None = None, db: AsyncSession = read_db):
        from datetime import datetime
        try: after = datetime.fromisoformat(since) if since is not None else None
        except ValueError: raise HTTPException(status_code=400, detail='invalid_since') from None
        if after is not None and after.tzinfo is None: raise HTTPException(status_code=400, detail='invalid_since')
        return {'failed_items': await failed_queue_items(workspace_id, db, after)}

    @router.get('/failed-learning')
    async def failed_learning(workspace_id: str, db: AsyncSession = read_db):
        return {'failed': await failed_learning_count(workspace_id, db)}

    @router.post('/failed-learning/retry')
    async def retry_learning(workspace_id: str, db: AsyncSession = write_db):
        return {'retried': await retry_failed_learning(workspace_id, db)}

    @router.post('/provenance')
    async def read(workspace_id: str, body: dict = Body(...), db: AsyncSession = read_db):
        async def documents(ids):
            result = await db.execute(text(DOCUMENTS_SQL), {'workspace': workspace_id, 'ids': ids})
            return [dict(row) for row in result.mappings()]

        async def messages(ids, limit=256):
            result = await db.execute(text(MESSAGES_SQL), {'workspace': workspace_id, 'ids': ids, 'limit': limit})
            return [dict(row) for row in result.mappings()]

        try:
            return await provenance(body, documents, messages)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    @router.get('/citation-coverage')
    async def coverage(workspace_id: str, db: AsyncSession = read_db):
        return await citation_coverage(workspace_id, db)

    @router.post('/session-descendants')
    async def descendants(workspace_id: str, body: dict = Body(...), db: AsyncSession = read_db):
        async def load(session, limit):
            result = await db.execute(text(DESCENDANTS_SQL), {'workspace': workspace_id, 'session': session, 'limit': limit})
            return [row[0] for row in result.all()]

        try:
            return await session_descendants(body, load)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    app.include_router(router)
