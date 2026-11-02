import type { Confidence, TokenUsage, UsageEvent } from './types.js';
import bundled from './pricing.json' with { type: 'json' };

export type TokenType = keyof TokenUsage;
export type ModelPrice = Record<TokenType, number> & { derived?: TokenType[] };

export interface PricingTable {
  version: string;
  models: Record<string, ModelPrice>;
}

const TOKEN_TYPES: TokenType[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];

/** Bundled table with user overrides merged per model. Overrides change the version label. */
export function loadPricing(overrides: Record<string, Partial<ModelPrice>> = {}): PricingTable {
  const models: Record<string, ModelPrice> = { ...(bundled.models as Record<string, ModelPrice>) };
  for (const [model, o] of Object.entries(overrides)) {
    const base = models[model];
    const merged = { ...base, ...o } as ModelPrice;
    if (TOKEN_TYPES.every((t) => typeof merged[t] === 'number')) models[model] = { ...merged, derived: base?.derived?.filter((t) => o[t] === undefined) };
  }
  const n = Object.keys(overrides).length;
  return { version: n ? `${bundled.version}+${n}-override${n > 1 ? 's' : ''}` : bundled.version, models };
}

/** Match provider-prefixed or date-suffixed ids ("anthropic.claude-opus-5-5", "claude-opus-5-5-20260101"). */
export function priceFor(model: string, table: PricingTable): ModelPrice | null {
  const id = model
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/@.*$/, '');
  if (table.models[id]) return table.models[id]!;
  let best: string | null = null;
  for (const k of Object.keys(table.models)) {
    if (id.startsWith(k + '-') && (!best || k.length > best.length)) best = k;
  }
  return best ? table.models[best]! : null;
}

export interface CostResult {
  amount: number | null;
  confidence: Confidence;
  unpricedModels: string[];
}

/**
 * Cost of usage events at list prices. No events -> null (unknown, never 0). Some unpriced models ->
 * the priced part only, low confidence. Derived prices used -> medium. Otherwise high.
 */
export function costOf(events: UsageEvent[], table: PricingTable, hasUsageData: boolean): CostResult {
  if (!hasUsageData) return { amount: null, confidence: 'low', unpricedModels: [] };
  let amount = 0;
  let pricedAny = false;
  let derivedUsed = false;
  const unpriced = new Set<string>();
  for (const e of events) {
    const p = priceFor(e.model, table);
    const tokens = TOKEN_TYPES.reduce((n, t) => n + e.usage[t], 0);
    if (!p) {
      if (tokens > 0) unpriced.add(e.model);
      continue;
    }
    pricedAny = true;
    for (const t of TOKEN_TYPES) {
      amount += (e.usage[t] * p[t]) / 1e6;
      if (e.usage[t] > 0 && p.derived?.includes(t)) derivedUsed = true;
    }
  }
  const unpricedModels = [...unpriced].sort();
  if (!pricedAny && unpricedModels.length) return { amount: null, confidence: 'low', unpricedModels };
  return {
    amount: Math.round(amount * 1e6) / 1e6,
    confidence: unpricedModels.length ? 'low' : derivedUsed ? 'medium' : 'high',
    unpricedModels,
  };
}
