"""Trusted parent exports subscription material only to the external broker."""
import os

BROKER='http://security:8786'

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

def broker_transport(credentials):
    headers={}
    if credentials.api_mode=='codex_responses':
        from agent.codex_headers import codex_cloudflare_headers
        headers=codex_cloudflare_headers(credentials.access_token)
    return {**credentials.runtime(),'headers':headers}
