"""Small pinned-Hermes gate: unsupported transports cannot bypass HTTPX guarding."""
from functools import wraps
from .request_boundary import GuardUnavailable

SUPPORTED_API_MODES={'codex_responses','chat_completions','anthropic_messages'}


def check_route(agent):
    if getattr(agent,'api_mode',None) not in SUPPORTED_API_MODES or getattr(agent,'provider',None)=='moa':
        raise GuardUnavailable('unsupported_model_transport')


def install():
    from agent import chat_completion_helpers as calls
    from agent import auxiliary_client as aux
    from agent.transports.codex_app_server_session import CodexAppServerSession
    originals=[]
    for name in ('direct_api_call','interruptible_api_call','interruptible_streaming_api_call'):
        original=getattr(calls,name)
        def wrap(fn):
            @wraps(fn)
            def call(agent,*args,**kwargs):
                check_route(agent)
                return fn(agent,*args,**kwargs)
            return call
        originals.append((calls,name,original));setattr(calls,name,wrap(original))
    original_resolve=aux.resolve_provider_client
    @wraps(original_resolve)
    def resolve(provider,*args,**kwargs):
        normalized=aux._normalize_aux_provider(provider)
        if normalized in ('bedrock','moa') or (kwargs.get('api_mode') is not None and kwargs['api_mode'] not in SUPPORTED_API_MODES):
            raise GuardUnavailable('unsupported_auxiliary_transport')
        return original_resolve(provider,*args,**kwargs)
    originals.append((aux,'resolve_provider_client',original_resolve));aux.resolve_provider_client=resolve
    def deny(*args,**kwargs):
        raise GuardUnavailable('unsupported_model_transport')
    # The app-server subprocess and Bedrock do not use the inspected HTTPX seam.
    # Refuse them before startup instead of pretending a general hook covers them.
    originals.append((CodexAppServerSession,'__init__',CodexAppServerSession.__init__))
    CodexAppServerSession.__init__=deny
    originals.append((aux._BedrockCompletionsAdapter,'create',aux._BedrockCompletionsAdapter.create))
    aux._BedrockCompletionsAdapter.create=deny
    def restore():
        for target,name,original in reversed(originals):setattr(target,name,original)
    return restore
