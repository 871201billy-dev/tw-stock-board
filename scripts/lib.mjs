export const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 tw-stock-board" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse((await res.text()).trim());
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1500 * i);
    }
  }
}

// ---- 每日收盤行情（上市 + 上櫃）----
export async function fetchDaily() {
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
