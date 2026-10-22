// 抓取自選股＋熱門股的日 K 線，寫入 site/kline/<代號>.json（每日收盤後由 GitHub Actions 執行並 commit）
// 上櫃股票的歷史資料 API 不允許瀏覽器直接讀取，所以必須預先抓好；上市股票網頁也能自己向證交所抓。
import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { num, getJSON, sleep, fetchDaily } from "./lib.mjs";

const OUT = new URL("../site/kline/", import.meta.url);
const HOT_COUNT = 40;
const INIT_MONTHS = 6;
const MAX_BARS = 500;
const GAP = { tse: 2000, otc: 800 }; // 證交所約每 5 秒 3 次以上會封鎖 IP

const pad = (n) => String(n).padStart(2, "0");
const rocToISO = (s) => {
  const [y, m, d] = s.trim().split("/");
  return `${+y + 1911}-${m}-${d}`;
};

// 回傳 [日期, 開, 高, 低, 收, 成交量(張)]
async function fetchMonth(m, code, y, mo) {
  if (m === "tse") {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${y}${pad(mo)}01&stockNo=${code}&response=json`);
    if (j.stat !== "OK") return [];
    return j.data.map((r) => [rocToISO(r[0]), num(r[3]), num(r[4]), num(r[5]), num(r[6]), Math.round((num(r[1]) ?? 0) / 1000)]);
  }
  const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${pad(mo)}/01&response=json`);
  return (j.tables?.[0]?.data ?? []).map((r) => [rocToISO(r[0]), num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[1]) ?? 0]);
}

function monthsSince(fromISO, now) {
  const out = [];
  let [y, m] = fromISO ? fromISO.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1 - (INIT_MONTHS - 1)];
  while (m < 1) { m += 12; y--; }
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    out.push([y, m]);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const watch = JSON.parse(await readFile(new URL("../watchlist.json", import.meta.url), "utf8"));
  const daily = await fetchDaily();
  if (!daily.length) throw new Error("no daily data");
  const info = new Map(daily.map((r) => [r.c, r]));
  const hot = daily.filter((r) => /^\d{4}$/.test(r.c)).sort((a, b) => b.val - a.val).slice(0, HOT_COUNT).map((r) => r.c);
  const codes = [...new Set([...watch, ...hot])].filter((c) => info.has(c));
  const now = new Date(Date.now() + 8 * 3600e3); // 以 UTC 欄位讀取即為台北時間

  let failed = 0;
  for (const code of codes) {
    const { n, m } = info.get(code);
    const file = new URL(`${code}.json`, OUT);
    let prev = null;
    try { prev = JSON.parse(await readFile(file, "utf8")); } catch {}
    const bars = new Map((prev?.bars ?? []).map((b) => [b[0], b]));
    try {
      for (const [y, mo] of monthsSince(prev?.bars?.at(-1)?.[0], now)) {
        for (const b of await fetchMonth(m, code, y, mo)) if (b[1] != null && b[4] != null) bars.set(b[0], b);
        await sleep(GAP[m]);
      }
    } catch (e) {
      failed++;
      console.warn(`${code}: ${e.message}`);
      if (!prev) continue;
    }
    const sorted = [...bars.values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-MAX_BARS);
    await writeFile(file, JSON.stringify({ c: code, n, m, bars: sorted }));
  }

  // 移除已不在清單中的檔案
  const keep = new Set(codes.map((c) => `${c}.json`));
  for (const f of await readdir(OUT)) if (f.endsWith(".json") && f !== "index.json" && !keep.has(f)) await unlink(new URL(f, OUT));
  await writeFile(new URL("index.json", OUT), JSON.stringify(codes));

  console.log(`kline: ${codes.length} codes, ${failed} failed`);
  if (failed > codes.length / 2) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
