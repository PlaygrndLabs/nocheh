/** Shapes and sums for the usage tracker's daily rows (`GET /usage`). */
export type UsageRow = {
  day: string;
  part: string;
  label: string;
  service: string;
  provider: string;
  provider_name: string;
  model: string;
  runs: number;
  calls: number;
  failed: number;
  /** Failed calls the model declined to answer; older rows and memory rows have none. */
  refused?: number;
  /** Texts the secret check hid whole because the model declined to check them. */
  hidden?: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_complete: boolean;
};
export type Usage = {
  since: string;
  today: string;
  days: number;
  rows: UsageRow[];
  parts: {id: string; label: string; service: string}[];
  sources: {hermes: string; honcho: string; pricing: string};
};
/** A sum of rows. `unknown` means at least one call could not be priced, so `cost` is a lower bound. */
export type Total = {
  calls: number;
  failed: number;
  refused: number;
  hidden: number;
  input: number;
  output: number;
  cost: number;
  unknown: boolean;
};

export const emptyTotal = (): Total => ({
  calls: 0,
  failed: 0,
  refused: 0,
  hidden: 0,
  input: 0,
  output: 0,
  cost: 0,
  unknown: false,
});

export function addRow(total: Total, row: UsageRow): Total {
  return {
    calls: total.calls + row.calls,
    failed: total.failed + row.failed,
    refused: total.refused + (row.refused ?? 0),
    hidden: total.hidden + (row.hidden ?? 0),
    input: total.input + row.input_tokens,
    output: total.output + row.output_tokens,
    cost: total.cost + (row.cost_usd ?? 0),
    unknown: total.unknown || row.cost_usd === null || !row.cost_complete,
  };
}

export function groupRows(rows: UsageRow[], key: (row: UsageRow) => string): Map<string, Total> {
  const result = new Map<string, Total>();
  for (const row of rows) result.set(key(row), addRow(result.get(key(row)) ?? emptyTotal(), row));
  return result;
}

/** What went wrong with a total's calls, such as "3 failed (2 refused) · 1 text hidden", or "". */
export function failures(total: Total): string {
  const parts: string[] = [];
  if (total.failed) parts.push(`${total.failed} failed` + (total.refused ? ` (${total.refused} refused)` : ''));
  if (total.hidden) parts.push(`${total.hidden} ${total.hidden === 1 ? 'text' : 'texts'} hidden`);
  return parts.join(' · ');
}
