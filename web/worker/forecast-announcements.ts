import { parseHTML } from "linkedom";
import { forecastBytes, forecastText } from "./forecast-http.ts";
import type { ForecastAnnouncement, ForecastCommitment, ForecastSearch } from "./forecast-types.ts";
import type { StockRecord } from "./types.ts";

export interface ForecastDocumentCache {
  read(id: string): Promise<string[] | null>;
  write(id: string, pages: string[]): Promise<void>;
}
const clean = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
const normalize = (s: string) => s.replace(/現金/g, "现金").replace(/分紅/g, "分红").replace(/審議/g, "审议").replace(/通過/g, "通过").replace(/經/g, "经").replace(/於/g, "于").replace(/總額/g, "总额").replace(/金額/g, "金额").replace(/派發/g, "派发").replace(/股東/g, "股东").replace(/歸屬/g, "归属").replace(/淨利潤/g, "净利润").replace(/利潤/g, "利润").replace(/年度/g, "年度").replace(/不低於/g, "不低于").replace(/人民幣/g, "人民币").replace(/港幣/g, "港币");
const keyword = /分红|分紅|回报|回報|股息|dividend|利润分配|利潤分配/i;
export function officialAnnouncementUrl(value: string, market: "A" | "HK"): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (market === "A" ? url.hostname === "static.cninfo.com.cn" : ["www1.hkexnews.hk", "www.hkexnews.hk"].includes(url.hostname));
  } catch { return false; }
}

