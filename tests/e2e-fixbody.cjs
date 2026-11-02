// 답 본문이 '생각 요약' 속에 묻히는 문제(도구 호출 앞에 쓴 글) + 입력창 안내 문구
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8780);

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
const FULL = "## 세 가지 방향\n\n**① 등불을 따라가는 여행**\n창가에 등불을 켠 집을 찾아다니며 흩어진 루미엘 사람들을 만나요. 따뜻한 만남이 중심이에요.\n\n**② 가르논 구출**\n끌려간 가족을 구하러 가는 긴박한 여정이에요.\n\n**③ 둘을 잇기**\n처음엔 ①로 시작해 중반부터 ②로 바뀌어요.";
const SUMMARY = "세 가지 여행 방향을 정리해 사용자에게 설명했다";

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
    const make = queue.shift() || (() => msg("x", [{ tool: "respond", id: "rsx", input: { message: "네." } }], "tool_use"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(250); };
  const lastAssistant = () => page.evaluate(() => { const els = document.querySelectorAll("#chatLog .msg-assistant"); const el = els[els.length - 1]; return { body: [...el.querySelectorAll(":scope > .md")].map((x) => x.textContent).join("\n"), thinking: el.querySelectorAll("details.thinking").length }; });
  const lastUser = (r) => r.body.messages[r.body.messages.length - 1];
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);

  await page.goto("http://localhost:8780/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await page.click('.tabbar [data-view="settings"]');
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  await page.click('.tabbar [data-view="chat"]');

  // ---- 입력창 안내 ----
  check("기본 안내 문구", (await page.getAttribute("#input", "placeholder")) === "이야기해 보세요");
  check("빈 입력창은 한 줄", (await page.$eval("#input", (t) => t.offsetHeight)) <= 46);

  // ---- 1. 사진 속 상황: 생각 블록 두 개 + 빈 message → 같은 차례에 다시 받음 ----
  queue.push(() => msg("a1", [{ thinking: "방향을 세 가지로 나눠 보자" }, { thinking: SUMMARY }, { tool: "respond", id: "rs1", input: { message: "", options: ["①로 할게", "②가 좋아", "③으로"] } }], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rs2", input: { message: FULL, options: ["①로 할게", "②가 좋아", "③으로"] } }], "tool_use"));
  await send("여행의 목적을 정해 줘", 2);
  check("본문이 묻히면 한 번 더 요청", requests.length === 2);
  const tr = lastUser(requests[1]).content;
  check("다시 쓰라는 도구 결과(오류)", tr.length === 1 && tr[0].tool_use_id === "rs1" && tr[0].is_error === true && tr[0].content.includes("message에 다시 써서"), JSON.stringify(tr).slice(0, 200));
  check("대화 기록은 덧붙이기만", JSON.stringify(requests[1].body.messages.slice(0, requests[0].body.messages.length)) === JSON.stringify(requests[0].body.messages));
  let la = await lastAssistant();
  check("본문 전체가 보임", la.body.includes("① 등불을 따라가는 여행") && la.body.includes("가르논 구출") && la.body.includes("③ 둘을 잇기"), la.body.slice(0, 120));
  check("선택지 버튼도 보임", (await page.$$("#chatLog .qr")).length >= 3);
  check("요약은 생각 요약으로 접힘", la.thinking === 2 && !la.body.includes(SUMMARY));
  check("입력 안내: 버튼 있을 때", (await page.getAttribute("#input", "placeholder")) === "직접 써도 돼요");
  await page.screenshot({ path: `${SHOTS}/95-fixbody.png` });
  // 다음 메시지: 두 번째 respond의 결과가 함께 간다
  queue.push(() => msg("a3", [{ thinking: "①을 골랐다" }, { tool: "respond", id: "rs3", input: { message: "①로 정했어요. 등불을 켠 집들을 이어 볼게요." } }], "tool_use"));
  const b2 = requests.length;
  await page.click('#chatLog .qr:has-text("①로 할게")');
  await until(() => requests.length >= b2 + 1);
  await waitIdle();
  const nu = lastUser(requests[b2]).content;
  check("다음 메시지에 respond 결과(정상)", nu[0].type === "tool_result" && nu[0].tool_use_id === "rs2" && !nu[0].is_error);
  check("짧은 답(생각 하나)은 다시 요청하지 않음", requests.length === b2 + 1);

  // ---- 2. 짧은 message + 진행 메모 → 다시 받음 ----
  queue.push(() => msg("b1", [{ thinking: "정리" }, { thinking: SUMMARY }, { tool: "respond", id: "rb1", input: { message: "어떤 방향이 좋을까요?", options: ["①", "②"] } }], "tool_use"));
  queue.push(() => msg("b2", [{ tool: "respond", id: "rb2", input: { message: FULL + "\n\n어떤 방향이 좋을까요?", options: ["①", "②"] } }], "tool_use"));
  const b3 = requests.length;
  await send("다시 정리해 줘", b3 + 2);
  la = await lastAssistant();
  check("짧은 message도 다시 받음", requests.length === b3 + 2 && la.body.includes("가르논 구출") && la.body.includes("어떤 방향이 좋을까요?") && la.body.split("어떤 방향이 좋을까요?").length === 2);

  // ---- 3. 긴 message면 그대로(진행 메모가 있어도) ----
  queue.push(() => msg("c1", [{ thinking: "정리" }, { thinking: "짧은 메모" }, { tool: "respond", id: "rc1", input: { message: FULL + "\n" + "자세한 설명 ".repeat(40), options: ["좋아"] } }], "tool_use"));
  const b4 = requests.length;
  await send("길게 설명해 줘", b4 + 1);
  await page.waitForTimeout(300);
  check("긴 message면 다시 요청하지 않음", requests.length === b4 + 1);

  // ---- 4. 다시 받아도 그렇다면 요약이라도 본문으로 ----
  queue.push(() => msg("d1", [{ thinking: "정리" }, { thinking: SUMMARY }, { tool: "respond", id: "rd1", input: { message: "", options: ["좋아"] } }], "tool_use"));
  queue.push(() => msg("d2", [{ thinking: "다시" }, { thinking: "두 번째 요약" }, { tool: "respond", id: "rd2", input: { message: "", options: ["좋아"] } }], "tool_use"));
  const b5 = requests.length;
  await send("또 정리해 줘", b5 + 2);
  await page.waitForTimeout(300);
  la = await lastAssistant();
  check("다시 받기는 한 번만", requests.length === b5 + 2);
  check("그래도 비면 요약을 본문으로", la.body.includes("두 번째 요약"), la.body);

  // ---- 5. 예전 대화(대답 추천 도구): 글로만 다시 받음 ----
  await page.click("#newThreadBtn");
  queue.push(() => msg("e0", [{ text: "새 대화예요." }, { tool: "suggest_replies", id: "s0", input: { options: ["좋아"] } }], "tool_use"));
  const b6 = requests.length;
  await send("시작", b6 + 1);
  const wid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid);
  threads.find((t) => t.id === tid).promptVersion = 5;
  await idbSet("threads:" + wid, threads);
  await page.reload();
  await page.waitForSelector("#app");
  queue.push(() => msg("e1", [{ thinking: "정리" }, { thinking: SUMMARY }, { tool: "suggest_replies", id: "s1", input: { options: ["①", "②"] } }], "tool_use"));
  queue.push(() => msg("e2", [{ text: FULL }], "end_turn"));
  const b7 = requests.length;
  await send("목적 정해 줘", b7 + 2);
  const tools7 = requests[b7].body.tools.map((t) => t.name);
  check("예전 대화는 예전 도구(suggest_replies)", tools7.includes("suggest_replies") && !tools7.includes("respond"));
  const tr7 = lastUser(requests[b7 + 1]).content;
  check("예전 대화: 글로 다시 쓰라는 결과", tr7[0].tool_use_id === "s1" && tr7[0].is_error && tr7[0].content.includes("글로만 다시 써라"));
  la = await lastAssistant();
  check("예전 대화: 본문 전체가 보임(요약은 접힘)", la.body.includes("가르논 구출") && !la.body.includes(SUMMARY) && la.thinking === 2, la.body.slice(0, 80));
  queue.push(() => msg("e3", [{ text: "좋아요." }], "end_turn"));
  const b8 = requests.length;
  await send("고마워", b8 + 1);
  const nu8 = lastUser(requests[b8]).content;
  check("예전 대화: 남은 도구 결과 없음", !JSON.stringify(nu8).includes("tool_result"));

  // ---- 6. 인터뷰 안내, 좁은 화면 ----
  await page.click('.tabbar [data-view="codex"]');
  await page.click('.entry-card[data-ref="C-001"]');
  await page.click('#sheetBody [data-act="interview"]');
  await page.fill("#input", "");
  check("인터뷰 안내 문구", (await page.getAttribute("#input", "placeholder")) === "질문해 보세요");
  await page.click('#modeBar [data-mode="cancel"]');
  await page.setViewportSize({ width: 360, height: 700 });
  await page.waitForTimeout(150);
  check("360px에서도 빈 입력창 한 줄", (await page.$eval("#input", (t) => t.offsetHeight)) <= 46);
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
