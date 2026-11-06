import { parseHTML } from "linkedom";
import { forecastNumber, forecastReport, forecastText } from "./forecast-http.ts";
import { parseForecastCommitments, readForecastAnnouncement, searchForecastAnnouncements, continueForecastSearch } from "./forecast-announcements.ts";
import type { ForecastDocumentCache } from "./forecast-announcements.ts";
import type { ForecastConsensus, ForecastCurrency, ForecastDividend, ForecastFinancial, ForecastSnapshot } from "./forecast-types.ts";
import type { StockRecord } from "./types.ts";
import { forecastToday } from "./forecast.ts";

type Row = Record<string, unknown>;
const day = (v: unknown) => typeof v === "string" && /^20\d{2}[-/]\d{2}[-/]\d{2}/.test(v) ? v.slice(0, 10).replaceAll("/", "-") : "";
const currency = (v: unknown): ForecastCurrency | null => ["CNY", "HKD", "USD"].includes(String(v)) ? v as ForecastCurrency : null;

export function parseForecastFinancials(rows: Row[], stock: StockRecord, url: string, today: string, nativeRows: Row[] = []): ForecastFinancial[] {
  return rows.flatMap(row => {
    if (String(row.SECURITY_CODE) !== stock.code) throw new Error("财务来源证券身份不匹配");
    const period = day(row.REPORT_DATE), notice = day(row.NOTICE_DATE ?? row.UPDATE_DATE) || (stock.market === "HK" ? period : "");
    if (!period || !notice || notice > today || period > today) return [];
    if (stock.market === "A") {
      if (row.CURRENCY !== "CNY") return [];
      return [{ period, start: `${period.slice(0, 4)}-01-01`, currency: "CNY" as const, eps: forecastNumber(row.EPSJB), profit: forecastNumber(row.PARENTNETPROFIT), shares: forecastNumber(row.TOTAL_SHARE), notice_date: notice, source: url }];
    }
    const matching = nativeRows.filter(r => String(r.SECURITY_CODE) === stock.code && day(r.REPORT_DATE) === period && day(r.START_DATE) === `${period.slice(0, 4)}-01-01`);
    const eps = matching.find(r => r.ITEM_NAME === "每股基本盈利"), profit = matching.find(r => r.ITEM_NAME === "股东应占溢利");
    const c = currency(eps?.CURRENCY_CODE);
    if (!c || !eps) return [];
    return [{ period, start: day(row.START_DATE), currency: c, eps: forecastNumber(eps.AMOUNT),
      profit: profit?.CURRENCY_CODE === c ? forecastNumber(profit.AMOUNT) : null,
      shares: forecastNumber(row.ISSUED_COMMON_SHARES), notice_date: notice, source: url }];
  }).sort((a, b) => b.period.localeCompare(a.period));
}

/** Balance amounts identify a need for reconciliation; they are never earnings deductions. */
export function attachForecastBalance(financials: ForecastFinancial[], rows: Row[], stock: StockRecord, source: string, today: string) {
  if (rows.some(r => String(r.SECURITY_CODE) !== stock.code)) throw new Error("资产负债表证券身份不匹配");
  for (const financial of financials) {
    const row = rows.find(r => day(r.REPORT_DATE) === financial.period && day(r.NOTICE_DATE) && day(r.NOTICE_DATE) <= today);
    if (!row) { financial.equity_status = "unknown"; continue; }
    const equity = [row.OTHER_EQUITY_TOOL, row.PREFERRED_SHARES, row.PERPETUAL_BOND].map(forecastNumber);
    financial.equity_status = equity.some(n => n !== null && Math.abs(n) > 0) ? "present" : "none_reported";
    financial.equity_balance = Math.max(...equity.map(n => Math.abs(n ?? 0)));
    financial.treasury_balance = forecastNumber(row.TREASURY_SHARES);
    financial.balance_source = source;
    // SHARE_CAPITAL is a currency amount (and can be rounded). It is NOT a share count.
  }
  return financials;
}

