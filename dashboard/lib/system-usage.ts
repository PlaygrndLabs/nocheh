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
export type Total = {calls: number; failed: number; input: number; output: number; cost: number; unknown: boolean};

export const emptyTotal = (): Total => ({calls: 0, failed: 0, input: 0, output: 0, cost: 0, unknown: false});

export function addRow(total: Total, row: UsageRow): Total {
  return {
    calls: total.calls + row.calls,
    failed: total.failed + row.failed,
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
