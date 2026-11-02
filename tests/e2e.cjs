// 로어키퍼 E2E 테스트: Claude API를 가짜 SSE로 대체하고 모바일 화면에서 전체 흐름을 확인한다.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;

const APP = L.INDEX;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
fs.mkdirSync(SHOTS, { recursive: true });

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(APP));
}).listen(8765);

// ---------- SSE 생성 ----------
function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
function msg(id, blocks, stop, usage = {}) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1, cache_creation_input_tokens: 2500, cache_read_input_tokens: 0, ...usage } } }];
  blocks.forEach((b, i) => {
    if (b.thinking !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig_" + id } });
    } else if (b.text !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      for (const part of b.text.match(/[\s\S]{1,12}/g)) ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } });
    } else if (b.tool) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } });
      const json = JSON.stringify(b.input);
      for (const part of json.match(/[\s\S]{1,15}/g)) ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: part } });
    }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 420 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}

const SINGLE = ["하람의 과거를 더 파 보자", "서리와 하람의 첫 만남 장면을 써 줘", "알아서 다음 걸 정해 줘"];
const MULTI = ["하람은 한쪽 눈이 멀었다", "하람은 무등회 출신이다", "하람은 매일 밤 등명부를 읽는다"];
const scripted = [
  // 1: 검색
  () => msg("m1", [
    { thinking: "사용자는 서리의 스승을 원한다. 기존에 스승 역할이 있는지 먼저 찾아보자." },
    { text: "스승 후보가 이미 있는지 먼저 볼게요." },
    { tool: "search_entries", id: "tu_1", input: { query: "스승" } },
  ], "tool_use"),
  // 2: 생성 + 관계 + 잘못된 호출
  () => msg("m2", [
    { tool: "create_entry", id: "tu_2", input: { type: "character", name: "하람", summary: "잿빛 첨탑 등대의 늙은 등대지기. 마흔 해 동안 기억을 바쳐 왔다.", fields: { "나이": "71", "남은 기억": "열두 개 남짓" }, body: "말수가 적고 \"불은 이야기로 켠다\"는 말을 자주 한다.", tags: ["등대지기"] } },
    { tool: "set_relation", id: "tu_3", input: { from_id: "C-001", to_id: "C-002", label: "스승", reverse_label: "제자" } },
    { tool: "update_entry", id: "tu_4", input: { summary: "id가 빠진 잘못된 호출" } },
  ], "tool_use"),
  // 3: 답 + 대답 추천(하나 고르기)
  () => msg("m3", [
    { tool: "respond", id: "tu_5", input: { message: "**하람(C-002)**을 만들고 서리(C-001)와 사제 관계로 이었습니다.\n\n다음으로 무엇을 해 볼까요?", options: SINGLE } },
  ], "tool_use", { cache_read_input_tokens: 2500, cache_creation_input_tokens: 400 }),
  // 4: 대답 추천(여러 개 고르기)
  () => msg("m4", [
    { tool: "respond", id: "tu_6", input: { message: "하람의 과거에 붙일 만한 특징 세 가지입니다. 마음에 드는 걸 골라 주세요.", options: MULTI, multiple: true } },
  ], "tool_use"),
  // 5: 다른 도구와 섞어서 호출(표시되면 안 됨)
  () => msg("m5", [
    { tool: "create_entry", id: "tu_7", input: { type: "place", name: "바람꼬리 섬", summary: "잿빛 첨탑 등대가 서 있는 서쪽 끝 섬." } },
    { tool: "respond", id: "tu_8", input: { message: "섞어서 부른 답", options: ["섞어서 부른 추천"] } },
  ], "tool_use"),
  // 6: 마무리 + 대답 추천
  () => msg("m6", [
    { tool: "respond", id: "tu_9", input: { message: "두 가지를 반영하고 바람꼬리 섬(P-002)도 추가했습니다.", options: ["좋아", "섬을 더 자세히"] } },
  ], "tool_use"),
  // 7: 첨부 자료 답변
  () => msg("m7", [{ text: "첨부한 지도와 조합 규칙을 읽었습니다. 새로 만들 항목을 정리해 볼게요." }], "end_turn"),
  // 8: 첨부만 보낸 경우
  () => msg("m8", [{ text: "그림을 봤어요." }], "end_turn"),
];
const FILES = path.join(L.TESTS, "files");
const countReqs = [];

