"""Trusted parent exports subscription material only to the external broker."""
import os

BROKER='http://nocheh-security:8786'

def isolated_enabled():
    value=os.environ.get('NOCHEH_SECURITY_RUNTIME','legacy')
    if value not in ('legacy','isolated'):raise ValueError('invalid_security_runtime')
    return value=='isolated'

def scoped_transport(credential,api_mode):
    if api_mode=='codex_responses':
        return dict(api_key=credential,base_url=BROKER+'/codex',provider='openai-codex',api_mode=api_mode)
    if api_mode=='chat_completions':
        return dict(api_key=credential,base_url=BROKER+'/v1',provider='openai',api_mode=api_mode)
    raise ValueError('unsupported_security_transport')

def broker_transport(credentials,model=None):
    headers={}
    if credentials.api_mode=='codex_responses':
        from agent.codex_headers import codex_cloudflare_headers
        headers=codex_cloudflare_headers(credentials.access_token)
    result={**credentials.runtime(),'headers':headers}
    if model:
        from agent.model_metadata import get_model_context_length
        result['model_context_length']=get_model_context_length(model,base_url=credentials.base_url,api_key=credentials.access_token,provider=credentials.provider)
    return result

def install_isolated_route(credentials,model,context_length):
    """Preserve auxiliary routing and the original provider's context window."""
    if type(context_length) is not int or context_length<1:raise ValueError('model_context_metadata_required')
    from agent import auxiliary_client as aux,model_metadata,context_compressor
    original=model_metadata.get_model_context_length
    def length(selected,*args,**kwargs):
        return context_length if selected==model else original(selected,*args,**kwargs)
    model_metadata.get_model_context_length=length
    context_compressor.get_model_context_length=length
    if credentials.api_mode=='codex_responses':aux._CODEX_AUX_BASE_URL=credentials.base_url
    else:
        # These are scoped broker capabilities, not provider credentials. The
        # pinned generic auxiliary resolver reads OpenAI-compatible env names.
        os.environ['OPENAI_API_KEY']=credentials.access_token
        os.environ['OPENAI_BASE_URL']=credentials.base_url
