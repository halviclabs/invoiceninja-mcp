/**
 * Invoice Ninja stores a task's time entries in `time_log`: a JSON-encoded
 * string of [start_epoch, end_epoch] pairs (seconds). A pair with end === 0 is
 * an OPEN / running entry. Newer builds may carry extra trailing elements per
 * entry (description, billable flag) — we preserve those verbatim and only ever
 * touch indices 0 and 1.
 */
export type TimeEntry = (number | string)[]; // [start, end, ...extra]

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/** Accepts the raw value from the API (string | array | null) and normalises. */
export function parseTimeLog(raw: unknown): TimeEntry[] {
  if (Array.isArray(raw)) return raw as TimeEntry[];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as TimeEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Invoice Ninja expects time_log back as a JSON-encoded string. */
export function serializeTimeLog(entries: TimeEntry[]): string {
  return JSON.stringify(entries);
}

/** A task is "running" when its last entry is open (end === 0). */
export function isRunning(entries: TimeEntry[]): boolean {
  const last = entries[entries.length - 1];
  return !!last && Number(last[1]) === 0;
}

/** Total tracked seconds; open entries count up to `asOf` (default now). */
export function totalSeconds(entries: TimeEntry[], asOf: number = nowEpoch()): number {
  return entries.reduce((acc, e) => {
    const start = Number(e[0]) || 0;
    const rawEnd = Number(e[1]);
    const end = rawEnd > 0 ? rawEnd : asOf;
    return acc + Math.max(0, end - start);
  }, 0);
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
