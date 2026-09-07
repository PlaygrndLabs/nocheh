"""Combine an archive graph page with bounded, explicitly cited native notes."""
from urllib.parse import urlencode
from .archive import API


def read(scope,after='',focus=''):
    api=API();graph=api.call('/v1/graph?'+urlencode({'scope':scope,'after':after,'focus':focus}))
    profiles=api.call('/v1/manage/hermes',{'action':'profiles'})
    if scope not in {p['scope'] for p in profiles['profiles']}:return graph
    memory=api.call('/v1/manage/hermes',{'action':'memory','scope':scope})
    profile_id='profile:'+memory['profile']
    graph['nodes'].append({'id':profile_id,'kind':'profile','label':'Hermes profile'})
    graph['edges'].append({'from':'scope:'+scope,'to':profile_id,'kind':'native_profile'})
    present={node['id'] for node in graph['nodes']}
    for note in memory['memories']:
        if not note['exists']:continue
        node_id=profile_id+':'+note['name']
        visible=[id for id in note['citations'] if 'event:'+id in present]
        graph['nodes'].append({'id':node_id,'kind':'memory','label':note['name'],'text':note['text'],
            'sha256':note['sha256'],'truncated':note['truncated'],'unresolved_citations':len(note['citations'])-len(visible),
            'provenance':'Explicit references only; uncited text has no verified source provenance.'})
        graph['edges'].append({'from':profile_id,'to':node_id,'kind':'native_note'})
        for citation in visible:graph['edges'].append({'from':node_id,'to':'event:'+citation,'kind':'explicit_citation'})
    return graph
