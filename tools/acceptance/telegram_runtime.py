"""Run the real Hermes runtime against the isolated fixture's HTTP Bot API."""
import inspect
import os
from tools.acceptance.telegram_mock import TOKEN


def install_transport():
    if os.environ.get('NOCHEH_INSTALLATION_FIXTURE')!='1':raise ValueError('explicit_fixture_required')
    import httpx
    from telegram import Bot
    original=Bot.__init__;signature=inspect.signature(original)
    original_sync=httpx.HTTPTransport.handle_request
    original_async=httpx.AsyncHTTPTransport.handle_async_request
    def initialize(self,*args,**kwargs):
        bound=signature.bind(self,*args,**kwargs)
        if bound.arguments.get('token')!=TOKEN:raise ValueError('synthetic_telegram_token_required')
        return original(*bound.args,**bound.kwargs)
    def route(request):
        # Rewrite only after the production boundary has inspected the actual
        # Bot API request. Capture, current authority, parsing and policy stay
        # intact; model requests still cross the unchanged mandatory guard.
        url=request.url
        if url.scheme!='https' or url.host!='api.telegram.org' or url.port not in (None,443):return request
        if not any(url.path.startswith(prefix) for prefix in ('/bot'+TOKEN+'/', '/file/bot'+TOKEN+'/')):
            raise ValueError('synthetic_telegram_token_required')
        return httpx.Request(request.method,url.copy_with(scheme='http',host='cliproxy-api',port=8317),
            headers={**dict(request.headers),'host':'cliproxy-api:8317'},
            stream=request.stream,extensions=dict(request.extensions))
    def send(self,request):return original_sync(self,route(request))
    async def async_send(self,request):return await original_async(self,route(request))
    Bot.__init__=initialize
    httpx.HTTPTransport.handle_request=send
    httpx.AsyncHTTPTransport.handle_async_request=async_send
    def restore():
        Bot.__init__=original
        httpx.HTTPTransport.handle_request=original_sync
        httpx.AsyncHTTPTransport.handle_async_request=original_async
    return restore


def main():
    install_transport()
    from services.hermes.runtime import main as runtime
    runtime()


if __name__=='__main__':main()
