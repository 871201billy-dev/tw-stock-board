"use strict";
// 個股 K 線圖（依賴 app.js 的 quotes、dailyMap、fmt 等全域變數）

const LWC_URL = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
const CLIENT_MONTHS = 4;
const MAS = [[5, "#f5a524"], [20, "#a855f7"], [60, "#3b82f6"]];

let lwcPromise = null, kchart = null, klineIndex = null, openCode = null;
const monthCache = new Map();

function loadLWC() {
  return (lwcPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LWC_URL;
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => { lwcPromise = null; reject(new Error("圖表元件載入失敗")); };
    document.head.appendChild(s);
  }));
}

const rocToISO = (s) => { const [y, m, d] = s.trim().split("/"); return `${+y + 1911}-${m}-${d}`; };
const numOf = (s) => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) ? v : null; };

// 上市股票：瀏覽器直接向證交所逐月抓取（證交所有開放 CORS），過去月份快取在 localStorage
async function twseMonth(code, y, m) {
  const ym = `${y}${String(m).padStart(2, "0")}`;
  const key = `kl:${code}:${ym}`;
  const now = new Date(Date.now() + 8 * 3600e3);
  const isCurrent = y === now.getUTCFullYear() && m === now.getUTCMonth() + 1;
  if (monthCache.has(key)) return monthCache.get(key);
  if (!isCurrent) {
    try { const v = JSON.parse(localStorage.getItem(key)); if (v) return v; } catch {}
  }
  const res = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${code}&response=json`);
  if (!res.ok) throw new Error(`證交所 HTTP ${res.status}`);
  const j = await res.json();
  const bars = j.stat === "OK"
    ? j.data.map((r) => [rocToISO(r[0]), numOf(r[3]), numOf(r[4]), numOf(r[5]), numOf(r[6]), Math.round((numOf(r[1]) ?? 0) / 1000)]).filter((b) => b[1] != null && b[4] != null)
    : [];
  monthCache.set(key, bars);
  if (!isCurrent) { try { localStorage.setItem(key, JSON.stringify(bars)); } catch {} }
  return bars;
}

async function twseHistory(code, onProgress) {
  const now = new Date(Date.now() + 8 * 3600e3);
  let all = [];
  for (let i = CLIENT_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const cached = monthCache.size;
    all = all.concat(await twseMonth(code, d.getUTCFullYear(), d.getUTCMonth() + 1));
    onProgress?.(CLIENT_MONTHS - i);
    if (monthCache.size > cached && i > 0) await new Promise((r) => setTimeout(r, 700)); // 避免觸發證交所流量限制
  }
  return all;
}

async function getBars(code, market, onProgress) {
  klineIndex ??= await fetch(`kline/index.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  if (klineIndex.includes(code)) {
    const r = await fetch(`kline/${code}.json?_=${Date.now()}`);
    if (r.ok) return { bars: (await r.json()).bars, src: "每日收盤後更新" };
  }
  if (market === "tse") return { bars: await twseHistory(code, onProgress), src: `近 ${CLIENT_MONTHS} 個月，直接取自證交所` };
  throw new Error("上櫃股票的 K 線只提供自選清單（watchlist.json）與熱門成交股票");
}

// 盤中加上今天的即時 K 棒
function withToday(bars, code) {
  const q = quotes?.stocks?.[code];
  if (!q?.d || q.o == null || q.p == null) return bars;
  const iso = `${q.d.slice(0, 4)}-${q.d.slice(4, 6)}-${q.d.slice(6)}`;
  if (bars.length && bars.at(-1)[0] >= iso) return bars;
  return bars.concat([[iso, q.o, q.h ?? q.p, q.l ?? q.p, q.p, q.v ?? 0]]);
}