const requests = [];
let mode = "script"; // script | slow | auth
let callNo = 0;
const lastUser = (r) => r.body.messages[r.body.messages.length - 1];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); };

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().includes("/v1/models/")) {
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" }) });
    }
    const body = JSON.parse(req.postData());
    if (req.url().includes("/v1/messages/count_tokens")) {
      countReqs.push(body);
      const blk = body.messages[0].content[0];
      const n = blk.type === "image" ? 1600 : blk.type === "document" ? 5200 : 900;
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ input_tokens: n }) });
    }
    requests.push({ url: req.url(), headers: req.headers(), body });
    if (mode === "auth") {
      return route.fulfill({ status: 401, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    }
    if (mode === "slow") {
      await new Promise((r) => setTimeout(r, 4000));
      try { await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: msg("slow", [{ text: "늦은 답" }], "end_turn") }); } catch { /* 이미 중단됨 */ }
      return;
    }
    const make = scripted[callNo++];
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });

  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });

  await page.goto("http://localhost:8765/");
  await page.waitForSelector("text=세계관을 하나 열어 보세요");
  check("첫 화면 표시", true);

  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");
  check("예시 세계관 4개 항목", (await page.$$eval(".entry-card", (els) => els.length)) === 4);
  const codexOverflow = await page.evaluate(() => [...document.querySelectorAll("#app, .topbar, .scroll, .world-card, .codex-tools")].map((el) => el.getBoundingClientRect().right).filter((r) => r > window.innerWidth + 1));
  check("설정집 화면 폭이 화면 안에 들어옴", codexOverflow.length === 0, JSON.stringify(codexOverflow));
  await page.fill("#codexSearch", "등대");
  check("검색 중 입력란 포커스 유지", await page.evaluate(() => document.activeElement?.id === "codexSearch"));
  await page.fill("#codexSearch", "");

  // API 키
  await page.click('.tabbar [data-view="settings"]');
  await page.fill("#apiKey", "sk-ant-test-key-1234567890");
  await page.click('#keyForm button[type="submit"]');
  await page.waitForSelector("text=저장된 키");
  await page.click('[data-act="test-key"]');
  await page.waitForSelector("#toast:not([hidden])");
  check("연결 확인 (models.retrieve)", (await page.textContent("#toast")).includes("연결됨"));

  // ---- 1차: 생성 + 하나 고르기 추천 ----
  await page.click('.tabbar [data-view="chat"]');
  await page.fill("#input", "서리의 스승을 만들어 줘");
  await page.click("#sendBtn");
  await until(() => requests.length >= 3);
  await waitIdle();
  await page.waitForSelector("#quickReplies");
  check("추천만 부른 차례에서 추가 호출 없이 종료(3회)", requests.length === 3, `calls=${requests.length}`);
  const r1 = requests[0];
  check("respond 도구 정의 포함(대답 추천 대체)", r1.body.tools.some((t) => t.name === "respond" && t.eager_input_streaming === true) && !r1.body.tools.some((t) => t.name === "suggest_replies"));
  check("시스템 프롬프트에 답하는 방법 지침", r1.body.system[0].text.includes("## 답하는 방법"));
  check("beta 헤더 + fallbacks", (r1.headers["anthropic-beta"] || "").includes("server-side-fallback-2026-07-01") && r1.body.fallbacks === "default");
  check("안전장치: block_binding drop_block", r1.body.thinking?.block_binding?.prefix_mismatch_behavior === "drop_block" && (r1.headers["anthropic-beta"] || "").includes("thinking-binding-controls-2026-08-01"), JSON.stringify(r1.body.thinking));
  check("새 대화는 최신 프롬프트(분류·템플릿 포함)", r1.body.system[0].text.includes("## 분류와 템플릿") && r1.body.tools.some((t) => t.name === "get_template") && r1.body.tools.some((t) => t.name === "list_types"));
  check("첫 메시지에 분류 목록 첨부", r1.body.messages[0].content[0].text.includes("분류 목록") && r1.body.messages[0].content[0].text.includes("인물 (키 character, ID 코드 C)"));
  const r3 = requests[2];
  const tr2 = lastUser(r3).content;
  check("병렬 tool_result 3개 + 잘못된 입력 is_error", tr2.length === 3 && tr2[2].is_error === true && tr2[0].content.includes("C-002"));
  const qrTexts = await page.$$eval("#quickReplies .qr", (els) => els.map((e) => e.textContent.trim()));
  check("추천 대답 3개 표시", JSON.stringify(qrTexts) === JSON.stringify(SINGLE), qrTexts.join(" | "));
  check("입력란 안내 문구 변경", (await page.getAttribute("#input", "placeholder")) === "직접 써도 돼요");
  await page.screenshot({ path: `${SHOTS}/10-quick-single.png` });

  // ✎ 고쳐서 보내기 → 입력란 채움(전송 안 함)
  await page.click('#quickReplies [data-qr-edit="1"]');
  check("✎ 누르면 입력란에 채움", (await page.inputValue("#input")) === SINGLE[1]);
  check("✎는 바로 보내지 않음", requests.length === 3);
  await page.fill("#input", "");

  // 직접 수정 후 돌아와도 추천 유지
  await page.click('#chatLog .ref[data-ref="C-002"]');
  await page.waitForSelector("#sheet:not([hidden]) .entry-name");
  await page.click('#sheetBody [data-act="edit"]');
  await page.fill("#f-summary", "잿빛 첨탑 등대의 늙은 등대지기. 사실 남은 기억이 하나뿐이다.");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  check("직접 수정 뒤에도 추천 유지", !!(await page.$("#quickReplies")));

  // 추천 눌러서 바로 보내기
  await page.click('#quickReplies [data-qr="0"]');
  await until(() => requests.length >= 4);
  await waitIdle();
  await page.waitForSelector("#quickReplies .qr-toggle");
  const r4 = requests[3];
  const u4 = lastUser(r4).content;
  check("추천 결과가 다음 메시지 맨 앞(tool_result)", u4[0].type === "tool_result" && u4[0].tool_use_id === "tu_5" && u4[0].content.includes("골랐다"), JSON.stringify(u4[0]));
  check("직접 수정 알림이 그다음", u4[1].type === "text" && u4[1].text.includes("[앱 알림") && u4[1].text.includes("C-002"));
  check("고른 대답이 사용자 메시지로", u4[2].text === SINGLE[0]);
  const prevAssistant = r4.body.messages[r4.body.messages.length - 2];
  check("추천 도구 호출이 기록에 그대로", prevAssistant.role === "assistant" && prevAssistant.content.some((b) => b.type === "tool_use" && b.id === "tu_5"));
  const shownUser = await page.$$eval("#chatLog .msg-user", (els) => els.map((e) => e.textContent));
  check("고른 대답이 대화에 표시", shownUser.includes(SINGLE[0]));

  // ---- 여러 개 고르기 ----
  check("여러 개 고르기: 처음엔 보내기 비활성", await page.$eval("[data-qr-send]", (b) => b.disabled));
  await page.click('#quickReplies [data-qr-toggle="0"]');
  await page.click('#quickReplies [data-qr-toggle="2"]');
  const sendLabel = await page.textContent("[data-qr-send]");
  check("두 개 체크하면 '고른 2개로 답하기'", sendLabel.includes("고른 2개"), sendLabel);
  check("체크 상태 표시", (await page.$$eval('#quickReplies [aria-pressed="true"]', (els) => els.length)) === 2);
  await page.screenshot({ path: `${SHOTS}/11-quick-multi.png` });
  await page.click("[data-qr-send]");
  await until(() => requests.length >= 6);
  await waitIdle();
  await page.waitForSelector("#quickReplies");
  const r5 = requests[4];
  const u5 = lastUser(r5).content;
  check("여러 개 고르기 결과 전송", u5[0].tool_use_id === "tu_6" && u5[u5.length - 1].text.includes(MULTI[0]) && u5[u5.length - 1].text.includes(MULTI[2]) && !u5[u5.length - 1].text.includes(MULTI[1]), u5[u5.length - 1].text);

  // ---- 다른 도구와 섞인 추천은 표시하지 않고 계속 진행 ----
  check("섞인 호출 뒤 한 번 더 호출(총 6회)", requests.length === 6, `calls=${requests.length}`);
  const r6 = requests[5];
  const tr6 = lastUser(r6).content;
  check("섞인 추천은 is_error로 돌려줌", tr6.length === 2 && tr6[1].tool_use_id === "tu_8" && tr6[1].is_error === true && tr6[1].content.includes("표시하지 않았다"), JSON.stringify(tr6[1]));
  const qr2 = await page.$$eval("#quickReplies .qr", (els) => els.map((e) => e.textContent.trim()));
  check("마지막 추천만 표시", JSON.stringify(qr2) === JSON.stringify(["좋아", "섬을 더 자세히"]), qr2.join(" | "));

  // ---- 첨부 파일 ----
  const toastSeen = [];
  await page.exposeFunction("__toast", (t) => toastSeen.push(t));
  await page.evaluate(() => new MutationObserver(() => { const t = document.querySelector("#toast"); if (!t.hidden) window.__toast(t.textContent); }).observe(document.querySelector("#toast"), { childList: true, characterData: true, subtree: true, attributes: true }));
  await page.setInputFiles("#fileInput", ["small.png", "map-big.png", "world.pdf", "notes-euckr.txt", "archive.zip"].map((f) => path.join(FILES, f)));
  await page.waitForFunction(() => document.querySelectorAll("#attachTray .att").length === 4 && ![...document.querySelectorAll(".att-sub")].some((e) => /준비 중|계산 중/.test(e.textContent)), null, { timeout: 15000 });
  check("지원하지 않는 파일 거절 안내", toastSeen.some((t) => t.includes("archive.zip")), toastSeen.join(" | "));
  const subs = await page.$$eval("#attachTray .att-sub", (els) => els.map((e) => e.textContent));
  check("첨부마다 토큰·비용 표시", subs.every((t) => /토큰 · \$0\.\d{3}/.test(t)), subs.join(" | "));
  check("토큰 계산은 count_tokens로(4회)", countReqs.length === 4 && countReqs.every((b) => b.model === "claude-opus-5-5"), `count=${countReqs.length}`);
  await page.screenshot({ path: `${SHOTS}/13-attach-tray.png` });
  await page.click('#attachTray .att:first-child [data-att-remove]');
  check("첨부 빼기", (await page.$$eval("#attachTray .att", (els) => els.length)) === 3);
  await page.fill("#input", "이 자료로 설정을 뽑아 줘");
  await page.click("#sendBtn");
  await until(() => requests.length >= 7);
  await waitIdle();
  if (!requests[6]) {
    console.log("DEBUG toasts:", toastSeen.join(" | "));
    console.log("DEBUG requests:", requests.length, "tray:", await page.$$eval("#attachTray .att-sub", (els) => els.map((e) => e.textContent).join(" | ")));
    console.log("DEBUG input:", await page.inputValue("#input"), "console:", consoleErrors.join(" || ").slice(0, 800));
    await page.screenshot({ path: `${SHOTS}/debug3.png` });
  }
  const r7 = requests[6];
  const u7 = lastUser(r7).content;
  check("직접 입력하면 '직접 입력' 결과", u7[0].tool_use_id === "tu_9" && u7[0].content.includes("직접 입력"), JSON.stringify(u7[0]));
  check("보낸 뒤 추천 사라짐", !(await page.$("#quickReplies")));
  const img = u7.find((b) => b.type === "image");
  const doc = u7.find((b) => b.type === "document");
  const txt = u7.find((b) => b.type === "text" && b.text.startsWith("[첨부 파일:"));
  check("큰 이미지는 JPEG로 줄여서 전송", img && img.source.type === "base64" && img.source.media_type === "image/jpeg");
  const jpg = Buffer.from(img.source.data, "base64");
  let w = 0, h = 0;
  for (let o = 2; o < jpg.length;) { const len = jpg.readUInt16BE(o + 2); if (jpg[o + 1] >= 0xc0 && jpg[o + 1] <= 0xc2) { h = jpg.readUInt16BE(o + 5); w = jpg.readUInt16BE(o + 7); break; } o += 2 + len; }
  check("이미지 긴 변 1568px 이하", Math.max(w, h) === 1568, `${w}x${h}`);
  check("PDF는 document 블록(title 포함)", doc && doc.source.media_type === "application/pdf" && doc.title === "world.pdf");
  check("EUC-KR 텍스트 한글 복원", txt && txt.text.includes("등대지기 조합 규칙") && txt.text.includes("notes-euckr.txt"), txt?.text.slice(0, 60));
  const order = u7.map((b) => b.type);
  check("순서: 도구결과 → 첨부 → 질문", order[0] === "tool_result" && u7[u7.length - 1].text === "이 자료로 설정을 뽑아 줘" && order.indexOf("image") < order.length - 1, order.join(","));
  check("보낸 뒤 첨부 칸 비움", await page.$eval("#attachTray", (e) => e.hidden));
  const bubble = await page.evaluate(() => { const us = [...document.querySelectorAll("#chatLog .msg-user")]; const u = us[us.length - 1]; return u.querySelectorAll(".msg-thumb, .file-chip").length; });
  check("대화에 첨부 표시(썸네일+파일 칩)", bubble === 3, `n=${bubble}`);
  await page.click("#chatLog .msg-thumb");
  await page.waitForSelector("#sheet:not([hidden]) .preview-img");
  check("썸네일 누르면 크게 보기", true);
  await page.screenshot({ path: `${SHOTS}/14-attach-sent.png` });
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });

  // 첨부만 보내기
  await page.setInputFiles("#fileInput", [path.join(FILES, "small.png")]);
  await page.waitForFunction(() => document.querySelectorAll("#attachTray .att").length === 1 && !/준비 중|계산 중/.test(document.querySelector(".att-sub").textContent), null, { timeout: 10000 });
  await page.click("#sendBtn");
  await until(() => requests.length >= 8);
  await waitIdle();
  const u8 = lastUser(requests[7]).content;
  check("첨부만 보내도 전송(작은 PNG는 그대로)", u8[0].type === "image" && u8[0].source.media_type === "image/png" && u8[u8.length - 1].text === "첨부한 파일을 봐 줘.", u8.map((b) => b.type).join(","));

  // ---- 직접 입력 + 멈추기 ----
  mode = "slow";
  await page.fill("#input", "길게 생각해 줘");
  await page.click("#sendBtn");
  await page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "멈추기");
  await page.waitForTimeout(400);
  await page.click("#sendBtn");
  await page.waitForSelector("text=응답을 멈췄습니다", { timeout: 8000 });
  check("멈추기 후 다시 시도 버튼", !!(await page.$('[data-act="retry"]')));

  mode = "auth";
  await page.click('[data-act="retry"]');
  await page.waitForSelector("text=API 키가 올바르지 않습니다", { timeout: 8000 });
  check("401 오류 안내", true);

  // 새로고침 후 유지
  await page.reload();
  await page.waitForSelector("#chatLog .msg-user");
  const userMsgs = await page.$$eval("#chatLog .msg-user", (els) => els.length);
  await page.click('.tabbar [data-view="codex"]');
  const cards = await page.$$eval(".entry-card", (els) => els.length);
  const sameThread = requests.filter((r) => r.body.messages[0].content.some((c) => c.type === "text" && c.text === "서리의 스승을 만들어 줘"));
  check("한 대화 안에서 시스템·도구가 끝까지 동일", sameThread.length >= 8 && sameThread.every((r) => JSON.stringify(r.body.system) === JSON.stringify(sameThread[0].body.system) && JSON.stringify(r.body.tools) === JSON.stringify(sameThread[0].body.tools)), `n=${sameThread.length}`);
  check("새로고침 후 대화 유지(6개)", userMsgs === 6, `userMsgs=${userMsgs}`);
  check("새로고침 후 설정집 유지(6개)", cards === 6, `cards=${cards}`);

  // 다크 모드에서 추천 화면
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click('.tabbar [data-view="chat"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("가로 넘침 없음", !overflow);

  check("콘솔 오류 없음", consoleErrors.filter((e) => !/401|Failed to load resource|ERR_FAILED|AuthenticationError|invalid x-api-key/i.test(e)).length === 0, consoleErrors.join(" || ").slice(0, 400));

  // 다크 모드 추천 화면 캡처용: 새 컨텍스트에서 추천이 떠 있는 상태 재현은 생략하고 현재 화면만 저장
  await page.screenshot({ path: `${SHOTS}/12-chat-dark.png` });

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
