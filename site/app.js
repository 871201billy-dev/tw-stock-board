"use strict";

const REFRESH_MS = 60_000;
const LS_KEY = "tw-stock-board:watch";
const $ = (s) => document.querySelector(s);

let quotes = null, daily = null, intra = null;
let dailyMap = new Map();
let mktFilter = "all", sortKey = "up";

// ---------- 工具 ----------
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtInt = (v) => (v == null ? "—" : Math.round(v).toLocaleString("zh-TW"));
const fmtVal = (v) => (v == null ? "—" : v >= 1e8 ? fmt(v / 1e8, 1) + " 億" : fmt(v / 1e4, 0) + " 萬");
const cls = (ch) => (ch > 0 ? "up" : ch < 0 ? "down" : "flat");
const arrow = (ch) => (ch > 0 ? "▲" : ch < 0 ? "▼" : "");
const pct = (p, ch) => (p - ch ? (ch / (p - ch)) * 100 : 0);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const decimals = (p) => (p == null || p < 50 ? 2 : p < 500 ? 1 : 0);

function loadWatch() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY));
    if (Array.isArray(v)) return v;
  } catch {}
  return null;
}
function saveWatch(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
}
const watchList = () => loadWatch() ?? quotes?.watch ?? [];

async function getJSON(name) {
  const res = await fetch(`data/${name}?_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

// 市場狀態（以台北時間判斷）
function marketStatus() {
  const now = new Date(Date.now() + 8 * 3600e3);
  const day = now.getUTCDay(), m = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return ["休市", false];
  if (m >= 9 * 60 && m <= 13 * 60 + 30) return ["盤中", true];
  if (m < 9 * 60) return ["盤前", false];
  return ["已收盤", false];
}

// ---------- 指數卡片 ----------
function renderIndex(id, q, key) {
  const el = $(id);
  if (!q) return;
  const ch = q.ch, c = cls(ch);
  el.querySelector(".big").textContent = fmt(q.p);
  el.querySelector(".big").className = "big " + c;
  el.querySelector(".chg").innerHTML = `<span class="${c}">${arrow(ch)} ${fmt(Math.abs(ch))}　${fmt(pct(q.p, ch))}%</span>`;
  el.querySelector(".idx-time").textContent = q.d ? `${q.d.slice(4, 6)}/${q.d.slice(6)} ${q.t ?? ""}` : "";
  el.querySelector(".ohl").innerHTML = [["開盤", q.o], ["最高", q.h], ["最低", q.l], ["昨收", q.y]]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${fmt(v)}</dd></div>`).join("");
  drawSpark(el.querySelector(".spark"), key, q.y);
}

