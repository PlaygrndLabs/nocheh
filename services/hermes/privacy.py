"""Private audience filtering through the native subscription client, with no tools."""
import json
from .subscription import _call_subscription
from .prompts import text


def filter_knowledge(credentials, model, body):
    from .request_boundary import install
    from .compatibility_patch import install as native_gate
    import httpx
    if not getattr(httpx.Client._send_single_request,'_nocheh_boundary',False):
        install();native_gate()
    candidates=body.get('candidates')
    if not isinstance(candidates,list) or len(candidates)>10 or len(json.dumps(body))>60000:
        raise ValueError('invalid_privacy_input')
    from .archive_tools import ARCHIVE_CREDENTIAL
    # Nocheh sends only the words it searched for (ADR-0251). The model gets them as a list of words, never as a sentence,
    # even when the owner has replaced the filter's instruction.
    words=str(body.get('query') or '').split()[:12]
    binding=ARCHIVE_CREDENTIAL.set(body.get('archive_credential'))
    try:
        response=_call_subscription(credentials,model,[
            {'role':'system','content':
             text(body.get('prompts'),'sharing.group_filter')+' Additional owner privacy rules: '+str(body.get('instructions',''))},
            {'role':'user','content':json.dumps({'search_words':words,'candidates':candidates},ensure_ascii=False)}])
    finally: ARCHIVE_CREDENTIAL.reset(binding)

    result=json.loads(response.choices[0].message.content)
    if not isinstance(result,dict) or set(result)!={'items'}:raise ValueError('privacy_contract_rejected')
    # This provenance comes from the adapter, never from the model's JSON.
    result['producer']={'name':'hermes','version':'nocheh-privacy-v1','model':model,
                        'provider':credentials.provider,'api_mode':credentials.api_mode}
    return result