function sma(bars, n) {
  const out = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b[4];
    if (i >= n) sum -= bars[i - n][4];
    if (i >= n - 1) out.push({ time: b[0], value: +(sum / n).toFixed(2) });
  });
  return out;
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function draw(LWC, bars) {
  const el = $("#k-chart");
  kchart?.remove();
  const up = css("--up"), down = css("--down"), text = css("--muted"), line = css("--line");
  kchart = LWC.createChart(el, {
    autoSize: true,
    layout: { background: { color: "transparent" }, textColor: text, fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderColor: line },
    timeScale: { borderColor: line, rightOffset: 3, minBarSpacing: 2 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    localization: { locale: "zh-TW", dateFormat: "yyyy/MM/dd" },
  });
  const candle = kchart.addCandlestickSeries({
    upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
  });
  candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.26 } });
  candle.setData(bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));

  const vol = kchart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
  kchart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  vol.setData(bars.map((b, i) => ({ time: b[0], value: b[5], color: (b[4] >= (i ? bars[i - 1][4] : b[1]) ? up : down) + "88" })));

  for (const [n, color] of MAS) {
    kchart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      .setData(sma(bars, n));
  }

  const byTime = new Map(bars.map((b, i) => [b[0], i]));
  const legend = (i) => {
    const b = bars[i];
    if (!b) return;
    const prev = i ? bars[i - 1][4] : b[1];
    const ch = b[4] - prev, c = cls(ch), d = decimals(b[4]);
    const mas = MAS.map(([n, color]) => {
      if (i < n - 1) return "";
      const avg = bars.slice(i - n + 1, i + 1).reduce((s, x) => s + x[4], 0) / n;
      return `<span style="color:${color}">MA${n} ${fmt(avg, d)}</span>`;
    }).join("");
    $("#k-legend").innerHTML = `<span>${b[0].replace(/-/g, "/")}</span>
      <span>開 <b class="${c}">${fmt(b[1], d)}</b></span><span>高 <b class="${c}">${fmt(b[2], d)}</b></span>
      <span>低 <b class="${c}">${fmt(b[3], d)}</b></span><span>收 <b class="${c}">${fmt(b[4], d)}</b></span>
      <span class="${c}">${arrow(ch)}${fmt(Math.abs(ch), d)} (${fmt(prev ? (ch / prev) * 100 : 0)}%)</span>
      <span>量 ${fmtInt(b[5])}</span>${mas}`;
  };
  legend(bars.length - 1);
  kchart.subscribeCrosshairMove((p) => legend(p.time ? byTime.get(p.time) : bars.length - 1));
  setRange(currentRange, bars.length);
}

let currentRange = 66, barCount = 0;
function setRange(n, count = barCount) {
  currentRange = n; barCount = count;
  if (!kchart || !count) return;
  if (n >= count) kchart.timeScale().fitContent();
  else kchart.timeScale().setVisibleLogicalRange({ from: count - n, to: count + 2 });
  $("#k-range").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.n === n));
}

async function openKline(code) {
  const info = quotes?.stocks?.[code] ?? dailyMap.get(code);
  if (!info) return;
  openCode = code;
  const dlg = $("#kline");
  $("#k-title").innerHTML = `${esc(code)} <small>${esc(info.n)}</small>${info.m === "otc" ? '<span class="tag">櫃</span>' : ""}`;
  const c = cls(info.ch), d = decimals(info.p);
  $("#k-quote").innerHTML = `<span class="${c} k-price">${fmt(info.p, d)}</span><span class="${c}">${arrow(info.ch)} ${fmt(Math.abs(info.ch), d)}（${fmt(pct(info.p, info.ch))}%）</span>`;
  $("#k-legend").innerHTML = "";
  $("#k-note").textContent = "載入中…";
  kchart?.remove(); kchart = null;
  $("#k-chart").innerHTML = "";
  if (!dlg.open) dlg.showModal();
  if (location.hash !== "#" + code) history.replaceState(null, "", "#" + code);
  try {
    const [LWC, res] = await Promise.all([loadLWC(), getBars(code, info.m, (k) => { if (openCode === code) $("#k-note").textContent = `向證交所下載歷史資料 ${k}/${CLIENT_MONTHS}…`; })]);
    if (openCode !== code) return;
    const bars = withToday(res.bars, code);
    if (!bars.length) throw new Error("沒有歷史資料");
    draw(LWC, bars);
    $("#k-note").textContent = `日 K・共 ${bars.length} 根・${res.src}・紅漲綠跌`;
  } catch (e) {
    if (openCode === code) $("#k-note").textContent = "無法載入 K 線：" + e.message;
  }
}

// ---------- 事件 ----------
document.addEventListener("click", (e) => {
  if (e.target.closest(".rm")) return;
  const tr = e.target.closest("tr[data-code]");
  if (tr) openKline(tr.dataset.code);
});
$("#k-close").addEventListener("click", () => $("#kline").close());
$("#kline").addEventListener("click", (e) => { if (e.target.id === "kline") e.target.close(); });
$("#kline").addEventListener("close", () => {
  openCode = null; kchart?.remove(); kchart = null;
  history.replaceState(null, "", location.pathname + location.search);
});
// 網址 #2330 直接開啟該股 K 線
const openFromHash = () => {
  const code = decodeURIComponent(location.hash.slice(1));
  if (code && code !== openCode && dailyMap.has(code)) openKline(code);
};
document.addEventListener("data-ready", openFromHash);
window.addEventListener("hashchange", openFromHash);
$("#k-range").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setRange(+b.dataset.n);
});
