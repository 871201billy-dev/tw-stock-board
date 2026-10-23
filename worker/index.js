// Cloudflare Worker：轉發證交所即時報價（mis.twse.com.tw 不允許瀏覽器跨網域讀取）
// GET /?ex_ch=tse_t00.tw|tse_2330.tw|otc_6488.tw

const ALLOWED_ORIGINS = [
  "https://871201billy-dev.github.io",
  "http://localhost:8765",
];
const CHANNEL = /^(tse|otc)_[0-9A-Za-z]{2,8}\.tw$/;
const MAX_CHANNELS = 120;
const CACHE_SECONDS = 3;
const STALE_SECONDS = 120;
const MAX_TRIES = 8;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

const reply = (body, status, origin, extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin), ...extra } });

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") ?? "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return reply('{"error":"method"}', 405, origin);

    const url = new URL(request.url);
    const chans = [...new Set((url.searchParams.get("ex_ch") ?? "").split("|").filter(Boolean))];
    if (!chans.length || chans.length > MAX_CHANNELS || !chans.every((c) => CHANNEL.test(c)))
      return reply('{"error":"bad ex_ch"}', 400, origin);
    chans.sort();

    // 同樣的查詢 3 秒內共用快取，避免多人同時開網頁時打爆證交所
    const cacheKey = new Request(`https://cache.local/?ex_ch=${chans.join("|")}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return reply(hit.body, 200, origin, { "X-Cache": "HIT" });

    // 從 Workers 連證交所約一半會回 520（很快就失敗），所以多重試幾次；都失敗就回傳最近一次成功的資料
    const staleKey = new Request(`https://cache.local/stale?ex_ch=${chans.join("|")}`);
    let text = null, status = 0;
    for (let i = 0; i < MAX_TRIES && text == null; i++) {
      if (i) await new Promise((r) => setTimeout(r, 50));
      try {
        const res = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chans.join("|"))}&json=1&delay=0&_=${Date.now()}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
            Referer: "https://mis.twse.com.tw/stock/index.jsp",
            Accept: "application/json",
          },
        });
        status = res.status;
        const body = (await res.text()).trim();
        if (res.ok && body.startsWith("{")) text = body;
      } catch {}
    }
    if (text == null) {
      const stale = await cache.match(staleKey);
      if (stale) return reply(stale.body, 200, origin, { "X-Cache": "STALE" });
      return reply(JSON.stringify({ error: "upstream", status }), 502, origin);
    }

    ctx.waitUntil(Promise.all([
      cache.put(cacheKey, new Response(text, { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } })),
      cache.put(staleKey, new Response(text, { headers: { "Cache-Control": `max-age=${STALE_SECONDS}` } })),
    ]));
    return reply(text, 200, origin, { "X-Cache": "MISS" });
  },
};