function drawSpark(svg, key, y0) {
  const pts = (intra?.pts ?? []).filter((p) => p[key] != null);
  const W = 300, H = 90, pad = 4;
  if (pts.length < 2 || y0 == null) {
    svg.innerHTML = `<text x="150" y="50" text-anchor="middle" font-size="11" fill="var(--muted)">走勢資料累積中</text>`;
    return;
  }
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const t0 = 9 * 60, t1 = 13 * 60 + 30;
  const vals = pts.map((p) => p[key]).concat(y0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const x = (t) => pad + ((Math.min(Math.max(toMin(t), t0), t1) - t0) / (t1 - t0)) * (W - 2 * pad);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
  const last = pts.at(-1)[key];
  const color = last >= y0 ? "var(--up)" : "var(--down)";
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const area = `${line}L${x(pts.at(-1).t).toFixed(1)},${H}L${x(pts[0].t).toFixed(1)},${H}Z`;
  svg.innerHTML = `
    <line x1="0" x2="${W}" y1="${y(y0)}" y2="${y(y0)}" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>
    <path d="${area}" fill="${color}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`;
}

// ---------- 表格 ----------
const HEAD = `<thead><tr><th>股票</th><th>成交</th><th>漲跌</th><th>幅度</th><th class="hide-sm">開盤</th><th class="hide-sm">最高</th><th class="hide-sm">最低</th><th>成交量(張)</th><th class="hide-sm">時間</th><th></th></tr></thead>`;

function row(s, { removable = false, live = true, last = live ? esc(s.t ?? "") : "收盤" } = {}) {
  const d = decimals(s.p), c = cls(s.ch), pc = pct(s.p, s.ch);
  let price = fmt(s.p, d);
  if (live && s.u && s.p >= s.u) price = `<span class="limit-up">${price}</span>`;
  else if (live && s.w && s.p <= s.w) price = `<span class="limit-down">${price}</span>`;
  return `<tr>
    <td class="name"><b>${esc(s.c)}</b><small>${esc(s.n)}</small>${s.m === "otc" ? '<span class="tag">櫃</span>' : ""}</td>
    <td class="price ${c}">${price}</td>
    <td class="${c}">${arrow(s.ch)} ${fmt(Math.abs(s.ch), d)}</td>
    <td class="${c}">${fmt(pc)}%</td>
    <td class="hide-sm">${fmt(s.o, d)}</td>
    <td class="hide-sm">${fmt(s.h, d)}</td>
    <td class="hide-sm">${fmt(s.l, d)}</td>
    <td>${fmtInt(s.v)}</td>
    <td class="hide-sm">${last}</td>
    <td>${removable ? `<button class="rm" data-code="${esc(s.c)}" title="移除">✕</button>` : ""}</td>
  </tr>`;
}

function renderWatch() {
  const list = watchList();
  const rows = list.map((code) => {
    const rt = quotes?.stocks?.[code];
    if (rt) return row(rt, { removable: true });
    const d = dailyMap.get(code);
    return d ? row(d, { removable: true, live: false }) : "";
  }).join("");
  $("#watch").innerHTML = HEAD + `<tbody>${rows || '<tr><td colspan="10" class="empty">尚未加入自選股</td></tr>'}</tbody>`;
}

function renderHot() {
  const rows = (quotes?.hot ?? []).map((c) => quotes.stocks[c]).filter(Boolean).map((s) => row(s)).join("");
  $("#hot").innerHTML = HEAD + `<tbody>${rows || '<tr><td colspan="10" class="empty">尚無資料</td></tr>'}</tbody>`;
}

function renderAll() {
  if (!daily) return;
  const q = $("#search").value.trim().toLowerCase();
  let list = daily.rows.filter((r) => (mktFilter === "all" || r.m === mktFilter) && r.v > 0);
  if (q) list = list.filter((r) => r.c.toLowerCase().includes(q) || r.n.toLowerCase().includes(q));
  const p = (r) => pct(r.p, r.ch);
  if (sortKey === "up") list.sort((a, b) => p(b) - p(a));
  else if (sortKey === "down") list.sort((a, b) => p(a) - p(b));
  else list.sort((a, b) => b.val - a.val);
  const shown = list.slice(0, 100);
  const head = HEAD.replace('<th class="hide-sm">時間</th>', '<th class="hide-sm">成交值</th>');
  $("#all").innerHTML = head + `<tbody>${shown.map((r) => row(r, { live: false, last: fmtVal(r.val) })).join("") || '<tr><td colspan="10" class="empty">找不到符合的股票</td></tr>'}</tbody>`;
  const dates = [...new Set(daily.rows.map((r) => r.d))].sort();
  const roc = (d) => `${+d.slice(0, 3) + 1911}/${d.slice(3, 5)}/${d.slice(5)}`;
  $("#all-note").textContent = `共 ${list.length} 檔，顯示前 ${shown.length} 檔。資料日期：${dates.map(roc).join("、")}`;
}

function fillDatalist() {
  $("#codes").innerHTML = daily.rows.map((r) => `<option value="${esc(r.c)} ${esc(r.n)}">`).join("");
}

// ---------- 載入 ----------
async function load() {
  $("#refresh").classList.add("spin");
  try {
    const [q, d, i] = await Promise.all([getJSON("quotes.json"), daily ? Promise.resolve(null) : getJSON("daily.json"), getJSON("intraday.json").catch(() => null)]);
    quotes = q; intra = i;
    if (d) { daily = d; dailyMap = new Map(d.rows.map((r) => [r.c, r])); fillDatalist(); }
    renderIndex("#idx-tse", quotes.indices?.tse, "tse");
    renderIndex("#idx-otc", quotes.indices?.otc, "otc");
    renderWatch(); renderHot(); renderAll();
    $("#updated").textContent = quotes.updated ? "資料更新 " + new Date(quotes.updated).toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  } catch (e) {
    $("#updated").textContent = "載入失敗：" + e.message;
  } finally {
    $("#refresh").classList.remove("spin");
    const [label, live] = marketStatus();
    $("#status").textContent = label;
    $("#status").classList.toggle("live", live);
  }
}

// ---------- 事件 ----------
$("#refresh").addEventListener("click", load);

$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#add-input").value.trim();
  if (!v || !daily) return;
  const key = v.split(/\s+/)[0];
  const hit = dailyMap.get(key) ?? daily.rows.find((r) => r.n === v || r.n.includes(v));
  if (!hit) { $("#add-input").setCustomValidity("找不到這檔股票"); $("#add-input").reportValidity(); return; }
  const list = watchList();
  if (!list.includes(hit.c)) { list.push(hit.c); saveWatch(list); }
  $("#add-input").value = "";
  renderWatch();
});
$("#add-input").addEventListener("input", (e) => e.target.setCustomValidity(""));

$("#watch").addEventListener("click", (e) => {
  const b = e.target.closest(".rm");
  if (!b) return;
  saveWatch(watchList().filter((c) => c !== b.dataset.code));
  renderWatch();
});

for (const [id, set] of [["#mkt", (v) => (mktFilter = v)], ["#sort", (v) => (sortKey = v)]]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    set(b.dataset.v);
    renderAll();
  });
}
$("#search").addEventListener("input", renderAll);

load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
