const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function toDateKey(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Accepts "today", "yesterday", or YYYY-MM-DD (local time).
export function parseDay(input: string | undefined, now = new Date()): Date {
  if (!input || input === "today") return startOfDay(now);
  if (input === "yesterday") return addDays(startOfDay(now), -1);

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (match) {
    const [, y, m, d] = match.map(Number) as [number, number, number, number];
    const date = new Date(y, m - 1, d);
    if (date.getMonth() === m - 1 && date.getDate() === d) return date;
  }
  throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, "today" or "yesterday".`);
}

export function dayName(date: Date): string {
  return DAY_NAMES[date.getDay()] ?? "";
}

export function formatDay(date: Date): string {
  return `${dayName(date)} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 45s, 12m, 1h 05m
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

// 3:07, for track positions
export function formatPosition(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
