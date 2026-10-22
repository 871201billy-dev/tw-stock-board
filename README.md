# 台股盤

這是一個放在 GitHub Pages 上的台股看盤網頁，有以下功能：

- **加權指數 / 櫃買指數**：顯示最新點數、漲跌和盤中走勢圖
- **自選股**：預設清單在 `watchlist.json`；在網頁上新增或刪除的股票只存在你自己的瀏覽器
- **熱門成交**：前一交易日成交值前 40 名的即時報價
- **全市場收盤**：上市加上櫃，可依漲幅、跌幅、成交值排序或搜尋

## 運作方式

證交所的 API 不允許瀏覽器直接讀取（沒有 CORS），所以改用 GitHub Actions：

1. 平日台北時間 08:00–13:59 每 5 分鐘、收盤後再跑幾次，執行 `scripts/fetch.mjs`
2. 從證交所 mis 抓即時報價，從證交所 / 櫃買 OpenAPI 抓每日收盤行情，存成 `site/data/*.json`
3. 用 `actions/deploy-pages` 部署 `site/` 資料夾

網頁每 60 秒會重新讀一次資料。

## 注意事項

- GitHub 排程經常延遲 5–15 分鐘，所以報價**不是即時的**
- 公開 repo 如果 60 天沒有任何 commit，GitHub 會自動停用排程，到 Actions 頁面重新啟用即可
- 修改 `watchlist.json` 可以變更即時報價的預設自選股
- 本機測試：`node scripts/fetch.mjs`，再到 `site/` 執行 `npx serve` 或 `python -m http.server`

資料僅供參考，不構成投資建議。
