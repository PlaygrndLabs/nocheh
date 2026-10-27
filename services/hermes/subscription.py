"""Resolve the reasoning transport of each part: the provider chosen in Settings › Models."""

from dataclasses import dataclass, field
import os
import time

# The security broker relays every isolated model call to the configured reply provider.
BROKER_URL = "http://nocheh-security:8786/v1"
# Installation rehearsals serve models from this local fixture; nothing else may use http.
FIXTURE_URL = "http://model-fixture:8317/v1"
# Wait before the secret check's one retry after a provider server error.
RETRY_SECONDS = 2


class DetectorContractError(ValueError):
    """A detector reply outside the contract. `shape` describes the reply without its content."""

    def __init__(self, kind, shape=None):
        super().__init__(kind)
        self.shape = shape or {}


def reply_shape(content, finish_reason=None):
    """Lengths and flags only: what a rejected detector reply looked like, never what it said."""
    if not isinstance(content, str):
        return {'type': type(content).__name__, 'finish_reason': finish_reason}
    stripped = content.strip()
    start, end = stripped.find('{'), stripped.rfind('}')
    return {'length': len(content), 'fence': '```' in content, 'object': start >= 0 and end > start,
            'prose_before': start > 0 if start >= 0 else bool(stripped),
            'prose_after': 0 <= end < len(stripped) - 1, 'finish_reason': finish_reason}


def embedded_literals(content):
    """The literals list of the single distinct {"literals": [...]} object inside prose or a fence.
    No object, or two different ones, is not an answer."""
    import json
    decoder, found = json.JSONDecoder(), []
    for index, char in enumerate(content):
        if char != '{':
            continue
        try:
            value, _ = decoder.raw_decode(content, index)
        except ValueError:
            continue
        if isinstance(value, dict) and set(value) == {"literals"} and value not in found:
            found.append(value)
    return found[0] if len(found) == 1 else None


def detector_reply(content, text, finish_reason=None):
    """The literals of a detector reply, or a contract error. Some models wrap the JSON
    in a Markdown code fence or a sentence; the one {"literals": [...]} object inside is used."""
    import json
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError):
        parsed = embedded_literals(content) if isinstance(content, str) else None
        if parsed is None:
            raise DetectorContractError('detector_json_rejected', reply_shape(content, finish_reason)) from None
    if not isinstance(parsed, dict) or set(parsed) != {"literals"}:
        raise DetectorContractError('detector_shape_rejected', reply_shape(content, finish_reason))
    candidates = parsed["literals"]
    if not isinstance(candidates, list) or any(
        not isinstance(value, str) or not value or value not in text for value in candidates
    ):
        raise DetectorContractError('detector_literal_rejected', reply_shape(content, finish_reason))
    return candidates


class ProviderNotConfigured(RuntimeError):
    """The part has no provider; it is chosen in Settings › Models."""

    def __init__(self):
        super().__init__("provider_not_configured")


@dataclass(frozen=True)
class SubscriptionCredentials:
    access_token: str = field(repr=False)
    base_url: str = BROKER_URL
    provider: str = "openai"
    api_mode: str = "chat_completions"

    def __post_init__(self):
        allowed = {BROKER_URL} | configured_urls()
        if (not isinstance(self.access_token, str) or not self.access_token.strip()
                or self.base_url.rstrip("/") not in allowed
                or (self.provider, self.api_mode) != ("openai", "chat_completions")):
            raise ValueError("A configured reasoning transport is required")

    def runtime(self):
        return {"api_key": self.access_token, "base_url": self.base_url,
                "provider": self.provider, "api_mode": self.api_mode}


# Settings › Models gives replies and the secret check each an OpenAI-compatible
# HTTPS provider and its key.
PARTS = {"reply": "NOCHEH_REPLY_ROUTE", "guard": "NOCHEH_GUARD_ROUTE"}


def fixture_enabled() -> bool:
    return os.environ.get("NOCHEH_INSTALLATION_FIXTURE") == "1"


def configured_urls():
    """Provider addresses the owner chose: HTTPS only, or the rehearsal fixture inside a fixture."""
    urls = set()
    for prefix in PARTS.values():
        url = os.environ.get(prefix + "_URL", "").rstrip("/")
        if (url.startswith("https://") and "@" not in url.split("/")[2]) or (url == FIXTURE_URL and fixture_enabled()):
            urls.add(url)
    return urls


def part_model(part: str) -> str:
    """The model of a part; replies use NOCHEH_MODEL, which Compose sets to the reply model."""
    fallback = os.environ.get("NOCHEH_MODEL", "claude-sonnet-5-5")
    return (os.environ.get(PARTS[part] + "_MODEL") or fallback) if part == "guard" else fallback


def resolve_credentials(part: str = "reply") -> SubscriptionCredentials:
    """The part's provider and key; ProviderNotConfigured until one is chosen."""
    if part not in PARTS:
        raise ValueError("unknown_model_part")
    url = os.environ.get(PARTS[part] + "_URL", "").strip().rstrip("/")
    if not url:
        raise ProviderNotConfigured()
    key = os.environ.get(PARTS[part] + "_KEY", "").strip()
    if not key or url not in configured_urls():
        raise ValueError("Configured provider credential is unavailable")
    return SubscriptionCredentials(key, url, "openai", "chat_completions")


def _call_subscription(credentials: SubscriptionCredentials, model: str, messages: list):
    """Call the part's configured provider with retries disabled. No tools field: Anthropic's
    OpenAI-compatible endpoint rejects an empty tools list."""
    import httpx
    from openai import OpenAI

    with OpenAI(
        api_key=credentials.access_token, base_url=credentials.base_url,
        http_client=httpx.Client(trust_env=False), timeout=90, max_retries=0,
    ) as client:
        return client.chat.completions.create(
            model=model, messages=messages, timeout=90,
            extra_body={"reasoning_effort": "low"},
        )


def detect_literals(text: str, credentials: SubscriptionCredentials, model: str, prompts=None):
    """Return validated literal candidates, never rewritten text."""
    from services.hermes.prompts import text as prompt
    from services.hermes.request_boundary import trusted_detector
    from services.hermes.usage import record, response_usage
    # A provider waking from idle can refuse its first request with a server error. The check
    # changes nothing, so one quick retry spares the turn the workflow's 30-second retry wait.
    for attempt in (1, 2):
        response, failed = None, True
        try:
            with trusted_detector(credentials.base_url):
                response = _call_subscription(credentials, model, [
                    {"role": "system", "content": prompt(prompts, "guard.secret_check")},
                    {"role": "user", "content": text},
                ])
            choice = response.choices[0]
            candidates = detector_reply(choice.message.content, text, getattr(choice, 'finish_reason', None))
            failed = False
            return candidates
        except Exception as error:
            status = getattr(error, "status_code", None)
            if attempt == 2 or not isinstance(status, int) or status < 500:
                raise
        finally:
            # Nocheh's usage tracker: the provider's reported tokens, priced by Hermes.
            record('guard', response_usage(response, model, credentials.base_url) if response is not None else {'calls': 1},
                   model, failed)
        time.sleep(RETRY_SECONDS)