export function parseForecastAConsensus(rows: Row[], stock: StockRecord, year: number, today: string, source: string): ForecastConsensus | null {
  const row = rows.find(r => String(r.SECURITY_CODE) === stock.code);
  if (!row || !(Number(row.RATING_ORG_NUM) > 0)) return null;
  for (let i = 1; i <= 4; i++) {
    if (Number(row[`YEAR${i}`]) !== year || row[`YEAR_MARK${i}`] !== "E") continue;
    const eps = forecastNumber(row[`EPS${i}`]);
    if (eps !== null) return { year, eps, currency: "CNY", updated_at: today, analysts: Number(row.RATING_ORG_NUM), source };
  }
  return null;
}

export function parseForecastHkConsensus(html: string, year: number, today: string, source: string): ForecastConsensus | null {
  const { document } = parseHTML(html);
  for (const table of document.querySelectorAll("table.figureTable")) {
    const rows = [...table.querySelectorAll("tr")];
    const header = rows[0]?.textContent?.replace(/\s/g, "") ?? "";
    if (!header.includes("财政年度") || !header.includes("更新日期") || !header.includes("证券商")) continue;
    const c: ForecastCurrency | null = /百万元人民币/.test(header) && /亏损\).*?\(分\)/.test(header) ? "CNY" : /百万港元/.test(header) && /港仙/.test(header) ? "HKD" : /百万美元/.test(header) && /美仙/.test(header) ? "USD" : null;
    if (!c) return null;
    const brokers = new Map<string, { eps: number; profit: number | null; date: string }>();
    for (const row of rows.slice(1)) {
      const cells = [...row.querySelectorAll("td")].map(td => td.textContent?.trim() ?? "");
      if (Number(cells[0]) !== year) continue;
      const match = cells.at(-1)?.match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
      if (!match) continue;
      const date = `${match[3]}-${match[2]}-${match[1]}`, age = new Date(today).getTime() - new Date(date).getTime();
      const eps = forecastNumber(cells[2]), profit = forecastNumber(cells[1]);
      if (eps === null || age < 0 || age > 183 * 86400_000 || !cells[4]) continue;
      const previous = brokers.get(cells[4]);
      if (!previous || previous.date < date) brokers.set(cells[4], { eps: eps / 100, profit: profit === null ? null : profit * 1e6, date });
    }
    const entries = [...brokers.values()];
    if (!entries.length) return null;
    return { year, eps: entries.reduce((s, r) => s + r.eps, 0) / entries.length, currency: c, analysts: entries.length,
      profit: entries.every(r => r.profit !== null) ? entries.reduce((s, r) => s + r.profit!, 0) / entries.length : null,
      updated_at: entries.map(r => r.date).sort().at(-1)!, source };
  }
  return null;
}

