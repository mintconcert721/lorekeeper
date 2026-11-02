// 업그레이드: 예전 버전에서 저장한 데이터를 지금 버전이 그대로 읽는지(같은 주소·같은 브라우저 저장소)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const OLD = ["edb6748", "09d3ead", "5024a2f", "b5631af", "064109f", "21f2fbb", "4a99437", "024f46e", "8bc87ed", "20f5340", "b6ae94b", "d059fc7"];
const ONLY = process.argv[2] ? process.argv[2].split(",") : OLD;
let html = "";
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); }).listen(8790);

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
const textMsg = (t) => sse([
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
]);

(async () => {
  const browser = await chromium.launch();
  const summary = [];
  for (const c of ONLY) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
    await page.route("https://fonts.**", (r) => r.abort());
    await page.route("https://api.anthropic.com/**", (route) => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (route.request().url().includes("count_tokens")) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: '{"input_tokens":10}' });
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: textMsg("예전 답이에요.") });
    });
    const dump = () => page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open("lorekeeper", 1);
      r.onsuccess = () => { const out = {}; const st = r.result.transaction("kv").objectStore("kv"); const cur = st.openCursor(); cur.onsuccess = () => { const c = cur.result; if (!c) return res(out); out[c.key] = c.value; c.continue(); }; };
      r.onerror = () => res({ __error: String(r.error) });
    }));
    // 1) 예전 버전에서 데이터 만들기
    html = L.oldHtml(c);
    await page.goto("http://localhost:8790/");
    await page.waitForTimeout(400);
    await page.click('[data-act="load-sample"]');
    await page.waitForTimeout(600);
    // 대화 하나
    try {
      await page.click('.tabbar [data-view="settings"]');
      await page.fill("#apiKey", "sk-ant-test");
      await page.click('#keyForm button[type="submit"]');
      await page.click('.tabbar [data-view="chat"]');
      await page.fill("#input", "예전 버전에서 보낸 질문");
      await page.click("#sendBtn");
      await page.waitForFunction(() => document.querySelector("#sendBtn")?.textContent === "보내기" && document.querySelector("#chatLog")?.textContent.includes("예전 답"), null, { timeout: 8000 });
    } catch (e) { errors.push("old-chat: " + e.message.split("\n")[0]); }
    // 사용자 항목 하나(직접 편집)
    try {
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(300);
      await page.click('.tabbar [data-view="codex"]');
      await page.click('#codex [data-act="new-entry"]');
      await page.fill("#f-name", "업그레이드 확인용 인물");
      await page.fill("#f-summary", "예전 버전에서 만든 항목");
      await page.click('#entryForm button[type="submit"]');
      await page.waitForTimeout(400);
    } catch (e) { errors.push("old-entry: " + e.message.split("\n")[0]); }
    await page.waitForTimeout(300);
    const before = await dump();
    const wid = (before.worlds || [])[0]?.id;
    const nEntries = (before["entries:" + wid] || []).length;
    const nThreads = (before["threads:" + wid] || []).length;
    const oldErrors = errors.splice(0);
    // 2) 지금 버전으로 열기
    html = fs.readFileSync(L.INDEX, "utf8");
    await page.reload();
    await page.waitForTimeout(1200);
    const shown = await page.evaluate(() => ({ world: document.querySelector("#worldName")?.textContent, cards: document.querySelectorAll("#codex .entry-card").length, chat: document.querySelector("#chatLog")?.textContent || "" }));
    // 모든 화면 돌기
    const views = [];
    for (const v of ["chat", "codex", "graph", "timeline", "settings"]) { try { await page.click(`.tabbar [data-view="${v}"]`); await page.waitForTimeout(200); views.push(v); } catch (e) { errors.push(`view ${v}: ${e.message.split("\n")[0]}`); } }
    try {
      await page.click('.tabbar [data-view="graph"]');
      for (const m of ["tree", "matrix", "addr", "map", "graph"]) { await page.click(`#graphModes [data-gmode="${m}"]`); await page.waitForTimeout(150); }
      await page.click('.tabbar [data-view="codex"]');
      for (const t of ["ms", "senses", "questions", "naming", "foreshadow", "entries"]) { await page.click(`#codex [data-ctab="${t}"]`); await page.waitForTimeout(100); if (t === "ms") { for (const v of ["works", "all"]) { await page.click(`#codex [data-msview="${v}"]`); await page.waitForTimeout(100); } } }
      for (const a of ["economy", "tech"]) { await page.click(`#codex [data-act="${a}"]`); await page.waitForTimeout(120); await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); }
      await page.click('.tabbar [data-view="timeline"]');
      for (const m of ["life", "causal", "cal", "list"]) { await page.click(`#tlModes [data-tlmode="${m}"]`); await page.waitForTimeout(120); }
      await page.click('.tabbar [data-view="codex"]');
      const ids = await page.$$eval("#codex .entry-card", (els) => els.map((x) => x.dataset.ref));
      for (const id of ids) {
        await page.click(`#codex .entry-card[data-ref="${id}"]`);
        await page.waitForSelector("#sheetBody .entry-name", { timeout: 3000 });
        const tabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.dataset.etab));
        for (const t of tabs) { await page.click(`#sheetBody [data-etab="${t}"]`); await page.waitForTimeout(60); }
        await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
        await page.waitForTimeout(80);
      }
      await page.click('[data-act="checks"]');
      await page.waitForTimeout(150);
      await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
      await page.evaluate(() => document.activeElement?.blur());
      await page.click('.tabbar [data-view="chat"]');
      await page.fill("#input", "새 버전에서 이어서");
      await page.click("#sendBtn");
      await page.waitForFunction(() => document.querySelector("#sendBtn")?.textContent === "보내기", null, { timeout: 8000 });
    } catch (e) { errors.push("walk: " + e.message.split("\n")[0]); }
    await page.waitForTimeout(500);
    const after = await dump();
    const nEntries2 = (after["entries:" + wid] || []).length;
    const nThreads2 = (after["threads:" + wid] || []).length;
    const ok = shown.world && shown.world === before.worlds[0].name && shown.cards >= nEntries && nEntries2 === nEntries && nThreads2 >= nThreads && shown.chat.includes("예전") && !errors.length;
    summary.push({ c, ok, world: shown.world, entries: `${nEntries}→${nEntries2} (cards ${shown.cards})`, threads: `${nThreads}→${nThreads2}`, oldChat: shown.chat.includes("예전 답"), oldErrors: oldErrors.join(" | ").slice(0, 160), errors: errors.join(" | ").slice(0, 400) });
    await ctx.close();
  }
  await browser.close();
  server.close();
  for (const s of summary) console.log(`${s.ok ? "PASS" : "FAIL"} ${s.c} world=${s.world} entries=${s.entries} threads=${s.threads} oldChat=${s.oldChat}${s.oldErrors ? ` [old: ${s.oldErrors}]` : ""}${s.errors ? ` ERR: ${s.errors}` : ""}`);
  process.exit(summary.every((s) => s.ok) ? 0 : 1);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
