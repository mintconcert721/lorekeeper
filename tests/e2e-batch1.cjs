// 1차: 선택지 설명 버그, 확정·초안·폐기, 설정 점검
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V5 = L.PROMPT_SET(5);
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8771);

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function msg(id, blocks, stop) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.thinking !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig" + i } });
    } else if (b.text !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } });
      for (const part of JSON.stringify(b.input).match(/[\s\S]{1,9}/g)) ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: part } });
    }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}
const queue = [];
const requests = [];
const LONG = "## 세 가지 길\n\n**A안 · 등대를 지킨다**\n서리가 어머니의 기억을 바치고 불을 지킵니다. 장점: 서쪽 섬이 고립되지 않습니다. 단점: 서리는 어머니의 얼굴을 영영 잊습니다.\n\n**B안 · 무등회에 합류한다**\n등대를 끄고 안개 속 기억을 찾으러 갑니다. 이야기 중반의 큰 반전이 됩니다.\n\n**C안 · 거짓 등명부**\n등명부를 계속 고쳐 버티다 결국 들킵니다.";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
    requests.push({ body: JSON.parse(req.postData()) });
    const make = queue.shift() || (() => msg("x", [{ text: "네." }], "end_turn"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300); };
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const tab = (v) => page.click(`.tabbar [data-view="${v}"]`);
  const lastAssistantText = () => page.evaluate(() => { const els = document.querySelectorAll("#chatLog .msg-assistant"); const el = els[els.length - 1]; return { body: [...el.querySelectorAll(":scope > .md")].map((x) => x.textContent).join("\n"), thinking: [...el.querySelectorAll("details.thinking")].map((x) => x.textContent).join("\n") }; });

  await page.goto("http://localhost:8771/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 버그: 선택지 설명이 본문에 다 보여야 한다(v6 respond) ----
  await tab("chat");
  queue.push(() => msg("r1", [{ thinking: "세 가지 길을 정리하자" }, { tool: "respond", id: "rs1", input: { message: LONG, options: ["A안으로 할게", "B안이 좋아", "C안으로"] } }], "tool_use"));
  await send("서리의 다음 선택지를 줘", 1);
  const t1 = await lastAssistantText();
  check("선택지 설명 전체가 본문에 보임", t1.body.includes("어머니의 얼굴을 영영 잊습니다") && t1.body.includes("이야기 중반의 큰 반전") && t1.body.includes("결국 들킵니다"), t1.body.slice(0, 80));
  check("본문이 생각 요약에 숨지 않음", !t1.thinking.includes("A안"));
  check("추천 대답 버튼", (await page.$$eval("#quickReplies .qr", (e) => e.length)) === 3);
  const r1 = requests[0].body;
  check("v6: respond·상태 지침", r1.system[0].text.includes("## 답하는 방법") && r1.system[0].text.includes("## 확정과 초안") && r1.tools.some((t) => t.name === "respond"));
  await page.screenshot({ path: `${SHOTS}/60-respond.png` });
  // 다음 메시지 맨 앞에 respond 결과
  await page.click('#quickReplies [data-qr="0"]');
  await until(() => requests.length >= 2); await waitIdle();
  const u2 = requests[1].body.messages[requests[1].body.messages.length - 1].content;
  check("respond 결과가 다음 메시지 맨 앞", u2[0].type === "tool_result" && u2[0].tool_use_id === "rs1" && u2[0].content.includes("골랐다"));
  const asst = requests[1].body.messages[requests[1].body.messages.length - 2];
  check("respond 입력은 기록에 그대로", asst.content.some((b) => b.type === "tool_use" && b.name === "respond" && b.input.message === LONG));

  // ---- 2. 예전 대화(v5): 대답 추천 앞의 요약 메모를 본문으로 ----
  const wid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  await page.evaluate(async (w) => {
    const db = await new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => res(r.result); });
    const get = (k) => new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); });
    const threads = (await get("threads:" + w)) || [];
    threads.push({ id: "old5", title: "v5 대화", createdAt: Date.now() - 1e5, updatedAt: Date.now() - 1e5, contextSent: true, syncedAt: Date.now(), lastCtx: 0, promptVersion: 5 });
    await new Promise((res) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(threads, "threads:" + w); tx.objectStore("kv").put({ api: [{ role: "user", content: [{ type: "text", text: "예전 질문" }] }, { role: "assistant", content: [{ type: "text", text: "예전 답" }] }], display: [] }, "conv:old5"); tx.oncomplete = res; });
  }, wid);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  await page.click("#threadsBtn");
  await page.click('[data-thread="old5"]');
  queue.push(() => msg("o1", [{ thinking: "**A안 · 등대를 지킨다**: 불을 지키는 대신 기억을 잃는다. **B안**: 무등회 합류." }, { tool: "suggest_replies", id: "sg1", input: { options: ["A안", "B안"] } }], "tool_use"));
  queue.push(() => msg("o2", [{ text: "**A안 · 등대를 지킨다**\n서리가 어머니의 기억을 바치고 불을 지킵니다. 서쪽 섬이 고립되지 않습니다.\n\n**B안 · 무등회에 합류한다**\n등대를 끄고 안개 속 기억을 찾으러 갑니다." }], "end_turn"));
  await send("선택지 줘", 4);
  const t2 = await lastAssistantText();
  check("v5 대화: 요약 대신 본문 전체를 다시 받아 보임", t2.body.includes("어머니의 기억을 바치고") && t2.body.includes("안개 속 기억을 찾으러") && t2.thinking.includes("불을 지키는"), JSON.stringify(t2).slice(0, 160));
  check("v5 대화는 v5 지침·도구 그대로", requests[2].body.system[0].text === V5.system && JSON.stringify(requests[2].body.tools) === JSON.stringify(V5.tools));

  // ---- 3. 확정·초안·폐기 ----
  await tab("codex");
  await page.click('[data-act="new-entry"]');
  await page.selectOption("#f-type", "character");
  await page.fill("#f-name", "안개 속 아이");
  await page.fill("#f-summary", "아직 정하지 않은 인물");
  await page.click('.seg input[value="draft"] + span');
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .st-actions");
  check("초안 저장 + 상세 안내", (await page.textContent("#sheetBody .entry-head")).includes("초안") && (await page.textContent("#sheetBody .st-actions")).includes("확정으로"));
  const draftId = await page.textContent("#sheetBody .catno");
  await closeSheet();
  check("설정집 카드에 초안 표시", (await page.textContent(`.entry-card[data-ref="${draftId}"]`)).includes("초안"));
  await page.screenshot({ path: `${SHOTS}/61-status.png` });
  await page.click(`.entry-card[data-ref="${draftId}"]`);
  await page.click('#sheetBody [data-act="st-discarded"]');
  await page.waitForSelector('#sheetBody [data-act="st-draft"]');
  check("폐기로 바꾸기", (await page.textContent("#sheetBody .entry-head")).includes("폐기"));
  await closeSheet();
  check("폐기는 기본으로 숨김", !(await page.$(`.entry-card[data-ref="${draftId}"]`)));
  await page.click('[data-status="discarded"]');
  check("폐기 보기 켜면 보임(취소선)", !!(await page.$(`.entry-card.discarded[data-ref="${draftId}"]`)));
  await page.click('[data-status="discarded"]');
  await tab("graph");
  await page.waitForSelector("#gNodes .g-node");
  check("관계도에서 폐기 항목 빠짐", !(await page.$(`#gNodes .g-node[data-id="${draftId}"]`)));
  // Claude가 초안으로 만들기 + 폐기 제외 목록
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("c1", [{ tool: "create_entry", id: "ce1", input: { type: "인물", name: "후보 인물", summary: "제안만 한 인물", status: "초안" } }, { tool: "search_entries", id: "se1", input: { query: "안개 속 아이" } }, { tool: "search_entries", id: "se2", input: { query: "안개 속 아이", include_discarded: true } }, { tool: "update_entry", id: "ue1", input: { id: "C-001", status: "보류" } }], "tool_use"));
  queue.push(() => msg("c2", [{ tool: "respond", id: "rs2", input: { message: "후보 인물을 초안으로 적어 두었어요." } }], "tool_use"));
  const base = requests.length;
  await send("후보 인물 하나 적어 둬", base + 2);
  const first = requests[base].body.messages[0].content[0].text;
  check("첫 메시지: 폐기 빼고 개수 안내", !first.includes("안개 속 아이") && first.includes("폐기된 항목 1개는 뺐다"), first.split("\n").filter((l) => l.includes("항목")).join(" / "));
  const tr = requests[base + 1].body.messages[requests[base + 1].body.messages.length - 1].content;
  check("Claude가 초안으로 생성", tr[0].content.includes("초안"));
  check("검색은 폐기 제외", tr[1].content.includes("일치하는 항목이 없습니다"));
  check("include_discarded로 폐기 검색", tr[2].content.includes("[폐기]") && tr[2].content.includes("안개 속 아이"));
  check("잘못된 상태 값 거절", tr[3].is_error === true);

  // ---- 4. 설정 점검 ----
  // 서리 295년생, 100~120년 전쟁과 연결 → 연표 확인 / 폐기 항목과 연결 / 이름 겹침
  await tab("codex");
  await page.click('.entry-card[data-ref="C-001"]');
  await page.click('#sheetBody [data-act="edit"]');
  await page.fill("#f-ts", "295");
  await page.fill("#f-aliases", "잿빛 첨탑 등대");
  await page.click('[data-add="rel"]');
  await page.fill("#f-rels .kv-row:last-child .rl", "꿈에서 본");
  await page.selectOption("#f-rels .kv-row:last-child .rt", draftId);
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  await closeSheet();
  await page.click('[data-act="new-entry"]');
  await page.selectOption("#f-type", "event");
  await page.fill("#f-name", "옛 전쟁");
  await page.fill("#f-summary", "서리가 태어나기 훨씬 전의 전쟁");
  await page.fill("#f-ts", "100"); await page.fill("#f-te", "120");
  await page.click('[data-add="rel"]');
  await page.fill("#f-rels .kv-row:last-child .rl", "참전자");
  await page.selectOption("#f-rels .kv-row:last-child .rt", "C-001");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  await closeSheet();
  await page.click('[data-act="checks"]');
  await page.waitForSelector(".check-group");
  const groups = await page.$$eval(".check-group h3", (hs) => hs.map((h) => h.textContent.trim()));
  check("점검: 경고가 먼저", groups[0].startsWith("연표 확인") || groups[0].startsWith("버린 항목") || groups[0].startsWith("이름 겹침"), groups.join(" | "));
  const txt = await page.textContent("#sheetBody");
  check("점검: 연표 모순", txt.includes("서리은(는) 등대력 295년") || txt.includes("295년에 태어났는데"), txt.slice(0, 200));
  check("점검: 폐기 항목과 연결", txt.includes("꿈에서 본") && txt.includes("(폐기)"));
  check("점검: 이름 겹침", txt.includes("'잿빛 첨탑 등대'을(를)"));
  check("점검: 채울 곳(관계 없음·초안)", txt.includes("관계 없는 항목") && txt.includes("확정을 기다리는 초안"));
  await page.screenshot({ path: `${SHOTS}/62-checks.png` });
  await page.click('[data-act="deep-check"]');
  const inp = await page.inputValue("#input");
  check("심층 점검 요청 채우기", inp.includes("설정 전체를 점검해 줘") && inp.includes("앱이 먼저 찾은 것") && inp.includes("꿈에서 본"));
  check("새 대화에서 시작", (await page.textContent("#threadTitle")) === "");

  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