export function parseForecastDividends(rows: Row[], stock: StockRecord, source: string, today: string): ForecastDividend[] {
  const events = new Map<string, ForecastDividend>();
  for (const row of rows) {
    if (String(row.SECURITY_CODE) !== stock.code) throw new Error("分红来源证券身份不匹配");
    const notice = day(row.NOTICE_DATE ?? row.PLAN_NOTICE_DATE);
    if (!notice || notice > today) continue;
    const progress = String(row.ASSIGN_PROGRESS ?? ""), text = String(row.IMPL_PLAN_PROFILE ?? row.PLAN_EXPLAIN ?? "");

    const type = String(row.REPORT_TYPE ?? ""), y = String(row.YEAR ?? "");
    const suffix = /^(年度|末期|四季度|第四季度)分配$/.test(type) ? "12-31" : /^(中期|二季度|第二季度)分配$/.test(type) ? "06-30" : /^(一季度|第一季度)分配$/.test(type) ? "03-31" : /^(三季度|第三季度)分配$/.test(type) ? "09-30" : null;
    const period = stock.market === "A" ? day(row.REPORT_DATE) : /^20\d{2}$/.test(y) && suffix ? `${y}-${suffix}` : "";
    if (!period || period.slice(0, 4) > today.slice(0, 4)) continue;
    const special = /特别|特別|特殊|special/i.test(text + progress + type);
    const none = /不分配|不分红|不派息|不派股息/.test(text + progress);
    let amount: number | null = null, c: ForecastCurrency | null = null;
    if (stock.market === "A") {
      c = "CNY";
      const match = text.match(/(?:每?10股?派(?:发现金红利)?(?:应)?(?:不低于|不少于|至少)?|10派)\s*(\d+(?:\.\d+)?)/);
      const raw = match ? Number(match[1]) : forecastNumber(row.PRETAX_BONUS_RMB);
      amount = none ? 0 : raw === null ? null : raw / 10;
    } else {
      const match = text.match(/^每股(?:派)?\s*(人民币|人民幣|RMB|CNY|港币|港幣|港元|HKD|美元|USD)\s*(\d+(?:\.\d+)?)/i);
      if (match) { c = /人民币|人民幣|RMB|CNY/i.test(match[1]) ? "CNY" : /美元|USD/i.test(match[1]) ? "USD" : "HKD"; amount = Number(match[2]); }
      // A zero declaration has no conversion requirement; retain the report currency when supplied.
      if (none) { c = currency(row.CURRENCY_CODE) ?? "HKD"; amount = 0; }
    }
    const ex = day(row.EX_DIVIDEND_DATE ?? row.EX_DIVIDEND_DAYS), pay = day(row.DIVIDEND_DATE ?? row.PAY_DATE), record = day(row.EQUITY_RECORD_DATE);
    const lower = /不低于|不少于|至少/.test(text);
    const status: ForecastDividend["status"] = /取消|终止|撤销|不通过|未通过/.test(progress + text) ? "cancelled" :
      lower || /预披露|授权|条件|拟于/.test(progress + text) ? "conditional" :
      Boolean(ex && ex <= today || pay && pay <= today) && (/实施分配|特别分配/.test(progress) || stock.market === "HK") ? "implemented" :
      /实施分配|特别分配|股东大会.*通过/.test(progress) ? "approved" : /董事会.*通过|预案/.test(progress) || stock.market === "HK" ? "proposed" : "unknown";
    const event: ForecastDividend = { period, amount, status, lower_bound: lower, participating_shares: forecastNumber(row.TOTAL_SHARES),
      ex_date: ex, record_date: record, pay_date: pay, currency: c ?? (stock.market === "A" ? "CNY" : "HKD"), special,
      ambiguous: amount === null || c === null || (text.match(/每股/g) ?? []).length > 1 || /特别.*(?:及|和|普通)|普通.*特别|特別.*(?:及|和|普通)|普通.*特別/.test(text),
      complete: period.endsWith("12-31") && !special && status !== "conditional" && status !== "cancelled" && status !== "unknown", evidence: { url: source, title: text || progress, date: notice } };
    const key = `${period}:${special ? "special" : "ordinary"}`, old = events.get(key);
    if (!old || old.evidence.date < notice) events.set(key, event);
    else if (old.evidence.date === notice && (old.amount !== event.amount || old.status !== event.status)) old.ambiguous = true;
  }
  return [...events.values()].sort((a, b) => b.period.localeCompare(a.period));
}

