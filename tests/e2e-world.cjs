// 세계관 짜임새 1차: 연도 단면(연표 단추·해 누르기·앞뒤·바뀐 것·Claude 연대기), 파급 보기(방금 고친 알림·바뀐 것·확인 필요·판 고르기·Claude 판정),
// 영역별 빈 곳 지도(영역·신호·질문으로 이어 가기)
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const L = require("./lib.cjs");
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const seed = require(path.join(L.TESTS, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8793);

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function msg(id, blocks, stop) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } });
    for (const part of JSON.stringify(b.input).match(/[\s\S]{1,9}/g)) ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: part } });
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}
const queue = [];
const quick = [];
const requests = [];
const quickReqs = [];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message + " @ " + (e.stack || "").split("\n").slice(1, 3).join(" ")));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().includes("count_tokens")) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ input_tokens: 1000 }) });
    const body = JSON.parse(req.postData());
    if (!body.stream) {
      quickReqs.push({ body });
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ id: "q", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: quick.shift() || "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } }) });
    }
    requests.push({ body });
    const make = queue.shift() || (() => msg("x", [{ tool: "respond", id: "rsx", input: { message: "네." } }], "tool_use"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { if (text !== null) await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(250); };
  const closeSheet = async () => { if (await page.isVisible("#sheet")) { await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); } };
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await closeSheet(); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const sheetText = () => page.textContent("#sheetBody");
  const after = (t, k) => (t.lastIndexOf(k) >= 0 ? t.slice(t.lastIndexOf(k)) : "");
  const openE = async (id) => { await tab("codex"); if (await page.$('#codex [data-ctab="entries"][aria-selected="false"]')) await page.click('#codex [data-ctab="entries"]'); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); };

  await page.goto("http://localhost:8793/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  const wid0 = await wid();
  const ents = await idbGet("entries:" + wid0);
  const now = Date.now();
  const mk = (o) => ({ aliases: [], fields: {}, body: "", tags: [], relations: [], status: "canon", createdAt: now, updatedAt: now, updatedBy: "user", history: [], ...o });
  ents.push(
    mk({ id: "P-002", type: "place", name: "바람꼬리 항구", summary: "등대 아래 항구", relations: [{ to: "F-003", label: "통치", since: 300 }] }),
    mk({ id: "I-001", type: "item", name: "하람의 등불", summary: "하람이 쓰던 등불", artifact: { owners: [{ who: "C-010", from: 310, to: 318, how: "물려받음" }, { who: "C-001", from: 318, to: null, how: "유품" }] } }),
  );
  ents.find((e) => e.id === "C-010").relations.push({ to: "E-002", label: "참전" });
  ents.find((e) => e.id === "F-002").relations = [{ to: "F-001", label: "숙적", since: 310, until: 322 }, { to: "F-003", label: "동맹" }];
  ents.find((e) => e.id === "C-001").body = "어머니 하람에게서 등불을 물려받았다.";
  await idbSet("entries:" + wid0, ents);
  const now2 = Date.now();
  await idbSet("ms:" + wid0, [{ id: "ms-h1", title: "하람의 편지", kind: "장면", body: "하람은 딸에게 편지를 썼다.", refs: ["C-010"], createdAt: now2, updatedAt: now2, by: "user" }]);
  await page.reload();
  await page.waitForSelector("#app");
  await page.evaluate(() => { localStorage.setItem("lk.tlmode", JSON.stringify("list")); });
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 연도 단면 ----
  await tab("timeline");
  await page.click('#timeline [data-tl="slice"]');
  await page.waitForSelector("#sl-year");
  let t = await sheetText();
  check("기본은 지금(320년)", (await page.inputValue("#sl-year")) === "320");
  check("살아 있는 인물: 서리 15세, 죽은 하람·노을은 없음", t.includes("서리") && t.includes("15세") && !/하람[^의]/.test(after(t, "살아 있는 인물").split("세력과")[0]) && !after(t, "살아 있는 인물").includes("노을"), t.slice(0, 400));
    check("진행 중인 사건: 안개 전쟁", after(t, "진행 중인 사건").includes("안개 전쟁"));
  check("세력 관계: 그해 유효한 것", t.includes("숙적") && t.includes("동맹"));
  check("다스리는 곳: 항구 ← 해안 공화국", t.includes("다스리는 곳") && t.includes("바람꼬리 항구") && t.includes("해안 공화국 · 통치"));
  check("유물을 가진 이: 하람의 등불 → 서리", (t.split("유물을 가진 이")[1] || "").includes("하람의 등불") && (t.split("유물을 가진 이")[1] || "").includes("서리"));
  await page.screenshot({ path: path.join(SHOTS, "190-slice.png") });
  await page.fill("#sl-year", "318");
  await page.dispatchEvent("#sl-year", "change");
  await page.waitForTimeout(200);
  t = await sheetText();
  const ch = t.split("이 해에 바뀐 것")[1] || "";
  check("318년: 하람 죽음·안개 전쟁 시작·주인 바뀜", ch.includes("죽음") && ch.includes("하람") && ch.includes("사건 시작") && ch.includes("안개 전쟁") && ch.includes("주인 바뀜"), ch.slice(0, 300));
  await page.click('[data-sl="next"]');
  await page.waitForTimeout(150);
  check("다음 해", (await page.inputValue("#sl-year")) === "319");
  await page.click('[data-sl="now"]');
  await page.waitForTimeout(150);
  check("지금으로", (await page.inputValue("#sl-year")) === "320");
  quick.push("320년, 안개 전쟁은 세 해째였다.\n\n등대는 아직 꺼지지 않았다.");
  await page.click('[data-sl="story"]');
  await page.waitForSelector("#sl-story .md");
  check("Claude 연대기: 그해 사실을 보냄", quickReqs.at(-1).body.messages[0].content.includes("의 세계") && quickReqs.at(-1).body.messages[0].content.includes("진행 중인 사건") && (await page.textContent("#sl-story")).includes("세 해째"));
  await page.click('[data-sl="save"]');
  await page.waitForTimeout(250);
  check("연대기를 원고함에 저장", ((await idbGet("ms:" + wid0)) || []).some((m) => m.title.includes("320") && m.title.includes("연대기") && m.kind === "문서"));
  await closeSheet();
  await page.click('#timeline .tl-yr[data-slice="312"]');
  await page.waitForSelector("#sl-year");
  check("연표에서 해를 누르면 그해 단면", (await page.inputValue("#sl-year")) === "312" && (await sheetText()).includes("대등화"));
  await closeSheet();

  // ---- 2. 파급 보기 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("u1", [{ tool: "update_entry", id: "uu", input: { id: "C-010", name: "하람달", time_end: 300 } }], "tool_use"));
  queue.push(() => msg("u2", [{ tool: "respond", id: "rr", input: { message: "고쳤어요." } }], "tool_use"));
  await send("하람 이름과 죽은 해를 바꿔 줘", 2);
  const e10 = (await idbGet("entries:" + wid0)).find((e) => e.id === "C-010");
  check("고침 반영", e10.name === "하람달" && e10.when.end === 300);
  await openE("C-010");
  const note = await page.textContent("#sheetBody .impact-note").catch(() => "");
  check("방금 고친 알림: 바뀐 칸·영향 수·확인 필요", note.includes("이름") && note.includes("시점") && note.includes("영향을 줄 수 있는 곳") && note.includes("확인 필요"), note);
  await page.click('#sheetBody .impact-note [data-act="impact"]');
  await page.waitForSelector("#im-ver");
  t = await sheetText();
  check("바뀐 것: 이름·시점 전후", t.includes("하람") && t.includes("하람달") && t.includes("시점"));
  const warnPart = t.split("확인이 필요한 곳")[1]?.split("이어진 곳")[0] || "";
  check("확인 필요: 죽은 뒤 사건(안개 전쟁)", warnPart.includes("안개 전쟁") && warnPart.includes("뒤에 일어남"), warnPart.slice(0, 400));
  check("확인 필요: 옛 이름이 남은 항목(서리 본문)", warnPart.includes("서리") && warnPart.includes("옛 이름 '하람'"));
  check("확인 필요: 장면 본문의 옛 이름", warnPart.includes("하람의 편지"));
  check("확인 필요: 유물 소유 이력", warnPart.includes("하람의 등불"));
  check("이어진 곳: 관계(남편)", (t.split("이어진 곳")[1] || "").includes("도윤"));
  await page.screenshot({ path: path.join(SHOTS, "191-impact.png") });
  quick.push(JSON.stringify({ summary: "죽은 해가 당겨져 두 곳이 어긋납니다.", issues: [{ ref: "E-002", problem: "하람달이 죽은 뒤 참전한 것으로 남아 있다", suggestion: "참전 관계를 지우거나 죽은 해를 되돌린다" }] }));
  await page.click('[data-act="im-ai"]');
  await page.waitForSelector("#im-ai .check-issue");
  const qa = quickReqs.at(-1).body;
  check("Claude 판정: 강한 모델·바뀐 것·이어진 항목", qa.model === "claude-opus-5-5" && qa.messages[0].content.includes("시점:") && qa.messages[0].content.includes("안개 전쟁") && qa.messages[0].content.includes("하람의 편지"));
  check("판정 결과 표시", (await page.textContent("#im-ai")).includes("참전한 것으로"));
  await page.click("#im-ai [data-im-fix]");
  await page.waitForTimeout(250);
  check("Claude와 고치기: 새 대화에 바뀐 것과 문제", (await page.inputValue("#input")).includes("파급 점검") && (await page.inputValue("#input")).includes("참전한 것으로"));
  // 판 고르기: 고친 직후(같은 판)와 비교하면 바뀐 것 없음
  await openE("C-010");
  await page.click('#sheetBody .sheet-actions [data-act="impact"]');
  await page.waitForSelector("#im-ver");
  check("판 목록", (await page.$$("#im-ver option")).length >= 1);
  await closeSheet();

  // ---- 3. 빈 곳 지도 ----
  await tab("codex");
  await page.click('#codex [data-ctab="entries"]');
  await page.click('#codex [data-act="coverage"]');
  await page.waitForSelector(".cov-grid");
  const tiles = await page.$$eval(".cov-tile", (els) => els.map((e) => [e.querySelector("b").textContent, Number(e.querySelector(".cov-pct").textContent.replace("%", ""))]));
  check("영역 11개, 낮은 순", tiles.length === 11 && tiles.every((x, i) => i === 0 || tiles[i - 1][1] <= x[1]), JSON.stringify(tiles));
  check("인물·정치 영역은 0보다 큼", tiles.find((x) => x[0] === "인물")[1] > 0 && tiles.find((x) => x[0] === "정치·세력")[1] > 0);
  t = await sheetText();
  check("신호와 질문", t.includes("장소 항목") && t.includes("질문 카드(") && t.includes("이 영역 질문 받기"));
  await page.screenshot({ path: path.join(SHOTS, "192-coverage.png") });
  await page.click(".cov-tile:first-child details summary");
  const qb = await page.$(".cov-tile:first-child [data-cov-q]");
  if (qb) {
    await qb.click();
    await page.waitForTimeout(250);
    check("질문 카드 → 대화 입력", (await page.inputValue("#input")).startsWith("질문 카드:"));
  } else check("질문 카드 → 대화 입력", true, "첫 영역에 남은 질문 없음");
  await tab("codex");
  await page.click('#codex [data-act="coverage"]');
  await page.waitForSelector(".cov-grid");
  const firstName = tiles[0][0];
  await page.click(".cov-tile:first-child [data-cov-ask]");
  await page.waitForTimeout(250);
  check("이 영역 질문 받기 → 새 대화", (await page.inputValue("#input")).includes(`'${firstName}' 영역`));

  // ---- 4. 화면 폭 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await tab("timeline");
  await page.click('#timeline [data-tl="slice"]');
  await page.waitForSelector("#sl-year");
  check("360px: 단면 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1 && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await closeSheet();
  check("360px: 연표 머리 넘침 없음", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await tab("codex");
  await page.click('#codex [data-act="coverage"]');
  await page.waitForSelector(".cov-grid");
  check("360px: 빈 곳 지도 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1);

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
