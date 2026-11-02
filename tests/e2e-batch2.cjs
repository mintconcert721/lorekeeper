// 2차: 원고함, 세계 속 문서, 시뮬레이션, 인물 인터뷰, 관점별 서술, 감각 사전, 이름 규칙·생성기, 질문 카드, 항목 그림
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V6 = L.PROMPT_SET(6);
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8772);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function msg(id, blocks, stop) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
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
const queue = [];      // 대화(스트리밍) 응답
const quick = [];      // 단발(비스트리밍) 응답 텍스트
const requests = [];
const quickReqs = [];

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
    const body = JSON.parse(req.postData());
    if (!body.stream) {
      quickReqs.push({ body, headers: req.headers() });
      const text = quick.shift() || "";
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ id: "q" + quickReqs.length, type: "message", role: "assistant", model: body.model, content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 300, output_tokens: 80 } }) });
    }
    requests.push({ body });
    const make = queue.shift() || (() => msg("x", [{ tool: "respond", id: "rsx", input: { message: "네." } }], "tool_use"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { if (text !== null) await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300); };
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(150); await page.click(`.tabbar [data-view="${v}"]`); };
  const ctab = (k) => page.click(`#codex [data-ctab="${k}"]`);
  const idbGet = (key) => page.evaluate((k) => new Promise((res, rej) => {
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
    r.onerror = () => rej(r.error);
  }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res, rej) => {
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
  }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const firstText = (r) => { const c = r.body.messages[0].content; return Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : c; };

  await page.goto("http://localhost:8772/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 설정집 구역 탭 + 원고 직접 쓰기 ----
  await tab("codex");
  const tabs = await page.$$eval("#codex [data-ctab]", (els) => els.map((e) => e.textContent));
  check("설정집 구역 탭 6개", tabs.join(",") === "항목,원고함,감각 사전,질문 카드,이름 규칙,복선", tabs.join(","));
  await ctab("ms");
  check("원고함 비어 있음 안내", (await page.textContent("#ctabResults")).includes("원고함이 비어 있습니다"));
  await page.click('[data-act="ms-new"]');
  await page.fill("#m-title", "등대지기의 노래");
  await page.selectOption("#m-kind", "문서");
  await page.fill("#m-body", "불이 꺼지면 바다가 운다\n\n**후렴** 잿빛 첨탑 위로");
  await page.fill("#m-refs", "서리, P-001");
  await page.click('#msForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .ms-body");
  check("원고 저장 후 보기", (await page.textContent("#sheetBody .entry-name")) === "등대지기의 노래" && (await page.textContent("#sheetBody .ms-body")).includes("불이 꺼지면"));
  check("원고 관련 항목 연결", (await page.textContent("#sheetBody")).includes("C-001") && (await page.textContent("#sheetBody")).includes("P-001"));
  await closeSheet();
  check("원고함 목록에 카드", (await page.$$("#ctabResults .ms-card")).length === 1);
  await page.click('[data-mskind="장면"]');
  check("종류 필터(장면 0)", (await page.$$("#ctabResults .ms-card")).length === 0);
  await page.click('[data-mskind="all"]');
  await page.fill("#msSearch", "첨탑");
  await page.waitForTimeout(100);
  check("원고 검색", (await page.$$("#ctabResults .ms-card")).length === 1);
  await page.fill("#msSearch", "");
  const msStored = await idbGet("ms:" + (await wid()));
  check("원고 IndexedDB 저장", msStored?.length === 1 && msStored[0].refs.join() === "C-001,P-001" && msStored[0].by === "user");

  // ---- 2. v7 대화: Claude가 원고·관점·감각·이름 규칙 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "save_manuscript", id: "sm1", input: { title: "무등회 수배서", kind: "문서", body: "# 수배\n안개 속 아이를 찾는다.", refs: ["F-001"] } },
    { tool: "set_perspective", id: "sp1", input: { id: "P-001", by: "F-001", text: "무등회는 등대를 기억을 가두는 감옥이라 부른다." } },
    { tool: "create_entry", id: "ce1", input: { type: "장소", name: "소금 시장", summary: "항구 뒤편 시장", senses: { 소리: "흥정하는 고함", 냄새: "말린 생선과 소금" } } },
    { tool: "set_naming_rule", id: "nr1", input: { name: "안개바다 섬사람", applies_to: ["인물"], rules: "두 음절, 받침 없이", examples: ["서리", "나래"] } },
    { tool: "get_manuscripts", id: "gm1", input: { query: "노래" } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rs1", input: { message: "수배서를 원고함에 넣고, 시장의 소리와 냄새를 적었어요.", options: ["좋아"] } }], "tool_use"));
  const base2 = requests.length;
  await send("수배서 하나 만들어 줘", base2 + 2);
  const r2 = requests[base2];
  const toolNames = r2.body.tools.map((t) => t.name);
  check("v7 도구 목록", ["set_perspective", "save_manuscript", "get_manuscripts", "set_naming_rule"].every((n) => toolNames.includes(n)) && toolNames[toolNames.length - 1] === "respond", toolNames.join(","));
  check("v7 지침에 원고함·인터뷰 절", r2.body.system[0].text.includes("## 원고함") && r2.body.system[0].text.includes("## 인물 인터뷰"));
  const f2 = firstText(r2);
  check("첫 메시지: 이름 규칙·원고함 현황", f2.includes("이름 규칙: 없음") && f2.includes("원고함: 1편"), f2.split("\n").filter((l) => /이름 규칙|원고함/.test(l)).join(" / "));
  const tr2 = requests[base2 + 1].body.messages[requests[base2 + 1].body.messages.length - 1].content.filter((b) => b.type === "tool_result");
  check("도구 결과 5개 모두 성공", tr2.length === 5 && tr2.every((b) => !b.is_error), JSON.stringify(tr2.filter((b) => b.is_error)).slice(0, 300));
  const gm = tr2.find((b) => b.tool_use_id === "gm1");
  check("get_manuscripts가 원고를 찾음", JSON.stringify(gm.content).includes("등대지기의 노래"), JSON.stringify(gm.content).slice(0, 200));
  await tab("codex");
  await ctab("ms");
  check("Claude 원고가 원고함에", (await page.$$("#ctabResults .ms-card")).length === 2 && (await page.textContent("#ctabResults")).includes("무등회 수배서"));
  await ctab("senses");
  check("감각 사전에 새 장소", (await page.textContent("#ctabResults")).includes("소금 시장") && (await page.textContent("#ctabResults")).includes("말린 생선과 소금"));
  check("감각 빈 장소 안내", (await page.textContent("#ctabResults")).includes("감각이 비어 있는 장소") && (await page.textContent("#ctabResults")).includes("잿빛 첨탑 등대"));
  await page.screenshot({ path: `${SHOTS}/70-senses.png` });
  await ctab("naming");
  check("이름 규칙 탭에 규칙", (await page.textContent("#ctabResults")).includes("안개바다 섬사람") && (await page.textContent("#ctabResults")).includes("서리, 나래"));
  await ctab("entries");
  await page.click('.entry-card[data-ref="P-001"]');
  const p1 = await page.textContent("#sheetBody");
  check("항목 화면에 관점별 서술", p1.includes("관점별 서술") && p1.includes("무등회의 관점") && p1.includes("감옥이라 부른다"));
  await closeSheet();

  // ---- 3. 예전 대화(v6)는 v6 지침·도구 그대로 ----
  const w = await wid();
  const threads = await idbGet("threads:" + w);
  const curT = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const t6 = threads.find((t) => t.id === curT);
  t6.promptVersion = 6;
  await idbSet("threads:" + w, threads);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("chat");
  const base3 = requests.length;
  await send("하나 더", base3 + 1);
  const r3 = requests[base3];
  check("v6 대화: 지침 그대로", r3.body.system[0].text === V6.system);
  check("v6 대화: 도구 그대로", JSON.stringify(r3.body.tools) === JSON.stringify(V6.tools), r3.body.tools.map((t) => t.name).join(","));

  // ---- 4. 인물 인터뷰 ----
  await tab("codex");
  await page.click('.entry-card[data-ref="C-001"]');
  await page.click('#sheetBody [data-act="interview"]');
  await page.waitForSelector("#modeBar:not([hidden])");
  check("인터뷰 준비 막대", (await page.textContent("#modeBar")).includes("서리 인터뷰") && (await page.inputValue("#input")).includes("자기소개"));
  const base4 = requests.length;
  await send(null, base4 + 1);
  const f4 = firstText(requests[base4]);
  check("첫 메시지에 [인물 인터뷰]", f4.includes("[인물 인터뷰] 대상: C-001 서리"), f4.slice(-300));
  check("인터뷰 대화 제목", (await page.textContent("#threadTitle")) === "서리 인터뷰");
  check("인터뷰 중 막대", (await page.textContent("#modeBar")).includes("인터뷰 중"));
  await page.screenshot({ path: `${SHOTS}/71-interview.png` });
  // 두 번째 메시지에는 인터뷰 안내를 다시 넣지 않는다(첫 메시지에만)
  const base4b = requests.length;
  await send("어머니를 기억하나요?", base4b + 1);
  const lastUser = requests[base4b].body.messages[requests[base4b].body.messages.length - 1];
  check("두 번째 메시지에는 인터뷰 안내 없음", !JSON.stringify(lastUser).includes("[인물 인터뷰]"));
  check("대화 기록 앞부분 그대로(append-only)", JSON.stringify(requests[base4b].body.messages[0]) === JSON.stringify(requests[base4].body.messages[0]));
  await page.click('#modeBar [data-mode="wrap"]');
  check("인터뷰 정리 요청 채우기", (await page.inputValue("#input")).startsWith("인터뷰 정리"));
  await page.click('#modeBar [data-mode="end"]');
  check("끝내기 → 새 대화, 막대 숨김", (await page.isHidden("#modeBar")) && (await page.textContent("#threadTitle")) === "");
  // 다른 대화를 열면 대기 중 모드가 풀린다
  await tab("codex");
  await page.click('.entry-card[data-ref="C-001"]');
  await page.click('#sheetBody [data-act="interview"]');
  await page.click('#modeBar [data-mode="cancel"]');
  check("인터뷰 준비 취소", await page.isHidden("#modeBar"));
  await page.fill("#input", "");

  // ---- 5. 창작 도구 ----
  await page.click("#toolsBtn");
  await page.waitForSelector("#sheetBody details.ct");
  check("창작 도구 8종", (await page.$$("#sheetBody details.ct")).length === 8);
  await page.click('#sheetBody details.ct:has(summary:text("세계 속 문서")) summary');
  await page.selectOption("#ct-doc", "신문 기사");
  await page.fill("#ct-doc-refs", "무등회");
  await page.click('[data-ct="doc"]');
  const docText = await page.inputValue("#input");
  check("세계 속 문서 요청", docText.includes("세계 속 문서") && docText.includes("신문 기사") && docText.includes("무등회") && docText.includes("원고함"));
  await page.click("#toolsBtn");
  await page.click('#sheetBody details.ct:has(summary:text("N년 뒤 시뮬레이션")) summary');
  await page.fill("#ct-years", "30");
  await page.fill("#ct-if", "등대가 꺼진다면");
  await page.click('[data-ct="sim"]');
  const simText = await page.inputValue("#input");
  check("N년 뒤 시뮬레이션 요청", simText.startsWith("30년 뒤 시뮬레이션") && simText.includes("등대가 꺼진다면") && simText.includes("초안"));
  await page.click("#toolsBtn");
  await page.click('#sheetBody details.ct:has(summary:text("장면 쓰기")) summary');
  await page.click('[data-ct="scene"]');
  check("장면: 빈 칸이면 안내", (await page.textContent("#toast")).includes("장면을 적어"));
  await page.fill("#ct-scene", "서리가 처음 등대에 오르는 밤");
  await page.selectOption("#ct-pov", "1인칭");
  await page.click('[data-ct="scene"]');
  check("장면 요청", (await page.inputValue("#input")).includes("서리가 처음 등대에 오르는 밤") && (await page.inputValue("#input")).includes("1인칭"));
  await page.click("#toolsBtn");
  await page.click('#sheetBody details.ct:has(summary:text("관점별 서술")) summary');
  await page.selectOption("#ct-persp", "K-001");
  await page.fill("#ct-persp-by", "왕실, 무등회");
  await page.click('[data-ct="persp"]');
  check("관점별 서술 요청", (await page.inputValue("#input")).includes("등명 계약(K-001)") && (await page.inputValue("#input")).includes("set_perspective"));
  await page.click("#toolsBtn");
  await page.click('[data-ct="interview"]');
  check("창작 도구에서 인터뷰", (await page.textContent("#modeBar")).includes("인터뷰"));
  await page.click('#modeBar [data-mode="cancel"]');
  await page.fill("#input", "");

  // ---- 6. 항목 편집: 감각·관점·그림 ----
  await tab("codex");
  await page.click('.entry-card[data-ref="P-001"]');
  await page.click('#sheetBody [data-act="edit"]');
  await page.fill('.sense-in[data-k="소리"]', "밤마다 울리는 무적");
  await page.fill('.sense-in[data-k="빛"]', "잿빛 불꽃");
  check("편집기에 기존 관점 행", (await page.$$("#f-persp .persp-row")).length === 1 && (await page.inputValue("#f-persp .persp-row .pb")).startsWith("F-001"));
  await page.click('[data-add="persp"]');
  await page.fill("#f-persp .persp-row:last-child .pb", "서리");
  await page.fill("#f-persp .persp-row:last-child .pt", "서리에게 등대는 집이다.");
  await page.setInputFiles("#f-img", { name: "tower.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector("#f-img-prev:not([hidden])");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-img");
  const p6 = await page.textContent("#sheetBody");
  check("저장 후 그림 표시", (await page.getAttribute("#sheetBody .entry-img", "src")).startsWith("data:image/jpeg"));
  check("저장 후 감각 표시", p6.includes("밤마다 울리는 무적") && p6.includes("잿빛 불꽃"));
  check("저장 후 관점 2개", (await page.$$("#sheetBody .persp")).length === 2 && p6.includes("서리에게 등대는 집이다"));
  const e6 = (await idbGet("entries:" + w)).find((e) => e.id === "P-001");
  check("관점 by는 항목 id로", e6.perspectives.map((x) => x.by).join() === "F-001,C-001", JSON.stringify(e6.perspectives));
  await page.click('#sheetBody [data-act="img-zoom"]');
  check("그림 크게 보기", await page.$eval("#sheetBody .entry-img-btn", (el) => el.classList.contains("full")));
  await closeSheet();
  check("설정집 카드에 그림", !!(await page.$('.entry-card[data-ref="P-001"] .ecard-img')));
  const imgs = await idbGet("imgs:" + w);
  check("그림 IndexedDB 저장", imgs?.["P-001"]?.data?.startsWith("data:image/jpeg") && imgs["P-001"].at > 0);
  // 그림으로 묘사 받기 → 첨부
  await page.click('.entry-card[data-ref="P-001"]');
  await page.click('#sheetBody [data-act="img-ask"]');
  await page.waitForSelector("#attachTray:not([hidden]) .att");
  check("그림으로 묘사 받기 → 첨부 + 요청", (await page.inputValue("#input")).includes("잿빛 첨탑 등대(P-001)의 모습"));
  await page.click("#attachTray .att button");
  await page.fill("#input", "");
  // 감각 빈칸 지우기 → 감각 제거
  await tab("codex");
  await page.click('.entry-card[data-ref="P-001"]');
  await page.click('#sheetBody [data-act="edit"]');
  await page.fill('.sense-in[data-k="빛"]', "");
  await page.click('[data-act="img-clear"]');
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  check("그림 빼기", !(await page.$("#sheetBody .entry-img")) && (await idbGet("imgs:" + w))["P-001"].data === "");
  check("감각 칸 비우면 지움", !(await page.textContent("#sheetBody")).includes("잿빛 불꽃") && (await page.textContent("#sheetBody")).includes("밤마다 울리는 무적"));
  await closeSheet();

  // ---- 7. 질문 카드 ----
  await ctab("questions");
  check("오늘의 질문 3장", (await page.$$("#ctabResults .q-card")).length === 3);
  const q1 = await page.textContent("#ctabResults .q-card .q-text");
  await page.click("#ctabResults .q-card [data-q-done]");
  await page.waitForTimeout(150);
  check("정했음 → 목록에서 빠짐", !(await page.textContent("#ctabResults .q-cards")).includes(q1) && (await page.textContent("#ctabResults")).includes("정한 질문 1"));
  await page.click("#ctabResults .q-card [data-q-skip]");
  await page.waitForTimeout(150);
  const worlds = await idbGet("worlds");
  const qa = worlds.find((x) => x.id === w).qa;
  check("질문 상태 저장", Object.keys(qa.done).length === 1 && Object.keys(qa.skipped).length === 1);
  quick.push("음식 | 등대지기는 밤참으로 무엇을 먹나요?\n- 의례 | 등대에 불을 처음 켤 때 하는 의식은?\n잘못된 줄");
  await page.click('[data-act="q-custom"]');
  await page.waitForFunction(() => document.querySelector("#ctabResults")?.textContent.includes("등대지기는 밤참"), null, { timeout: 10000 });
  check("맞춤 질문이 맨 앞", (await page.textContent("#ctabResults .q-card .q-text")).includes("등대지기는 밤참") || (await page.textContent("#ctabResults .q-cards")).includes("등대에 불을 처음"));
  const qr = quickReqs[quickReqs.length - 1].body;
  check("단발 요청: 스트리밍 아님, effort low, 생각 설정 없음", !qr.stream && qr.output_config?.effort === "low" && qr.thinking === undefined && qr.max_tokens === 8000, JSON.stringify({ stream: qr.stream, oc: qr.output_config, th: qr.thinking, mt: qr.max_tokens }));
  check("단발 요청: 기본은 Haiku 5.5(대체 모델 설정 없음)", qr.model === "claude-haiku-5-5" && qr.fallbacks === undefined && !(quickReqs[quickReqs.length - 1].headers["anthropic-beta"] || "").includes("server-side-fallback"));
  check("단발 요청: 세계관 내용 포함", qr.messages[0].content.includes("안개바다") && qr.messages[0].content.includes("C-001 인물 서리"));
  await page.click("#ctabResults .q-card [data-q-ask]");
  check("대화로 답하기 → 입력란", (await page.inputValue("#input")).startsWith("질문 카드:"));
  await page.fill("#input", "");

  // ---- 8. 이름 규칙 편집 + 이름 만들기 ----
  await tab("codex");
  await ctab("naming");
  await page.click('[data-act="naming-new"]');
  await page.fill("#n-name", "무등회 별명");
  await page.fill("#n-applies", "무등회");
  await page.fill("#n-rules", "- 그림자, 재 같은 말을 쓴다");
  await page.fill("#n-examples", "재그림자, 잿손");
  await page.click('#namingForm button[type="submit"]');
  await page.waitForTimeout(200);
  check("이름 규칙 2개", (await page.$$("#ctabResults .sense-card")).length === 2);
  const ruleId = await page.getAttribute("#ctabResults .sense-card:nth-child(2) [data-naming-edit]", "data-naming-edit");
  await page.click(`[data-naming-edit="${ruleId}"]`);
  await page.fill("#n-rules", "- 그림자, 재, 잿빛 같은 말을 쓴다");
  await page.click('#namingForm button[type="submit"]');
  await page.waitForTimeout(200);
  check("이름 규칙 편집", (await page.textContent("#ctabResults")).includes("잿빛 같은 말"));
  quick.push("1. 잿바람 | 재가 날리는 바람\n2. 그늘손 | 그림자를 다루는 손\n- 잿눈 | ");
  await page.click(`[data-naming-gen="${ruleId}"]`);
  await page.fill("#g-hint", "별명");
  await page.click('#genForm button[type="submit"]');
  await page.waitForSelector("#genResults .gen-item");
  const names = await page.$$eval("#genResults .gen-item strong", (els) => els.map((e) => e.textContent));
  check("이름 만들기 결과", names.join(",") === "잿바람,그늘손,잿눈", names.join(","));
  check("생성 요청에 규칙·기존 이름", quickReqs[quickReqs.length - 1].body.messages[0].content.includes("잿빛 같은 말") && quickReqs[quickReqs.length - 1].body.messages[0].content.includes("서리"));
  await page.screenshot({ path: `${SHOTS}/72-names.png` });
  await page.click('[data-gen-new="1"]');
  await page.waitForSelector("#entryForm");
  check("새 항목으로 → 이름·설명 채움", (await page.inputValue("#f-name")) === "그늘손" && (await page.inputValue("#f-summary")) === "그림자를 다루는 손");
  await closeSheet();
  // 이름 규칙 지우기
  await page.click(`[data-naming-edit="${ruleId}"]`);
  await page.click('[data-act="naming-delete"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForTimeout(200);
  check("이름 규칙 삭제", (await page.$$("#ctabResults .sense-card")).length === 1);

  // ---- 9. 원고 삭제·이어 쓰기, 사용자 변경 알림 ----
  await ctab("ms");
  await page.click('#ctabResults .ms-card:has-text("등대지기의 노래")');
  await page.click('#sheetBody [data-act="ms-continue"]');
  check("원고 이어 쓰기 → 새 대화 요청", (await page.inputValue("#input")).includes("등대지기의 노래") && (await page.textContent("#threadTitle")) === "");
  await page.fill("#input", "");
  await tab("codex");
  await page.click('#ctabResults .ms-card:has-text("무등회 수배서")');
  await page.click('#sheetBody [data-act="ms-delete"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForTimeout(200);
  check("원고 삭제", (await page.$$("#ctabResults .ms-card")).length === 1);
  const tomb = await idbGet("sync:tombstones");
  check("원고 삭제 기록", Object.keys(tomb.manuscripts || {}).some((k) => k.startsWith(w + ":ms-")));

  // ---- 10. 백업에 원고·그림 포함 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-all"]')]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const bw = backup.worlds.find((x) => x.world.id === w);
  check("백업에 원고·그림", bw.manuscripts.length === 1 && "P-001" in bw.images);

  // ---- 11. 화면 ----
  await tab("codex");
  await ctab("questions");
  await page.screenshot({ path: `${SHOTS}/73-questions.png` });
  for (const k of ["ms", "senses", "questions", "naming", "entries"]) {
    await ctab(k);
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (over) { check(`가로 넘침 없음 (${k})`, false); }
  }
  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await tab("chat");
  const composerFits = await page.evaluate(() => { const r = document.querySelector("#sendBtn").getBoundingClientRect(); return r.right <= window.innerWidth && document.querySelector("#input").getBoundingClientRect().width > 120; });
  check("입력창 버튼 3개여도 들어맞음", composerFits);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(200);
  check("좁은 화면(320px)에서도 입력창", await page.evaluate(() => document.querySelector("#sendBtn").getBoundingClientRect().right <= window.innerWidth && document.querySelector("#input").getBoundingClientRect().width > 80));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
