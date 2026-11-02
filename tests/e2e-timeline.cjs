// 연표 + 테마 E2E 테스트
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V4 = L.LEGACY(4);
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8769);

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function msg(id, blocks, stop) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}
const queue = [];
const requests = [];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    requests.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    const make = queue.shift() || (() => msg("x", [{ text: "네." }], "end_turn"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });

  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300); };
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lastUser = (r) => r.body.messages[r.body.messages.length - 1];
  const tab = (v) => page.click(`.tabbar [data-view="${v}"]`);

  await page.goto("http://localhost:8769/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");

  // ---- 테마 ----
  check("기본: 기기 설정(라이트)", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === null && (await bg()) === "rgb(238, 240, 236)");
  await page.click("#themeBtn");
  check("버튼 → 다크", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark" && (await bg()) === "rgb(17, 23, 25)");
  check("버튼 안내 문구", (await page.getAttribute("#themeBtn", "aria-label")) === "라이트 모드로 바꾸기");
  const metas = await page.$$eval('meta[name="theme-color"]', (ms) => ms.map((m) => `${m.getAttribute("content")}|${m.getAttribute("media")}`));
  check("주소창 색도 다크", metas.every((m) => m.startsWith("#111719|null")), metas.join(","));
  await page.goto("http://localhost:8769/", { waitUntil: "domcontentloaded" });
  check("새로 열어도 다크 유지(그리기 전 적용)", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  await page.waitForSelector("#app");
  await tab("settings");
  await page.click('input[name="theme"][value="system"]');
  check("설정: 기기 설정 따르기", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === null);
  await page.emulateMedia({ colorScheme: "dark" });
  check("기기 다크 → 다크", (await bg()) === "rgb(17, 23, 25)");
  await page.click('input[name="theme"][value="light"]');
  check("기기 다크여도 라이트 고정", (await bg()) === "rgb(238, 240, 236)");
  await page.click('input[name="theme"][value="system"]');
  await page.emulateMedia({ colorScheme: "light" });

  // ---- 달력 ----
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  await tab("timeline");
  await page.waitForSelector("#timeline .empty-state");
  check("빈 연표 안내", (await page.textContent("#timeline")).includes("아직 연표에 오른 항목이 없습니다"));
  await page.click('[data-tl="calendar"]');
  await page.fill("#c-prefix", "등대력");
  await page.fill("#c-now", "312");
  await page.click('[data-cal="add"]');
  await page.click('[data-cal="add"]');
  const eraRows = await page.$$(".era-row");
  await (await eraRows[0].$(".en")).fill("제1시대"); await (await eraRows[0].$(".es")).fill("0"); await (await eraRows[0].$(".ee")).fill("200");
  await (await eraRows[1].$(".en")).fill("등불 시대"); await (await eraRows[1].$(".es")).fill("200");
  check("표기 미리보기", (await page.textContent("#c-preview")).includes("등대력 312년"));
  await page.click('#calForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".tl-cal")?.textContent.includes("지금"), null, { timeout: 5000 }).catch(() => {});
  check("달력 저장", (await page.textContent(".tl-cal")).includes("지금 등대력 312년") && (await page.textContent(".tl-cal")).includes("시대 2개"));

  // ---- 시점 넣기 ----
  await tab("codex");
  await page.click('.entry-card[data-ref="C-001"]');
  await page.click('#sheetBody [data-act="edit"]');
  await page.fill("#f-ts", "295");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .when-line");
  check("상세에 시점 표시", (await page.textContent("#sheetBody .when-line")).includes("등대력 295년"));
  await page.click('#sheetBody [data-act="timeline"]');
  await page.waitForSelector("#tl-C-001.hl");
  check("연표에서 보기 → 강조", true);
  check("인물 나이 계산", (await page.textContent("#tl-C-001")).includes("지금 17살"));

  const addEvent = async (name, ts, te, focusCheck) => {
    await page.click('[data-tl="new"]');
    await page.waitForSelector("#entryForm");
    if (focusCheck) {
      await page.waitForTimeout(150);
      check("사건 추가: 분류 사건 + 시점 칸 포커스", (await page.$eval("#f-type", (s) => s.selectedOptions[0].textContent)) === "사건" && (await page.evaluate(() => document.activeElement?.id)) === "f-ts");
    }
    await page.fill("#f-name", name);
    await page.fill("#f-summary", `${name} 요약`);
    if (ts !== null) await page.fill("#f-ts", String(ts));
    if (te !== null) await page.fill("#f-te", String(te));
    await page.click('#entryForm button[type="submit"]');
    await page.waitForSelector("#sheetBody .entry-name");
    await closeSheet();
  };
  await addEvent("잿빛 첨탑 점등", 120, null, true);
  await addEvent("안개 전쟁", 150, 162, false);
  await addEvent("무등회 결성", null, null, false);
  // 잘못된 기간은 막는다
  await page.click('[data-tl="new"]');
  await page.waitForFunction(() => document.activeElement?.id === "f-ts");
  await page.fill("#f-name", "잘못된 기간");
  await page.fill("#f-ts", "300");
  await page.fill("#f-te", "250");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("앞설 수 없습니다"), null, { timeout: 5000 }).catch(() => {});
  check("끝이 시작보다 앞서면 저장 안 함", (await page.textContent("#toast")).includes("앞설 수 없습니다") && !!(await page.$("#entryForm")), JSON.stringify({ toast: await page.textContent("#toast"), form: !!(await page.$("#entryForm")), ts: await page.inputValue("#f-ts").catch(() => "-"), te: await page.inputValue("#f-te").catch(() => "-") }));
  await closeSheet();

  await tab("timeline");
  const order = await page.$$eval(".tl-row", (rows) => rows.map((r) => r.id.replace("tl-", "")));
  check("시간순 정렬", JSON.stringify(order) === JSON.stringify(["E-001", "E-002", "C-001"]), order.join(","));
  const flow = await page.$$eval(".tl > *", (els) => els.map((e) => e.className.split(" ")[0] + (e.querySelector("strong") ? ":" + e.querySelector("strong").textContent : "")));
  check("시대 머리글과 지금 표시 위치", JSON.stringify(flow) === JSON.stringify(["tl-era:제1시대", "tl-row", "tl-row", "tl-era:등불 시대", "tl-row", "tl-now"]), flow.join(" > "));
  check("기간 표시", (await page.textContent("#tl-E-002")).includes("등대력 150년 ~ 등대력 162년") && (await page.textContent("#tl-E-002")).includes("12년"));
  check("시점 없는 사건 모음", (await page.textContent(".tl-missing summary")).includes("1개"));
  await page.click('[data-tlt="character"]');
  check("분류 필터", (await page.$$eval(".tl-row", (r) => r.length)) === 2);
  await page.click('[data-tlt="character"]');
  await page.screenshot({ path: `${SHOTS}/40-timeline.png` });

  // ---- Claude와 연표(v5) ----
  await tab("chat");
  queue.push(() => msg("a1", [{ tool: "get_timeline", id: "g1", input: {} }], "tool_use"));
  queue.push(() => msg("a2", [
    { tool: "update_entry", id: "u1", input: { id: "E-003", time_start: 205, time_label: "205년 봄", reason: "결성 시점" } },
    { tool: "create_entry", id: "c1", input: { type: "사건", name: "첫 소등", summary: "처음으로 등대가 꺼진 날", time_start: 300, time_end: 301 } },
  ], "tool_use"));
  queue.push(() => msg("a3", [{ tool: "set_calendar", id: "s1", input: { eras: [{ name: "제1시대", start: 0, end: 200 }, { name: "등불 시대", start: 200, end: 300 }, { name: "소등 시대", start: 300 }] } }], "tool_use"));
  queue.push(() => msg("a4", [{ text: "무등회 결성(E-003)을 205년에 두고, 첫 소등(E-004)과 소등 시대를 추가했어요." }], "end_turn"));
  const base = requests.length;
  await send("연표를 정리해 줘", base + 4);
  const r1 = requests[base];
  const first = r1.body.messages[0].content[0].text;
  check("v5 지침·도구", r1.body.system[0].text.includes("## 연표") && r1.body.tools.some((t) => t.name === "get_timeline") && r1.body.tools.some((t) => t.name === "set_calendar"));
  check("첫 메시지에 달력", first.includes('달력: 연도는 "등대력 312년"처럼 표기 · 현재 연도: 등대력 312년') && first.includes("시대 구분: 제1시대(등대력 0년 ~ 등대력 200년), 등불 시대(등대력 200년 ~)"), first.split("\n").slice(0, 8).join(" / "));
  check("색인 줄에 시점", first.includes("C-001 인물 서리") && first.includes("· 등대력 295년"));
  const g = lastUser(requests[base + 1]).content[0].content;
  check("get_timeline 결과", g.includes("연표 3개(시간순)") && g.includes("- 등대력 150년 ~ 등대력 162년(12년) · E-002 사건 안개 전쟁") && g.includes("[제1시대]") && g.includes("시점이 없는 사건 1개: E-003 무등회 결성"), g);
  const res2 = lastUser(requests[base + 2]).content;
  check("update_entry로 시점 넣기", res2[0].content.includes("수정됨: E-003"));
  check("create_entry에 기간", res2[1].content.includes("연표 등대력 300년 ~ 등대력 301년"), res2[1].content);
  const res3 = lastUser(requests[base + 3]).content[0].content;
  check("set_calendar", res3.includes("소등 시대(등대력 300년 ~)"), res3);
  await tab("timeline");
  const flow2 = await page.$$eval(".tl > *", (els) => els.map((e) => e.id ? e.id.replace("tl-", "") : e.className.split(" ")[0] + (e.querySelector("strong") ? ":" + e.querySelector("strong").textContent : "")));
  check("Claude 변경이 연표에 반영", JSON.stringify(flow2) === JSON.stringify(["tl-era:제1시대", "E-001", "E-002", "tl-era:등불 시대", "E-003", "C-001", "tl-era:소등 시대", "E-004", "tl-now"]), flow2.join(" > "));
  check("표기 문구 우선", (await page.textContent("#tl-E-003")).includes("205년 봄"));

  // 달력 변경 알림(v5 대화)
  await page.click('[data-tl="calendar"]');
  await page.fill("#c-now", "313");
  await page.click('#calForm button[type="submit"]');
  await tab("chat");
  const b2 = requests.length;
  await send("지금 서리는 몇 살이야?", b2 + 1);
  const note = lastUser(requests[b2]).content.find((c) => c.type === "text" && c.text.startsWith("[앱 알림")).text;
  check("달력 변경 알림", note.includes("달력·시대 변경") && note.includes("현재 연도: 등대력 313년"), note);

  // ---- v4 대화는 그대로 ----
  const worldId = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  await page.evaluate(async (wid) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = (k) => new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); });
    const threads = (await get("threads:" + wid)) || [];
    const now = Date.now() - 60000;
    threads.push({ id: "v4t", title: "v4 대화", createdAt: now, updatedAt: now, contextSent: true, syncedAt: Date.now() - 1000, lastCtx: 0, promptVersion: 4 });
    await new Promise((res) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(threads, "threads:" + wid);
      tx.objectStore("kv").put({ api: [{ role: "user", content: [{ type: "text", text: "예전 v4 질문" }] }, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig_v4" }, { type: "text", text: "예전 답" }] }], display: [{ role: "user", text: "예전 v4 질문", at: 1 }, { role: "assistant", parts: [{ kind: "text", text: "예전 답" }], at: 2 }] }, "conv:v4t");
      tx.oncomplete = res;
    });
  }, worldId);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("chat");
  await page.click("#threadsBtn");
  await page.click('[data-thread="v4t"]');
  const b3 = requests.length;
  await send("이어서", b3 + 1);
  const r4 = requests[b3];
  check("v4 대화는 v4 지침·도구 그대로", r4.body.system[0].text === V4.system && JSON.stringify(r4.body.tools) === JSON.stringify(V4.tools));

  // ---- 문서 내보내기 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-md"]')]);
  const mdText = fs.readFileSync(await dl.path(), "utf8");
  check("문서에 연표", mdText.includes("## 연표") && mdText.includes("- **등대력 120년** 잿빛 첨탑 점등") && mdText.includes("시대: **소등 시대**"));

  // ---- 다크 모드 연표 화면 ----
  await page.click("#themeBtn");
  await tab("timeline");
  await page.screenshot({ path: `${SHOTS}/41-timeline-dark.png` });
  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("탭 5개가 화면 안", await page.evaluate(() => [...document.querySelectorAll(".tabbar button")].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