export async function fetchForecast(stock: StockRecord, year: number, previous?: ForecastSnapshot | null, cache?: ForecastDocumentCache): Promise<ForecastSnapshot> {
  const today = forecastToday();
  let snapshot: ForecastSnapshot;
  const continuing = previous?.year === year && previous.fetched_at.startsWith(today) && (previous.search.pending.length || previous.search.continuations?.length);
  if (previous?.year === year && previous.fetched_at.startsWith(today) && (previous.search.pending.length || previous.search.continuations?.length)) snapshot = structuredClone(previous);
  else {
    snapshot = { year, fetched_at: new Date().toISOString(), fiscal_end: stock.market === "A" ? "12-31" : null, financials: [], consensus: null,
      dividends: [], commitments: [], search: { status: "not_found", from: `${year - 5}${today.slice(4)}`, to: today, pending: [], reviewed: [], notes: [] }, errors: [], fx: {} };
    const filter = stock.market === "A" ? `(SECURITY_CODE="${stock.code}")` : `(SECUCODE="${stock.code}.HK")`;
    const tasks = [
      (async () => {
        const result = await forecastReport(stock.market === "A" ? "RPT_F10_FINANCE_MAINFINADATA" : "RPT_HKF10_FN_MAININDICATOR", filter, "ALL", "REPORT_DATE", 30);
        let native: Row[] = [];
        if (stock.market === "HK") {
          const [profile, raw] = await Promise.all([
            forecastReport("RPT_HKF10_INFO_SECURITYINFO", filter, "SECURITY_CODE,YEAR_SETTLE_DAY", "", 1),
            forecastReport("RPT_HKF10_FN_INCOME", `${filter}(ITEM_NAME in ("每股基本盈利","股东应占溢利"))`, "SECURITY_CODE,REPORT_DATE,START_DATE,DATE_TYPE_CODE,ITEM_NAME,AMOUNT,CURRENCY_CODE", "REPORT_DATE", 80),
          ]);
          snapshot.fiscal_end = String(profile.rows[0]?.YEAR_SETTLE_DAY ?? ""); native = raw.rows;
        }
        snapshot.financials = parseForecastFinancials(result.rows, stock, result.url, today, native);
        if (stock.market === "A") {
          try {
            const bank = result.rows[0]?.ORG_TYPE === "银行";
            const balance = await forecastReport(bank ? "RPT_F10_FINANCE_BBALANCE" : "RPT_F10_FINANCE_GBALANCE", filter,
              "SECURITY_CODE,REPORT_DATE,NOTICE_DATE,OTHER_EQUITY_TOOL,PREFERRED_SHARES,PERPETUAL_BOND,TREASURY_SHARES", "REPORT_DATE", 30);
            attachForecastBalance(snapshot.financials, balance.rows, stock, balance.url, today);
          } catch (error) { snapshot.errors.push(`权益工具与库存股核查：${error instanceof Error ? error.message : "来源不可用"}`); }
        }
      })(),
      (async () => {
        if (stock.market === "A") {
          const result = await forecastReport("RPT_WEB_RESPREDICT", filter, "ALL", "", 1);
          snapshot.consensus = parseForecastAConsensus(result.rows, stock, year, today, result.url);
          if (snapshot.consensus) snapshot.errors.push("东方财富预测采用近六个月机构覆盖；未提供单独的预测更新日期，获取日期不代表研报日期。");
        } else {
          const url = `https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=${Number(stock.code)}`;
          snapshot.consensus = parseForecastHkConsensus(await forecastText(url), year, today, url);
        }
      })(),
      (async () => {
        const result = await forecastReport(stock.market === "A" ? "RPT_SHAREBONUS_DET" : "RPT_HKF10_MAIN_DIVBASIC", filter + (stock.market === "HK" ? '(IS_BFP="0")' : ""), "ALL", stock.market === "A" ? "REPORT_DATE" : "NOTICE_DATE", 100);
        snapshot.dividends = parseForecastDividends(result.rows, stock, result.url, today);
      })(),
      (async () => { snapshot.search = await searchForecastAnnouncements(stock, year, today); })(),
    ];
    const outcomes = await Promise.allSettled(tasks);
    outcomes.forEach((outcome, i) => { if (outcome.status === "rejected") snapshot.errors.push(`${["财务报表", "机构盈利预测", "历史分红", "公告检索"][i]}：${outcome.reason instanceof Error ? outcome.reason.message : "来源暂不可用"}`); });
    if (previous?.year === year) {
      if (outcomes[0].status === "rejected" && previous.financials.length) {
        snapshot.financials = structuredClone(previous.financials); snapshot.fiscal_end = previous.fiscal_end; snapshot.data_stale = true;
      }
      if (outcomes[1].status === "rejected" && previous.consensus) { snapshot.consensus = structuredClone(previous.consensus); snapshot.data_stale = true; }
      if (outcomes[2].status === "rejected" && previous.dividends.length) { snapshot.dividends = structuredClone(previous.dividends); snapshot.data_stale = true; }
      if (snapshot.search.status === "failed" && previous.commitments.length) {
        snapshot.commitments = structuredClone(previous.commitments); snapshot.data_stale = true;
        snapshot.search.reviewed = structuredClone(previous.search.reviewed);
        snapshot.search.notes.push("公告检索失败，保留上次已核实条款，请核对是否存在更新公告。");
      }
    }
    // Do not replace a previously usable financial snapshot with empty failed data.
    if (!snapshot.financials.length && !snapshot.consensus && !snapshot.dividends.length) throw new Error(snapshot.errors.join("；") || "未获取到有效预估资料");
  }
  if ([snapshot.consensus?.currency, ...snapshot.financials.map(r => r.currency), ...snapshot.dividends.map(r => r.currency)].includes("USD") && !snapshot.fx.USD) {
    try {
      const rates = JSON.parse(await forecastText("https://api.exchangerate-api.com/v4/latest/USD"));
      const rate = forecastNumber(rates?.rates?.CNY);
      if (rate && rate > 0 && rate < 20) snapshot.fx.USD = rate;
    } catch { snapshot.errors.push("USD/CNY 汇率暂不可用，美元股息率不估填。"); }
  }
  if (continuing && snapshot.search.continuations?.length) await continueForecastSearch(snapshot.search, stock);
  const batch = continuing ? snapshot.search.pending.splice(0, 2) : [];
  for (const announcement of batch) {
    try {
      const pages = await readForecastAnnouncement(announcement, stock, cache);
      const parsed = parseForecastCommitments(pages, announcement, stock, year);
      snapshot.commitments.push(...parsed.commitments);
      snapshot.search.reviewed.push({ ...announcement, excerpt: parsed.commitments[0]?.evidence.excerpt ?? parsed.notes.join("；"), page: parsed.commitments[0]?.evidence.page });
      if (parsed.notes.length) snapshot.search.notes.push(`${announcement.title}：${parsed.notes.join("；")}`);
    } catch (error) {
      snapshot.search.reviewed.push({ ...announcement, excerpt: "文本未核实" });
      snapshot.search.notes.push(`${announcement.title}：${error instanceof Error ? error.message : "解析失败"}`);
    }
  }
  const latestCommitment = snapshot.commitments.map(c => c.evidence.date).sort().at(-1);
  const unresolvedChange = latestCommitment && snapshot.search.reviewed.some(a => /调整|調整|修订|修訂|变更|變更|终止|終止|取消|撤销|撤銷|废止|廢止|修正|修改/.test(a.title)
    && a.date >= latestCommitment && !snapshot.commitments.some(c => c.evidence.url === a.url));
  if (unresolvedChange) {
    snapshot.commitments = [];
    snapshot.search.notes.push("发现较新的政策变更／撤销公告但条款未核实，停用旧承诺，暂用盈利模型，请人工核实。");
  }
  snapshot.search.status = (snapshot.search.pending.length || snapshot.search.continuations?.length) ? "partial" : snapshot.search.status === "failed" ? "failed" : snapshot.commitments.length ? "found" : snapshot.search.reviewed.length ? "review" : "not_found";
  snapshot.fetched_at = `${today}T${new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19)}+08:00`;
  return snapshot;
}
