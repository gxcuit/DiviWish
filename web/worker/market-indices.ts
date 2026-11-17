export const MARKET_A_OPTIONS = [
  { code: "H00922", name: "中证红利全收益", short_name: "红利" },
  { code: "H20269", name: "中证红利低波动全收益", short_name: "红利低波" },
  { code: "H20955", name: "红利低波100全收益", short_name: "红利低波100" },
] as const;
export const MARKET_B_OPTIONS = [
  { code: "000510CNY010", name: "中证A500全收益", short_name: "A500" },
] as const;
export type MarketACode = typeof MARKET_A_OPTIONS[number]["code"];
export type MarketBCode = typeof MARKET_B_OPTIONS[number]["code"];
export type MarketIndexCode = MarketACode | MarketBCode;
export type MarketIndexOption = { code: MarketIndexCode; name: string; short_name: string };
export type MarketSelection = { a: MarketIndexOption & { code: MarketACode }; b: MarketIndexOption & { code: MarketBCode } };

export function resolveMarketSelection(a?: string | null, b?: string | null): MarketSelection {
  const selectedA = MARKET_A_OPTIONS.find(option => option.code === (a ?? MARKET_A_OPTIONS[0].code));
  const selectedB = MARKET_B_OPTIONS.find(option => option.code === (b ?? MARKET_B_OPTIONS[0].code));
  if (!selectedA || !selectedB) throw new Error("不支持的市场指数组合，请重新选择A、B");
  return { a: { ...selectedA }, b: { ...selectedB } };
}
export const DEFAULT_MARKET_SELECTION = resolveMarketSelection();
