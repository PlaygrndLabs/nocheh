"""Native preferences with explicit Nocheh-owned runtime policy."""
import hashlib
import json
import os
import tempfile
import fcntl
from pathlib import Path
import yaml

PREFERENCES = {
    'agent.reasoning_effort': {'default': 'low', 'choices': ['low', 'medium', 'high']},
    'agent.max_iterations': {'default': 8, 'min': 1, 'max': 16},
    'agent.run_budget_seconds': {'default': 180, 'min': 30, 'max': 180},
    'memory.memory_char_limit': {'default': 2200, 'min': 100, 'max': 20000},
    'memory.user_char_limit': {'default': 1375, 'min': 100, 'max': 20000},
    'nocheh_tools.shell': {'default': 'on', 'choices': ['on','off']},
    'nocheh_tools.browser': {'default': 'on', 'choices': ['on','off']},
    'nocheh_tools.mcp': {'default': 'on', 'choices': ['on','off']},
}


def read(path):
    if not path.exists(): return {}
    value = yaml.safe_load(path.read_text())
    if not isinstance(value, dict): raise ValueError('invalid_profile_config')
    return value


def atomic_yaml(path, value):
    descriptor, name = tempfile.mkstemp(prefix='.config-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            yaml.safe_dump(value, file, allow_unicode=True, sort_keys=False)
            file.flush(); os.fsync(file.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def preferences(config):
    result = {}
    for key, spec in PREFERENCES.items():
        section, field = key.split('.')
        value = config.get(section, {}).get(field, spec['default'])
        if 'choices' in spec:
            if value not in spec['choices']: raise ValueError('invalid_preference_' + key)
        elif type(value) is not int or not spec['min'] <= value <= spec['max']:
            raise ValueError('invalid_preference_' + key)
        result[key] = value
    return result


MANAGED = ['model', 'plugins', 'fallback_models', 'tools', 'auxiliary', 'curator', 'memory.provider', 'prompt_caching', 'terminal', 'code_execution', 'tool_output',
           'compression.threshold_tokens', 'display.inline_images']
# Hermes compacts a conversation once its prompt passes this many tokens. A background job's run of up to 50 minutes
# reaches it; a reply turn, of at most 16 iterations, rarely does.
COMPRESSION_TOKENS = 100000


def resolved(config, model):
    """Keep native fields, but never delegate route/tool policy to mutable YAML."""
    config = json.loads(json.dumps(config))
    values = preferences(config)
    for key, value in values.items():
        section, field = key.split('.')
        config.setdefault(section, {})[field] = value
    # Every model call goes to the provider chosen in Settings › Models: through its
    # OpenAI-compatible API, or, for Anthropic in isolated turns, its Messages API.
    from .security_transport import anthropic_reply_route, isolated_enabled
    provider = 'openai'
    config['model'] = {'provider': 'anthropic' if isolated_enabled() and anthropic_reply_route() else provider, 'default': model}
    # Hermes marks the stable start of each prompt for the provider's prompt cache. Five
    # minutes is Hermes's default and the cheapest cache write.
    config['prompt_caching'] = {'cache_ttl': '5m'}
    # Voice notes are archived without transcription.
    config['stt'] = {'enabled': False}
    config['plugins'] = {'enabled': ['nocheh']}
    config['fallback_models'] = []
    config.setdefault('tools', {})['tool_search'] = {'enabled': 'off'}
    config.setdefault('memory', {}).update(memory_enabled=True, user_profile_enabled=True, provider='')
    # One-shot helper calls (session search, context compression, titles) keep the
    # OpenAI-compatible route: nothing in them is reused, so caching gains nothing.
    config['auxiliary'] = {task: {'provider': provider, 'model': model}
                           for task in ('session_search', 'compression', 'title_generation')}
    # Skills are set by the owner only. The native curator would archive or
    # consolidate a skill that no turn loaded for its configured window.
    config['curator'] = {'enabled': False}
    # Hermes's terminal, file and code tools run only in a job's sealed box or on its machine. A terminal
    # section would replace the launcher's backend, possibly with local; the box's bounds are fixed.
    config.pop('terminal', None)
    # A code kernel left idle in a box does not stay long after its last cell.
    config['code_execution'] = {'timeout': 120, 'max_tool_calls': 20, 'max_session_kernels': 1, 'kernel_idle_timeout': 600}
    config['tool_output'] = {'max_bytes': 30000, 'max_lines': 400, 'max_line_length': 1000}
    config.setdefault('compression', {})['threshold_tokens'] = COMPRESSION_TOKENS
    # The browser TUI draws pictures through a gateway method Nocheh's browser gateway does not serve.
    config.setdefault('display', {})['inline_images'] = 'off'
    return config


def revision(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def policy_root(profile):
    profile = Path(profile)
    return Path(os.environ.get("NOCHEH_RUNTIME_HOME", profile.parent.parent if profile.parent.name == "profiles" else profile))


def inherited_config(profile, config, job=None, policy=None):
    from .policy_config import effective
    result = json.loads(json.dumps(config))
    # Audience revisions retire memory/history, while the logical scope retains
    # the owner's preferences. Never silently lose settings on a privacy change.
    logical=config;marker=Path(profile)/'space.json'
    if marker.is_file() and not marker.is_symlink():
        binding=json.loads(marker.read_text())
        if binding.get('revision',0)>0 and binding.get('owner') is False:
            from .scopes import Scopes
            base=policy_root(profile)/'profiles'/Scopes.profile(binding['space'])/'config.yaml'
            parent=policy_root(profile)/'profiles'/Scopes.profile(binding['space'].split('/topic/')[0])/'config.yaml'
            source=base if base.is_file() else parent
            if source.is_file():logical=read(source)
    values, origins = effective(policy_root(profile), logical, job, policy)
    for key, value in values.items():
        section, field = key.split(".")
        result.setdefault(section, {})[field] = value
    result.setdefault("nocheh", {})["inherited_preferences"] = [key for key, origin in origins.items() if origin != "profile"]
    return result, origins


def profile_revision(config, policy):
    return revision({"config": config, "policy": policy})


def inspect_profile(profile, model):
    from .policy_config import document
    policy = document(policy_root(profile))
    original = read(Path(profile) / 'config.yaml')
    inherited, origins = inherited_config(profile, original, policy=policy)
    result = resolved(inherited, model)
    return {'origins': origins, 'revision': profile_revision(original, policy), 'values': preferences(result), 'schema': PREFERENCES,
            'source': 'Hermes profile config.yaml', 'takes_effect': 'next turn',
            'managed': MANAGED}


def configure_profile(profile, model, changes=None, expected=None):
    profile = Path(profile); profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = profile / 'config.yaml'
    from .policy_config import document
    with (profile / '.config.lock').open('a') as lock, (policy_root(profile) / '.policy.lock').open('a') as policy_lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fcntl.flock(policy_lock, fcntl.LOCK_SH)
        policy = document(policy_root(profile))
        original = read(path)
        if changes is not None:
            if expected != profile_revision(original, policy): raise ValueError('configuration_conflict')
            if not isinstance(changes, dict) or set(changes) - PREFERENCES.keys():
                raise ValueError('unsupported_preference')
            from .policy_config import validate
            validate(changes)
            inherited = set(original.get('nocheh', {}).get('inherited_preferences', []))
            for key, value in changes.items():
                section, field = key.split('.')
                if value is None:
                    original.setdefault(section, {}).pop(field, None); inherited.add(key)
                else:
                    original.setdefault(section, {})[field] = value; inherited.discard(key)
            original.setdefault('nocheh', {})['inherited_preferences'] = sorted(inherited)
        inherited, origins = inherited_config(profile, original, policy=policy)
        result = resolved(inherited, model)
        if not path.exists() or result != read(path): atomic_yaml(path, result)
        return {'origins': origins, 'revision': profile_revision(result, policy), 'values': preferences(result), 'schema': PREFERENCES,
                'source': 'Hermes profile config.yaml', 'takes_effect': 'next turn',
                'managed': MANAGED}
