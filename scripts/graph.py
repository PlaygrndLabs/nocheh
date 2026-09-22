"""Read the bounded context-entity graph used by the owner dashboard."""
from urllib.parse import urlencode
from .archive import API

CONTEXT_KINDS = ('user','project','group','message')
KIND_ALIASES = {'author':'user','scope':'group'}

def context_entities(graph):
    """Keep durable context entities even while an older API is being upgraded."""
    ids={};nodes=[]
    for source in graph.get('nodes',[]):
        kind=KIND_ALIASES.get(source.get('kind'),source.get('kind'))
        if kind not in CONTEXT_KINDS:continue
        old_id=source.get('id','');suffix=old_id.split(':',1)[1] if ':' in old_id else old_id
        node_id=kind+':'+suffix
        ids[old_id]=node_id;nodes.append({**source,'id':node_id,'kind':kind})
    graph={**graph,'format':'nocheh-context-graph-v1','nodes':nodes}
    graph['edges']=[{**edge,'from':ids[edge['from']],'to':ids[edge['to']]}
        for edge in graph.get('edges',[]) if edge.get('from') in ids and edge.get('to') in ids]
    previous=graph.get('bounds',{})
    graph['bounds']={kind+'s':sum(node['kind']==kind for node in nodes) for kind in CONTEXT_KINDS}
    graph['bounds']['truncated']=bool(previous.get('truncated',False))
    graph.pop('native_profiles_truncated',None)
    graph['note']='Context entities only: users, projects, groups, and original messages. Actions, events, files, runtime context, and generated artifacts are excluded.'
    return graph


def read(scope,after='',focus=''):
    api=API();graph=api.call('/v1/graph?'+urlencode({'scope':scope,'after':after,'focus':focus}))
    return context_entities(graph)
