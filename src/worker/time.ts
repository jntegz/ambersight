// Local time in the user's time zone, for the digest schedule and quiet hours.
// SPDX-License-Identifier: AGPL-3.0-only

export interface LocalTime {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localTime(d: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** True if local time is inside [start, end), which may wrap past midnight. */
export function inQuietHours(d: Date, timeZone: string, q: { start: string; end: string } | null): boolean {
  if (!q) return false;
  const t = localTime(d, timeZone);
  const now = t.hour * 60 + t.minute;
  const [sh, sm] = q.start.split(':').map(Number);
  const [eh, em] = q.end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

/**
 * Whether a digest is due: local time has reached the configured hour (and weekday for weekly)
 * and no digest went out for this slot yet.
 */
export function digestDue(
  now: Date, timeZone: string, frequency: 'daily' | 'weekly' | 'monthly' | 'off', weekday: number, hour: number, lastSentAt: string | null,
): boolean {
  if (frequency === 'off') return false;
  const t = localTime(now, timeZone);
  if (frequency === 'weekly' && t.weekday !== weekday) return false;
  // Monthly: the first of the month, local time.
  if (frequency === 'monthly' && !t.date.endsWith('-01')) return false;
  if (t.hour < hour) return false;
  if (!lastSentAt) return true;
  const last = localTime(new Date(lastSentAt), timeZone);
  const minGapMs = (frequency === 'monthly' ? 25 : frequency === 'weekly' ? 6 : 0.5) * 86_400_000;
  return last.date !== t.date && now.getTime() - new Date(lastSentAt).getTime() >= minGapMs;
}
