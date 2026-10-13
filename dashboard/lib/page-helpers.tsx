import type {ReactNode} from 'react';
import {Button} from '../components/ui/primitives';

/** A small outline button; a class containing `n-primary` makes it the primary action. */
export function button(label: ReactNode, onClick: () => void, disabled = false, className = '') {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      variant={className.includes('n-primary') ? 'default' : 'outline'}
    >
      {label}
    </Button>
  );
}

const errorMessages: Record<string, string> = {
  configuration_conflict: 'These settings changed elsewhere. Refresh this page and review your changes again.',
  operation_in_progress: 'Another maintenance task is running. Wait for it to finish and try again.',
  embedding_model_change_requires_rebuild:
    'Memory already holds vectors from the current embedding model. Rebuild Honcho memory before choosing another one.',
};

/** Turns an API error into a sentence for the owner. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return errorMessages[message] || message || 'The operation could not finish. Try again.';
}

/** Owner-facing names for installation settings. */
export const labels: Record<string, string> = {
  NOCHEH_PORT: 'Archive port',
  NOCHEH_MODEL: 'Default model',
  NOCHEH_PROVIDER: 'Default provider',
  NOCHEH_REPLY_PROVIDER: 'Replies provider',
  NOCHEH_REPLY_MODEL: 'Replies model',
  NOCHEH_MEMORY_PROVIDER: 'Memory provider',
  NOCHEH_MEMORY_MODEL: 'Memory model',
  NOCHEH_GUARD_PROVIDER: 'Secret check provider',
  NOCHEH_GUARD_MODEL: 'Secret check model',
  NOCHEH_EMBEDDING_PROVIDER: 'Memory search provider',
  NOCHEH_EMBEDDING_MODEL: 'Memory search model',
  NOCHEH_PROVIDERS: 'Custom providers',
  NOCHEH_PROVIDER_KEYS: 'Custom provider API keys',
  OPENAI_API_KEY: 'OpenAI API key',
  ANTHROPIC_API_KEY: 'Anthropic API key',
  NOCHEH_GUARD_MODE: 'Secret guarding',
  NOCHEH_PARALLEL_RUNS: 'Parallel agent runs',
  NOCHEH_PARALLEL_REPLIES: 'Chats answered at once',
  NOCHEH_PARALLEL_GUARD_CHECKS: 'Guard checks at once',
  NOCHEH_GUARD_TRUSTED_ENDPOINTS: 'Trusted destinations (JSON)',
  TELEGRAM_ENABLED: 'Telegram enabled',
  TELEGRAM_BOT_TOKEN: 'Telegram bot token',
  TELEGRAM_OWNER_ID: 'Owner user ID',
  TELEGRAM_GROUP_IDS: 'Selected group IDs',
  TELEGRAM_GROUP_ACCESS: 'Group participant access',
  TELEGRAM_GROUP_REPLIES: 'Group replies',
  TELEGRAM_BOT_NAMES: 'Names that address Nocheh',
  TELEGRAM_TOPIC_MEMORY: 'Topic memory',
  POSTGRES_PASSWORD: 'Database credential',
  SERVICE_TOKEN: 'Service credential',
  NOCHEH_CONFIG_VERSION: 'Configuration version',
};

export function Panel({title, note, children}: {title: ReactNode; note?: ReactNode; children?: ReactNode}) {
  return (
    <section className="n-panel">
      <h2>{title}</h2>
      {note && <p className="n-muted">{note}</p>}
      {children}
    </section>
  );
}

export function Data({value}: {value: unknown}) {
  return (
    <pre className="n-data" dir="auto">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

const states: Record<string, string> = {
  ready: 'Ready',
  running: 'In progress',
  complete: 'Complete',
  failed: 'Needs attention',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  uploading: 'Uploading',
  pending: 'Waiting',
};

export const friendlyState = (value: unknown): string =>
  states[String(value)] || String(value || 'Unknown').replaceAll('_', ' ');

const jobs: Record<string, string> = {
  import: 'Chat import',
  'settings.apply': 'Apply settings',
  'operations.diagnose': 'Service diagnostics',
  'operations.export': 'Archive export',
  'operations.portable-export': 'Archive and memory export',
  'operations.backup': 'Full backup',
  'operations.restart': 'Service restart',
  'operations.restore': 'Inactive restore',
};

export const jobName = (value: string): string => jobs[value] || value;

export const profileName = (profile: {owner?: boolean; scope: string}): string =>
  (profile.owner ? 'Owner · private DM' : 'Group') + ' · ' + profile.scope;

export function Details({value, label = 'Technical details'}: {value: unknown; label?: string}) {
  return (
    <details>
      <summary>{label}</summary>
      <Data value={value} />
    </details>
  );
}

export function RouteLink({page, children}: {page: string; children: ReactNode}) {
  return (
    <a href={'#' + page} className="n-text-link">
      {children}
    </a>
  );
}

export function Steps({items, current}: {items: string[]; current: number}) {
  return (
    <ol className="n-steps">
      {items.map((item, i) => (
        <li
          key={item}
          aria-current={current === i ? 'step' : undefined}
          className={current === i ? 'active-step' : current > i ? 'complete-step' : ''}
        >
          <span aria-hidden="true">{current > i ? '✓' : i + 1}</span>
          {item}
        </li>
      ))}
    </ol>
  );
}

export {apiBase as base, authedFetch, call, download, exportJSON} from './api';
export {useLoad, useResource, refreshResources} from './resource';
export {StatusBadge} from '../components/status';
export {
  Button,
  Badge,
  Alert,
  Progress,
  Table,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Modal,
  Sheet,
  EmptyState,
} from '../components/ui/primitives';
