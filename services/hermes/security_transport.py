"""Trusted parent exports provider credentials only to the external broker."""
import os

BROKER='http://nocheh-security:8786'

def isolated_enabled():
    value=os.environ.get('NOCHEH_SECURITY_RUNTIME','legacy')
    if value not in ('legacy','isolated'):raise ValueError('invalid_security_runtime')
    return value=='isolated'

def anthropic_reply_route():
    """Replies go to Anthropic itself. Its OpenAI-compatible API has no prompt caching, so
    isolated turns use its Messages API instead, through the broker."""
    from .subscription import ANTHROPIC_URL
    return os.environ.get('NOCHEH_REPLY_ROUTE_URL','').strip().rstrip('/')==ANTHROPIC_URL

def scoped_transport(credential,api_mode):
    if api_mode=='anthropic_messages' or (api_mode=='chat_completions' and anthropic_reply_route()):
        # Hermes sends the scoped credential as x-api-key; the broker reads it and sends Anthropic the provider key.
        return dict(api_key=credential,base_url=BROKER+'/anthropic',provider='anthropic',api_mode='anthropic_messages')
    if api_mode=='chat_completions':
        return dict(api_key=credential,base_url=BROKER+'/v1',provider='openai',api_mode=api_mode)
    raise ValueError('unsupported_security_transport')

def broker_transport(credentials,model=None):
    result={**credentials.runtime(),'headers':{}}
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
    # These are scoped broker capabilities, not provider credentials. The
    # pinned generic auxiliary resolver reads OpenAI-compatible env names, and
    # Hermes's helper calls (session search, titles, compression), pinned to that
    # resolver, use the broker's chat route.
    os.environ['OPENAI_API_KEY']=credentials.access_token
    os.environ['OPENAI_BASE_URL']=BROKER+'/v1'
