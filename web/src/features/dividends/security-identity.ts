export interface SecurityIdentity {
  name: string;
  code: string;
  market: "A" | "HK";
  instrument_type?: "stock" | "etf";
  exchange?: "sh" | "sz" | "bj" | "hk" | null;
  sector?: string | null;
}

/** Only supported, unambiguous code ranges are inferred without a search result. */
export function inferSecurityCode(value: string): Omit<SecurityIdentity, "name"> | null {
  const code = value.trim();
  if (/^\d{5}$/.test(code)) return { code, market: "HK", instrument_type: "stock", exchange: "hk" };
  if (/^(51|52|56|58)\d{4}$/.test(code)) return { code, market: "A", instrument_type: "etf", exchange: "sh" };
  if (/^159\d{3}$/.test(code)) return { code, market: "A", instrument_type: "etf", exchange: "sz" };
  if (/^(600|601|603|605|688|689)\d{3}$/.test(code)) return { code, market: "A", instrument_type: "stock", exchange: "sh" };
  if (/^(000|001|002|003|300|301)\d{3}$/.test(code)) return { code, market: "A", instrument_type: "stock", exchange: "sz" };
  if (/^(?:[48]\d{5}|920\d{3})$/.test(code)) return { code, market: "A", instrument_type: "stock", exchange: "bj" };
  return null;
}

export function resolveSecurityQuery(value: string, suggestions: SecurityIdentity[]): SecurityIdentity | null {
  const query = value.trim(), inferred = inferSecurityCode(query);
  if (inferred) {
    const match = suggestions.find(row => row.code === inferred.code && row.market === inferred.market);
    return match ? { ...match, ...inferred } : { ...inferred, name: inferred.code };
  }
  const exact = suggestions.filter(row => row.name === query);
  return exact.length === 1 ? exact[0] : exact.length === 0 && suggestions.length === 1 ? suggestions[0] : null;
}
