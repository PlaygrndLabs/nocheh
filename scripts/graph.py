"""Read original evidence; retain native-note enrichment for legacy stores only."""
from urllib.parse import urlencode
from .archive import API


def profile_label(profile,current):
    base='Hermes · '+profile['scope']
    if profile['profile'] in current:return base+' · current'
    detail='historical'
    if isinstance(profile.get('guard_epoch'),int) and profile['guard_epoch']>0:detail+=' guard '+str(profile['guard_epoch'])
    elif isinstance(profile.get('revision'),int) and profile['revision']>0:detail+=' revision '+str(profile['revision'])
    identity=str(profile['profile']);short=identity[len('nocheh-'):] if identity.startswith('nocheh-') else identity
    return base+' · '+detail+' · '+short[:12]


def read(scope,after='',focus=''):
    api=API();graph=api.call('/v1/graph?'+urlencode({'scope':scope,'after':after,'focus':focus}))
    if api.storage_layout == 'original-only-v1':
        return graph
    profiles=api.call('/v1/manage/hermes',{'action':'profiles'})
    choices=profiles.get('history_profiles',profiles['profiles'])
    choices=[p for p in choices if p.get('exists') and (scope=='*' or p['scope']==scope)]
    current={p['profile'] for p in profiles['profiles'] if p.get('exists')}
    graph['native_profiles_truncated']=len(choices)>20
    for profile in choices[:20]:
        memory=api.call('/v1/manage/hermes',{'action':'memory','scope':profile['scope'],'profile':profile['profile']})
        profile_id='profile:'+memory['profile']
        graph['nodes'].append({'id':profile_id,'kind':'profile','label':profile_label(profile,current)})
        graph['edges'].append({'from':'scope:'+scope,'to':profile_id,'kind':'native_profile'})
        present={node['id'] for node in graph['nodes']}
        for note in memory['memories']:
            if not note['exists']:continue
            node_id=profile_id+':'+note['name']
            visible=[id for id in note['citations'] if 'event:'+id in present]
            graph['nodes'].append({'id':node_id,'kind':'memory','label':note['name'],'text':note['text'][:8000],
                'sha256':note['sha256'],'truncated':note['truncated'] or len(note['text'])>8000,'unresolved_citations':len(note['citations'])-len(visible),
                'provenance':'Owner-only native note. Explicit references only; uncited text has no verified source provenance.'})
            graph['edges'].append({'from':profile_id,'to':node_id,'kind':'native_note'})
            for citation in visible:graph['edges'].append({'from':node_id,'to':'event:'+citation,'kind':'explicit_citation'})
    return graph
