"""Seed only the marked native fixture through pinned Honcho ORM models."""
import asyncio,datetime,json,sys
sys.path.insert(0,'/app')
from sqlalchemy import text
from src.db import SessionLocal
from src import models

async def main():
    async with SessionLocal() as db:
        assert (await db.execute(text("SELECT current_setting('cluster_name')"))).scalar_one()=='nocheh-native-portable-fixture'
        for table in ('workspaces','queue','documents'):
            assert (await db.execute(text('SELECT count(*) FROM '+table))).scalar_one()==0
        db.add(models.Workspace(name='fixture'));await db.flush()
        db.add(models.Peer(name='owner',workspace_name='fixture'));await db.flush()
        db.add(models.Session(name='conversation',workspace_name='fixture'));await db.flush()
        message=models.Message(content='Exact native evidence\r\n🙂',workspace_name='fixture',session_name='conversation',peer_name='owner',
            seq_in_session=1,token_count=6,h_metadata={'source_reference':{'store':'archive','id':'a'*64,'revision':'1','input_hash':'b'*64}})
        db.add(message);await db.flush()
        vector=[0.125,-0.25]+[0.0]*1534
        db.add(models.MessageEmbedding(content=message.content,embedding=vector,message_id=message.public_id,
            workspace_name='fixture',session_name='conversation',peer_name='owner'));await db.flush()
        db.add(models.Collection(observer='owner',observed='owner',workspace_name='fixture'));await db.flush()
        parent=models.Document(content='Contextual native meaning',embedding=vector,source_ids=[message.public_id],
            observer='owner',observed='owner',workspace_name='fixture',session_name='conversation')
        db.add(parent);await db.flush()
        db.add(models.Document(content='Retired native interpretation',embedding=vector,source_ids=[parent.id],
            observer='owner',observed='owner',workspace_name='fixture',session_name='conversation',deleted_at=datetime.datetime(2026,9,1,tzinfo=datetime.timezone.utc)))
        await db.execute(models.session_peers_table.insert().values(workspace_name='fixture',session_name='conversation',peer_name='owner'))
        await db.commit()
    print(json.dumps({'seeded':True,'embedding_dimensions':1536,'provider_calls':0}))

asyncio.run(main())
