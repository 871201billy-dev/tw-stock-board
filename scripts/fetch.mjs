// 抓取台股資料並寫入 site/data/*.json（由 GitHub Actions 定時執行）
// 用法：node scripts/fetch.mjs [前一版網站網址，用來延續盤中走勢]
import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = new URL("../site/data/", import.meta.url);
const PREV_SITE = process.argv[2]; // e.g. https://user.github.io/tw-stock-board/
const HOT_COUNT = 40;

const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 tw-stock-board" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse((await res.text()).trim());
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// ---- 每日收盤行情（上市 + 上櫃）----
async function fetchDaily() {
  const [tse, otc] = await Promise.allSettled([
    getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"),
    getJSON("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"),
  ]);
  const rows = [];
  if (tse.status === "fulfilled") {
    for (const r of tse.value) {
      const p = num(r.ClosingPrice);
      if (p == null) continue;
      rows.push({ c: r.Code, n: r.Name, m: "tse", d: r.Date, p, ch: num(r.Change) ?? 0,
        o: num(r.OpeningPrice), h: num(r.HighestPrice), l: num(r.LowestPrice),
        v: Math.round((num(r.TradeVolume) ?? 0) / 1000), val: num(r.TradeValue) ?? 0 });
    }
  } else console.warn("TWSE daily failed:", tse.reason.message);
  if (otc.status === "fulfilled") {
    for (const r of otc.value) {
      const p = num(r.Close);
      if (p == null) continue;
      rows.push({ c: r.SecuritiesCompanyCode, n: r.CompanyName, m: "otc", d: r.Date, p, ch: num(r.Change) ?? 0,
        o: num(r.Open), h: num(r.High), l: num(r.Low),
        v: Math.round((num(r.TradingShares) ?? 0) / 1000), val: num(r.TransactionAmount) ?? 0 });
    }
  } else console.warn("TPEx daily failed:", otc.reason.message);
  return rows;
}

// ---- 即時行情（證交所基本市況報導 mis）----
function parseMis(q) {
  const y = num(q.y);
  // z 為最新成交價；盤中尚無成交時為 "-"，改用最佳買價
  let z = num(q.z) ?? num(q.pz) ?? num(String(q.b ?? "").split("_")[0]);
  if (z === 0) z = null;
  const levels = (s) => String(s ?? "").split("_").filter(Boolean).map(num);
  return {
    c: q.c, n: q.n, m: q.ex, p: z ?? y, y,
    ch: z != null && y != null ? +(z - y).toFixed(2) : 0,
    o: num(q.o), h: num(q.h), l: num(q.l),
    v: num(q.v), u: num(q.u), w: num(q.w),
    a: levels(q.a), b: levels(q.b), t: q.t, d: q.d,
  };
}

async function fetchRealtime(chans) {
  const out = {};
  for (let i = 0; i < chans.length; i += 50) {
    const batch = chans.slice(i, i + 50).join("|");
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(batch)}&json=1&delay=0&_=${Date.now()}`;
    const j = await getJSON(url);
    for (const q of j.msgArray ?? []) out[q.c] = parseMis(q);
  }
  return out;
}

async function readLocal(name) {
  try { return JSON.parse(await readFile(new URL(name, OUT), "utf8")); } catch { return null; }
}

async function readPrev(name) {
  if (!PREV_SITE) return readLocal(name);
  try {
    const res = await fetch(new URL(`data/${name}?_=${Date.now()}`, PREV_SITE));
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const watch = JSON.parse(await readFile(new URL("../watchlist.json", import.meta.url), "utf8"));

  let daily = { updated: new Date().toISOString(), rows: await fetchDaily() };
  if (!daily.rows.length) daily = (await readPrev("daily.json")) ?? daily;
  if (!daily.rows.length) throw new Error("no daily data");
  await writeFile(new URL("daily.json", OUT), JSON.stringify(daily));
  daily = daily.rows;

  const market = new Map(daily.map((r) => [r.c, r.m]));
  const hot = [...daily].filter((r) => /^\d{4}$/.test(r.c)).sort((a, b) => b.val - a.val).slice(0, HOT_COUNT).map((r) => r.c);
  const codes = [...new Set([...watch, ...hot])].filter((c) => market.has(c));
  const chans = ["tse_t00.tw", "otc_o00.tw", ...codes.map((c) => `${market.get(c)}_${c}.tw`)];

  let rt = {};
  try { rt = await fetchRealtime(chans); }
  catch (e) { console.warn("realtime failed:", e.message); }

  const prevQuotes = await readPrev("quotes.json");
  const quotes = Object.keys(rt).length
    ? { updated: new Date().toISOString(), watch, hot, indices: { tse: rt.t00, otc: rt.o00 }, stocks: rt }
    : prevQuotes ?? { updated: null, watch, hot, indices: {}, stocks: {} };
  quotes.watch = watch;
  await writeFile(new URL("quotes.json", OUT), JSON.stringify(quotes));

  // 盤中走勢：同一交易日內累積每次抓到的指數
  let intra = (await readPrev("intraday.json")) ?? {};
  const tse = rt.t00, otc = rt.o00;
  if (tse?.d && tse.t) {
    if (intra.d !== tse.d) intra = { d: tse.d, tseY: tse.y, otcY: otc?.y ?? null, pts: [] };
    const last = intra.pts.at(-1);
    if (!last || last.t !== tse.t) intra.pts.push({ t: tse.t, tse: tse.p, otc: otc?.p ?? null });
  }
  await writeFile(new URL("intraday.json", OUT), JSON.stringify(intra));

  console.log(`daily=${daily.length} realtime=${Object.keys(rt).length} intraday=${intra.pts?.length ?? 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
