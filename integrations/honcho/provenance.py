"""Bounded, read-only ancestry from the pinned Honcho store; never a reasoning call."""
from collections import deque
import re

NATIVE_ID = re.compile(r'^[A-Za-z0-9_-]{21}$')


async def ancestry(roots, load_documents, load_messages, max_nodes=128, max_depth=8, max_messages=256):
    if (not isinstance(roots, list) or not 1 <= len(roots) <= 32
            or any(not isinstance(v, str) or not NATIVE_ID.fullmatch(v) for v in roots)
            or not 1 <= max_nodes <= 128 or not 1 <= max_depth <= 8 or not 1 <= max_messages <= 256):
        raise ValueError('invalid_provenance_request')
    pending = deque((v, 0) for v in dict.fromkeys(roots))
    seen, nodes, message_ids, limitations = set(), [], set(), {'ancestry_is_not_an_exact_citation'}
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
        ids = row.get('message_ids') or []
        if not isinstance(ids, list):
            ids = []
            limitations.add('message_links_unavailable')
        if len(ids) > max_messages or row.get('messages_truncated'):
            limitations.add('message_limit')
        for value in ids[:max_messages]:
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                if len(message_ids) < max_messages:
                    message_ids.add(value)
                elif value not in message_ids:
                    limitations.add('message_limit')
        nodes.append({'id': identifier, 'parents': parents, 'deleted': bool(row.get('deleted'))})
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
    messages = await load_messages(sorted(message_ids)) if message_ids else []
    found, references = set(), []
    for row in messages[:max_messages]:
        if row.get('id') not in message_ids:
            raise ValueError('provenance_message_mismatch')
        found.add(row['id'])
        public_id, receipt = row.get('public_id'), row.get('receipt_id')
        if isinstance(public_id, str) and NATIVE_ID.fullmatch(public_id) and isinstance(receipt, str) and re.fullmatch(r'[a-f0-9]{64}', receipt):
            references.append({'message_id': public_id, 'receipt_id': receipt})
        else:
            limitations.add('ingestion_reference_unavailable')
    if found != message_ids:
        limitations.add('message_unavailable')
    return {'roots': roots, 'nodes': nodes, 'messages': references, 'limitations': sorted(limitations), 'exact_citations': False}


def install(app):
    from fastapi import APIRouter, Body, Depends, HTTPException
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession
    from src.dependencies import read_db
    from src.security import require_auth

    router = APIRouter(prefix='/v3/workspaces/{workspace_id}/nocheh', dependencies=[Depends(require_auth(workspace_name='workspace_id'))])

    @router.post('/provenance')
    async def read(workspace_id: str, body: dict = Body(...), db: AsyncSession = read_db):
        async def documents(ids):
            # Scope every ancestor independently. Return neither conclusion text nor vectors.
            result = await db.execute(text('''SELECT id, deleted_at IS NOT NULL AS deleted,
                jsonb_path_query_array(source_ids, '$[0 to 127]') AS source_ids,
                jsonb_path_query_array(internal_metadata->'message_ids', '$[0 to 255]') AS message_ids,
                CASE WHEN jsonb_typeof(source_ids)='array' THEN jsonb_array_length(source_ids)>128 ELSE false END AS parents_truncated,
                CASE WHEN jsonb_typeof(internal_metadata->'message_ids')='array' THEN jsonb_array_length(internal_metadata->'message_ids')>256 ELSE false END AS messages_truncated
                FROM documents WHERE workspace_name=:workspace AND observer='source' AND observed='source' AND id=ANY(:ids) LIMIT 128'''),
                {'workspace': workspace_id, 'ids': ids})
            return [dict(row) for row in result.mappings()]

        async def messages(ids):
            result = await db.execute(text('''SELECT id,public_id,metadata->>'nocheh_receipt' AS receipt_id
                FROM messages WHERE workspace_name=:workspace AND peer_name='source' AND id=ANY(:ids) LIMIT 256'''),
                {'workspace': workspace_id, 'ids': ids})
            return [dict(row) for row in result.mappings()]

        try:
            return await ancestry(body.get('conclusion_ids'), documents, messages)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    app.include_router(router)