/** Conservative clause parser. Anything ambiguous remains evidence for human review. */
export function parseForecastCommitments(pages: string[], announcement: ForecastAnnouncement, stock: Pick<StockRecord, "code" | "market">, year: number) {
  const commitments: ForecastCommitment[] = [], notes: string[] = [];
  const whole = normalize(pages.join("\n"));
  // The code must occur in the official body, not only in search metadata.
  if (!whole.includes(stock.code) && !(stock.market === "HK" && new RegExp(`(?:股份|股票|Stock)\\s*(?:代[码碼号號]|Code)?[：:\\s]*0*${Number(stock.code)}(?!\\d)`, "i").test(whole))) return { commitments, notes: ["公告正文未核实证券代码，待人工核实"] };
  if (/未获.{0,25}(?:批准|通过)|尚未.{0,25}(?:批准|通过)|(?:股东|股東).{0,25}(?:未通过|否决)|(?:已|予以).{0,12}(?:取消|撤销|终止|废止)|尚需.{0,25}(?:股东|股東)|须经.{0,20}批准|須經.{0,20}批准|subject to.{0,30}approval/i.test(whole)) return { commitments, notes: ["公告包含待批准条款，未自动采用承诺"] };
  if (!/股东.{0,30}(?:通过|批准)|(?:已|经).{0,12}(?:审议通过|批准)|approved by.{0,30}shareholders/i.test(whole)) return { commitments, notes: ["未从正文核实分红政策已获批准，待人工核实"] };
  if (/回购|回購|现金分红在本次利润分配|现金分红占.{0,10}利润分配|最近三年|三年累计|三年累計|累计分配|累計分配/.test(whole)) return { commitments, notes: ["含回购、累计约束或分母歧义，未自动采用承诺"] };
  const range = whole.match(/(20\d{2})\s*年?\s*[—–－\-至到]\s*(20\d{2})\s*年/);
  const single = whole.match(/(20\d{2})\s*年度(?:的)?(?:利润分配|现金分红|股息|分红)/);
  const start = range ? Number(range[1]) : single ? Number(single[1]) : null;
  const end = range ? Number(range[2]) : start;
  if (start === null || end === null || year < start || year > end || range && !/(每年|每年度|各年度|每一年度|每个年度)/.test(whole)) return { commitments, notes: ["无法确认单年承诺适用年份，待人工核实"] };
  for (let index = 0; index < pages.length; index++) {
    const page = normalize(pages[index]).replace(/\s+/g, "");
    const clauses = page.split(/[。；;]/);
    for (const clause of clauses) {
      if (!/现金|股息/.test(clause) || /上限|不超过|不超過|本次分配|中期|半年度|季度/.test(clause)) continue;
      const lower = /不低于|不少于|至少/.test(clause);
      const ratio = clause.match(/(?:现金分红|现金股利|现金派息).{0,55}?(?:不低于|不少于|为|占|至少).{0,40}?(?:归属于.{0,12}股东.{0,8}净利润|归母净利润|普通股股东.{0,8}净利润)(?:的)?(\d+(?:\.\d+)?)%/)
        ?? clause.match(/(?:现金分红|现金股利|现金派息).{0,30}?(?:占|为)(?:当年|年度)?.{0,12}?(?:归母净利润|归属于.{0,12}股东.{0,8}净利润)(?:的)?(?:比例)?(?:不低于|不少于|为|至少)?(\d+(?:\.\d+)?)%/);
      const perShare = clause.match(/每(?:股|10股)(?:全年|年度|每年)?.{0,12}?(?:派发|派|现金股息|现金红利|分红|股息)(?:不低于|不少于|至少|为)?(人民币|港币|港元|美元)(\d+(?:\.\d+)?)(元|仙|分)?/);
      const total = clause.match(/(?:每年|每年度|年度|全年).{0,12}?(?:现金分红总额|现金股利总额|现金分红金额)(?:不低于|不少于|至少|为)(人民币|港币|港元|美元)(\d+(?:\.\d+)?)(亿元|万元|元)/);
      const currency = /人民币/.test(clause) || stock.market === "A" ? "CNY" : /港币|港元/.test(clause) ? "HKD" : /美元/.test(clause) ? "USD" : null;
      if (!currency) continue;
      const condition = whole.match(/(?:在|当|若|如)[^。；\n]{0,150}(?:盈利|可供分配|现金流|资金|审计|重大投资)[^。；\n]{0,120}/);
      const base = { start_year: start, end_year: end, lower_bound: lower, currency, conditions: condition?.[0] ?? "以公告所列分红条件成立为前提", approved: true,
        evidence: { url: announcement.url, title: announcement.title, date: announcement.date, page: index + 1, excerpt: clause.slice(0, 600) } } as const;
      if (ratio && Number(ratio[1]) <= 100) commitments.push({ ...base, kind: "ratio", value: Number(ratio[1]) / 100, profit_basis: /普通股股东/.test(clause) ? "ordinary" : "parent" });
      else if (perShare) commitments.push({ ...base, kind: "per_share", value: Number(perShare[2]) / (/每10股/.test(clause) ? 10 : 1) / (/仙|分/.test(perShare[3] ?? "") ? 100 : 1) });
      else if (total) {
        const shares = page.match(/以(?:总股本|参与分红的股份|参与分配的股份)?([\d,]+)股为基数/);
        if (shares) commitments.push({ ...base, kind: "total", value: Number(total[2]) * (total[3] === "亿元" ? 1e8 : total[3] === "万元" ? 1e4 : 1), shares: Number(shares[1].replaceAll(",", "")) });
        else notes.push("总额承诺缺少可核实的参与分红股数，待人工补充");
      }
    }
  }
  if (!commitments.length) notes.push("正文未识别出完整、可核实的单年现金分红条款");
  return { commitments, notes };
}

