const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "30d" | "12h" | "2w" -> Date that far in the past. Throws on bad input. */
export function sinceDate(spec: string, now = Date.now()): Date {
  const m = /^(\d+)([hdw])$/.exec(spec.trim());
  if (!m) throw new Error(`invalid duration "${spec}" (use e.g. 12h, 30d, 2w)`);
  return new Date(now - Number(m[1]) * UNITS[m[2]!]!);
}
