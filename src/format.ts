const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function style(open: number, close: number) {
  return (text: string) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const green = style(32, 39);
export const cyan = style(36, 39);
export const yellow = style(33, 39);
export const red = style(31, 39);

const ANSI = /\x1b\[[0-9;]*m/g;

// East Asian wide and fullwidth characters (CJK, Hangul, kana, emoji) take two
// terminal columns.
function charWidth(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  if (
    codePoint <= 0x115f ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function width(text: string): number {
  let total = 0;
  for (const char of text.replace(ANSI, "")) total += charWidth(char.codePointAt(0) ?? 0);
  return total;
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function padEnd(text: string, size: number): string {
  return text + " ".repeat(Math.max(0, size - width(text)));
}

export function padStart(text: string, size: number): string {
  return " ".repeat(Math.max(0, size - width(text))) + text;
}

export function terminalWidth(): number {
  return Math.min(process.stdout.columns || 80, 120);
}

export function bar(value: number, max: number, size: number): string {
  if (max <= 0 || value <= 0) return dim("·".repeat(size));
  const filled = Math.max(1, Math.round((value / max) * size));
  return green("█".repeat(filled)) + dim("·".repeat(size - filled));
}

export type Column = {
  header: string;
  align?: "left" | "right";
  // Exactly one column may flex to fill the remaining width.
  flex?: boolean;
  style?: (text: string) => string;
};

export function table(columns: Column[], rows: string[][], indent = 2): string {
  const gap = 2;
  const widths = columns.map((column, i) =>
    Math.max(width(column.header), ...rows.map((row) => width(row[i] ?? "")))
  );

  const flexIndex = columns.findIndex((column) => column.flex);
  if (flexIndex >= 0) {
    const fixed = widths.reduce((sum, w, i) => (i === flexIndex ? sum : sum + w), 0);
    const available = terminalWidth() - indent - fixed - gap * (columns.length - 1);
    widths[flexIndex] = Math.max(12, Math.min(widths[flexIndex] ?? 0, available));
  }

  const render = (cells: string[], header: boolean) =>
    " ".repeat(indent) +
    cells
      .map((cell, i) => {
        const column = columns[i]!;
        const w = widths[i]!;
        const text = truncate(cell, w);
        const padded = column.align === "right" ? padStart(text, w) : padEnd(text, w);
        if (header) return dim(padded);
        return column.style ? column.style(padded) : padded;
      })
      .join(" ".repeat(gap))
      .trimEnd();

  return [render(columns.map((c) => c.header), true), ...rows.map((row) => render(row, false))].join(
    "\n"
  );
}