export async function searchForecastAnnouncements(stock: StockRecord, year: number, today: string): Promise<ForecastSearch> {
  const from = `${year - 5}${today.slice(4)}`;
  const search: ForecastSearch = { status: "not_found", from, to: today, pending: [], reviewed: [], notes: [], continuations: [] };
  try {
    if (stock.market === "A") {
      const lookup = JSON.parse(await forecastText("https://www.cninfo.com.cn/new/information/topSearch/query", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.cninfo.com.cn/" }, body: new URLSearchParams({ keyWord: stock.code, maxSecNum: "10", maxListNum: "0" }) }));
      const found = (Array.isArray(lookup) ? lookup : lookup.keyBoardList ?? lookup.stockList ?? []).find((r: Record<string, unknown>) => String(r.code ?? r.secCode) === stock.code);
      if (!found?.orgId) throw new Error("巨潮未返回匹配证券身份");
      for (const word of ["分红", "回报", "利润分配"]) {
        const data = JSON.parse(await forecastText("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.cninfo.com.cn/" }, body: new URLSearchParams({ pageNum: "1", pageSize: "30", column: "szse", tabName: "fulltext", stock: `${stock.code},${found.orgId}`, searchkey: word, seDate: `${from}~${today}`, sortName: "time", sortType: "desc", isHLtitle: "false" }) }));
        if (!Array.isArray(data.announcements)) throw new Error("巨潮公告检索返回格式无效");
        if (Number(data.totalAnnouncement) > 30) search.continuations!.push({ market: "A", stock_id: `${stock.code},${found.orgId}`, term: word, page: 2 });
        for (const row of data.announcements) {
          if (String(row.secCode) !== stock.code || !keyword.test(row.announcementTitle)) continue;
          const url = new URL(String(row.adjunctUrl), "https://static.cninfo.com.cn/").href;
          if (!officialAnnouncementUrl(url, stock.market)) continue;
          search.pending.push({ id: `cn:${row.announcementId}`, title: clean(row.announcementTitle), url, date: new Date(Number(row.announcementTime) + 8 * 3600_000).toISOString().slice(0, 10) });
        }
      }
    } else {
      const prefix = await forecastText(`https://www1.hkexnews.hk/search/prefix.do?${new URLSearchParams({ callback: "callback", lang: "ZH", type: "A", name: stock.code })}`);
      const payload = JSON.parse(prefix.replace(/^\s*callback\(/, "").replace(/\);?\s*$/, ""));
      const matches = (payload.stockInfo ?? []).filter((row: Record<string, unknown>) => Number(row.code) === Number(stock.code));
      if (matches.length !== 1 || !matches[0].stockId) throw new Error("披露易未返回匹配证券身份");
      for (const title of ["股息", "分紅", "回報"]) {
        const query = new URLSearchParams({ sortDir: "0", sortByOptions: "DateTime", category: "0", market: "SEHK", stockId: String(matches[0].stockId), documentType: "-1", fromDate: from.replaceAll("-", ""), toDate: today.replaceAll("-", ""), title, searchType: "0", t1code: "-2", t2Gcode: "-2", t2code: "-2", rowRange: "100", lang: "zh" });
        const response = JSON.parse(await forecastText(`https://www1.hkexnews.hk/search/titleSearchServlet.do?${query}`, { headers: { Referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml" } }));
        const rows = typeof response.result === "string" ? JSON.parse(response.result) : response.result;
        if (!Array.isArray(rows)) throw new Error("披露易公告检索返回格式无效");
        if (Number(response.recordCnt) > rows.length) search.continuations!.push({ market: "HK", stock_id: String(matches[0].stockId), term: title, page: 2 });
        for (const row of rows) {
          const code = clean(String(row.STOCK_CODE ?? ""));
          if (!code.split(/[\s,;/]+/).some(c => Number(c) === Number(stock.code))) continue;
          const url = new URL(String(row.FILE_LINK), "https://www1.hkexnews.hk/").href;
          const dateMatch = String(row.DATE_TIME).match(/(\d{2})\/(\d{2})\/(20\d{2})/);
          if (!officialAnnouncementUrl(url, stock.market) || !dateMatch) continue;
          search.pending.push({ id: `hk:${row.NEWS_ID ?? row.FILE_LINK}`, title: clean(String(row.TITLE)), url, date: `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` });
        }
      }
    }
    search.pending = [...new Map(search.pending.filter(a => a.date <= today && a.date >= from).map(a => [a.id, a])).values()].sort((a, b) => b.date.localeCompare(a.date));
    if (search.pending.length) search.status = "partial";
  } catch (error) { search.status = "failed"; search.notes.push(`公告检索失败：${error instanceof Error ? error.message : "来源暂不可用"}；不代表没有承诺。`); }
  return search;
}

export async function readForecastAnnouncement(announcement: ForecastAnnouncement, stock: StockRecord, cache?: ForecastDocumentCache): Promise<string[]> {
  if (!officialAnnouncementUrl(announcement.url, stock.market)) throw new Error("公告来源不在官方域名范围内");
  const cached = await cache?.read(announcement.id);
  if (cached) return cached;
  const bytes = await forecastBytes(announcement.url, {}, 5 * 1024 * 1024, 12_000);
  let pages: string[];
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes, { maxImageSize: 1, disableFontFace: true, useSystemFonts: false });
    try {
      if (pdf.numPages > 80) throw new Error("公告超过80页，请人工核实");
      pages = [];
      const deadline = Date.now() + 8000;
      let characters = 0;
      for (let p = 1; p <= pdf.numPages; p++) {
        if (Date.now() > deadline) throw new Error("公告文本解析超过时限，请人工核实");
        const page = await pdf.getPage(p), text = await page.getTextContent();
        const content = text.items.map(item => "str" in item ? item.str : "").join(" ");
        characters += content.length;
        if (characters > 400_000) throw new Error("公告文本过长，请人工核实");
        pages.push(content);
        page.cleanup();
      }
    } finally { await pdf.loadingTask.destroy(); }
  } else {
    const { document } = parseHTML(new TextDecoder().decode(bytes));
    document.querySelectorAll("script,style").forEach(e => e.remove());
    pages = [document.body.textContent ?? ""];
  }
  if (pages.join("").replace(/\s/g, "").length < 40) throw new Error("公告为扫描件或文字不可提取，请人工补充");
  if (pages.join("").length > 400_000) throw new Error("公告文本过长，请人工核实");
  await cache?.write(announcement.id, pages);
  return pages;
}

/** One extra search page per request; both the search and PDF queues are durable. */
export async function continueForecastSearch(search: ForecastSearch, stock: StockRecord) {
  const next = search.continuations?.shift();
  if (!next) return;
  try {
    const seen = new Set([...search.pending, ...search.reviewed].map(a => a.url));
    let additions: ForecastAnnouncement[] = [];
    if (next.market === "A") {
      const payload = new URLSearchParams({ pageNum: String(next.page), pageSize: "30", column: "szse", tabName: "fulltext", stock: next.stock_id, searchkey: next.term, seDate: `${search.from}~${search.to}`, sortName: "time", sortType: "desc", isHLtitle: "false" });
      const data = JSON.parse(await forecastText("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.cninfo.com.cn/" }, body: payload }));
      if (!Array.isArray(data.announcements)) throw new Error("巨潮公告分页返回格式无效");
      additions = data.announcements.filter((r: Record<string, unknown>) => String(r.secCode) === stock.code && keyword.test(String(r.announcementTitle))).map((r: Record<string, unknown>) => ({
        id: `cn:${r.announcementId}`, title: clean(String(r.announcementTitle)), url: new URL(String(r.adjunctUrl), "https://static.cninfo.com.cn/").href,
        date: new Date(Number(r.announcementTime) + 8 * 3600_000).toISOString().slice(0, 10),
      }));
      if (Number(data.totalAnnouncement) > next.page * 30) search.continuations!.push({ ...next, page: next.page + 1 });
    } else {
      const query = new URLSearchParams({ sortDir: "0", sortByOptions: "DateTime", category: "0", market: "SEHK", stockId: next.stock_id, documentType: "-1", fromDate: search.from.replaceAll("-", ""), toDate: search.to.replaceAll("-", ""), title: next.term, searchType: "0", t1code: "-2", t2Gcode: "-2", t2code: "-2", rowRange: String(next.page * 100), lang: "zh" });
      const response = JSON.parse(await forecastText(`https://www1.hkexnews.hk/search/titleSearchServlet.do?${query}`, { headers: { Referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml" } }));
      const rows = typeof response.result === "string" ? JSON.parse(response.result) : response.result;
      if (!Array.isArray(rows)) throw new Error("披露易公告分页返回格式无效");
      for (const row of rows) {
        if (!clean(String(row.STOCK_CODE)).split(/[\s,;/]+/).some(c => Number(c) === Number(stock.code))) continue;
        const date = String(row.DATE_TIME).match(/(\d{2})\/(\d{2})\/(20\d{2})/);
        if (date) additions.push({ id: `hk:${row.NEWS_ID ?? row.FILE_LINK}`, title: clean(String(row.TITLE)), url: new URL(String(row.FILE_LINK), "https://www1.hkexnews.hk/").href, date: `${date[3]}-${date[2]}-${date[1]}` });
      }
      if (Number(response.recordCnt) > rows.length) search.continuations!.push({ ...next, page: next.page + 1 });
    }
    search.pending.push(...additions.filter(a => officialAnnouncementUrl(a.url, stock.market) && !seen.has(a.url) && a.date >= search.from && a.date <= search.to));
    search.pending.sort((a, b) => b.date.localeCompare(a.date));
  } catch (error) {
    // Keep the cursor for an explicit retry rather than silently declaring no promise.
    search.continuations!.unshift(next);
    search.notes.push(`公告分页检索失败：${error instanceof Error ? error.message : "来源暂不可用"}，保留续查位置。`);
  }
}
