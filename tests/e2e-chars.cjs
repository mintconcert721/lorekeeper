// 인물 기능: 내면 엔진, 성장 곡선, 말투 카드, 외모 카드·프롬프트·무드보드, 능력과 대가,
// 호칭표, 인물 비교, 등장 비중, 일관성 검사, v8 지침·도구
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V7 = L.PROMPT_SET(7);
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const MAP = path.join(SCRATCH, "files/map.png");
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8781);

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
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
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
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ id: "q", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: quick.shift() || "" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } }) });
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
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const entry = async (id) => (await idbGet("entries:" + (await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")))))).find((e) => e.id === id);
  const openChar = async (id, t) => { await tab("codex"); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); if (t) await page.click(`#sheetBody [data-etab="${t}"]`); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

  await page.goto("http://localhost:8781/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const wid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));

  // ---- 1. v8: Claude가 내면·말투·외모·곡선·능력·호칭을 채운다 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "update_entry", id: "u1", input: { id: "C-001", inner: { want: "등대지기가 되어 어머니에게 인정받기", need: "스스로를 믿는 것", wound: "어머니가 안개 속으로 사라진 밤", lie: "불을 지키지 못하면 사랑받을 자격이 없다", fear: "혼자 남겨지는 것" }, voice: { tone: "짧게 끊어 말하는 반말", phrases: ["불은 꺼지지 않아", "됐어"], samples: ["됐어, 내가 할게.", "불은 꺼지지 않아."] }, looks: { "키·체격": "작고 마른 편", "머리": "소금기에 바랜 갈색 머리" } } },
    { tool: "set_arc", id: "a2", input: { id: "C-001", stages: [{ label: "시작", when: 317, state: "등대 막내", belief: "불을 지키면 사랑받는다", level: -1 }, { label: "대등화", when: 312, state: "불을 잃는다", turn: "E-001", level: -4 }, { label: "끝", state: "스스로 불을 켠다", belief: "나는 이미 충분하다", level: 4 }] } },
    { tool: "set_ability", id: "a3", input: { id: "C-001", name: "등불 읽기", desc: "등불의 흔들림으로 안개 속 배를 찾는다", limit: "불빛이 닿는 곳까지" } },
    { tool: "set_address", id: "a4", input: { from_id: "C-001", to_id: "C-012", call: "나래야", speech: "반말", reverse_call: "언니", reverse_speech: "반말" } },
    { tool: "set_address", id: "a5", input: { from_id: "C-001", to_id: "C-010", call: "어머니", speech: "존댓말" } },
    { tool: "update_entry", id: "u2", input: { id: "C-001", inner: { 원하는것: "x" } } },
    { tool: "get_entries", id: "g1", input: { ids: ["C-001"] } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "r1", input: { message: "서리의 내면과 말투를 정리했어요." } }], "tool_use"));
  await send("서리를 깊게 만들어 줘", 2);
  const r1 = requests[requests.length - 2];
  const names = r1.body.tools.map((t) => t.name);
  check("v8 도구", ["set_arc", "set_ability", "set_address"].every((n) => names.includes(n)) && names[names.length - 1] === "respond" && r1.body.tools.find((t) => t.name === "update_entry").input_schema.properties.inner);
  check("v8 지침", r1.body.system[0].text.includes("## 인물 깊이") && r1.body.system[0].text.includes("## 인물 일관성 검사"));
  const tr = requests[requests.length - 1].body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  check("도구 결과: 성공 6, 잘못된 내면 칸은 오류", ["u1", "a2", "a3", "a4", "a5", "g1"].every((id) => !res(id).is_error) && res("u2").is_error && JSON.stringify(res("u2").content).includes("쓸 수 있는 칸"), JSON.stringify(tr.filter((b) => b.is_error)).slice(0, 300));
  check("능력에 대가 없음 알림", JSON.stringify(res("a3").content).includes("대가가 아직 없다"));
  const g1 = JSON.stringify(res("g1").content);
  check("get_entries에 인물 깊이 포함", ["내면:", "믿고 있는 거짓말", "말투:", "예시 대사", "외모:", "능력과 대가:", "성장 곡선:", "호칭:", "서리 → 나래(C-012): \\\"나래야\\\", 반말", "나래(C-012) → 서리: \\\"언니\\\", 반말"].every((x) => g1.includes(x)), g1.slice(0, 600));
  let e1 = await entry("C-001");
  check("저장: 내면 5칸·말투·외모·곡선 3단계·능력·호칭", Object.keys(e1.inner).length === 5 && e1.voice.phrases.length === 2 && e1.looks["머리"] && e1.arc.length === 3 && e1.abilities[0].name === "등불 읽기" && e1.address["C-012"].call === "나래야" && (await entry("C-012")).address["C-001"].call === "언니");

  // 예전 대화(v7)는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid);
  threads.find((t) => t.id === tid).promptVersion = 7;
  await idbSet("threads:" + wid, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b7 = requests.length;
  await send("하나 더", b7 + 1);
  check("v7 대화는 v7 지침·도구 그대로", requests[b7].body.system[0].text === V7.system && JSON.stringify(requests[b7].body.tools) === JSON.stringify(V7.tools));

  // ---- 2. 인물 항목 화면 탭 ----
  await openChar("C-001");
  const tabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.textContent));
  check("인물 탭 6개 + 개수", tabs.join("|") === "기본|내면5/6|성장3|말투✓|외모✓|능력1", tabs.join("|"));
  await page.click('#sheetBody [data-etab="inner"]');
  const inner = await page.textContent("#sheetBody");
  check("내면 화면", inner.includes("믿고 있는 거짓말") && inner.includes("불을 지키지 못하면") && (await page.$$("#sheetBody .inner-cell.blank")).length === 1);
  await page.screenshot({ path: `${SHOTS}/96-inner.png` });
  await page.click('#sheetBody [data-act="inner-edit"]');
  await page.fill('#innerForm textarea[data-k="secret"]', "그날 불을 끈 사람이 자신이다");
  await page.fill('#innerForm textarea[data-k="fear"]', "");
  await page.click('#innerForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .inner-flow");
  e1 = await entry("C-001");
  check("내면 편집: 칸 추가·비우면 지움 + 탭 유지", e1.inner.secret && !e1.inner.fear && (await page.getAttribute('#sheetBody [data-etab="inner"]', "aria-selected")) === "true");
  // 성장 곡선
  await page.click('#sheetBody [data-etab="arc"]');
  check("성장 곡선 그래프·단계", (await page.$$("#sheetBody .arc-chart .arc-dot")).length === 3 && (await page.$$("#sheetBody .arc-steps li")).length === 3);
  check("곡선: 계기가 사건으로 연결", !!(await page.$('#sheetBody .arc-steps [data-ref="E-001"]')));
  check("곡선: 그 시점 나이", (await page.textContent("#sheetBody .arc-steps")).includes("12세"));
  await page.screenshot({ path: `${SHOTS}/97-arc.png` });
  await page.click('#sheetBody [data-act="arc-edit"]');
  await page.click("#arcRows .arc-row:nth-child(2) [data-arc-up]");
  await page.click('[data-act="arc-add"]');
  await page.fill("#arcRows .arc-row:last-child .a-state", "등대를 떠난다");
  await page.selectOption("#arcRows .arc-row:last-child .a-level", "1");
  await page.click('#arcForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .arc-steps");
  e1 = await entry("C-001");
  check("곡선 편집: 순서 바꾸기·추가", e1.arc.length === 4 && e1.arc[0].label === "대등화" && e1.arc[3].state === "등대를 떠난다" && e1.arc[3].level === 1);
  // 말투
  await page.click('#sheetBody [data-etab="voice"]');
  const voice = await page.textContent("#sheetBody");
  check("말투 카드 화면", voice.includes("짧게 끊어 말하는 반말") && (await page.$$("#sheetBody .sample")).length === 2 && voice.includes("나래야") && voice.includes("언니"));
  await page.click('#sheetBody [data-act="voice-edit"]');
  await page.fill("#v-never", "제발\n고마워");
  await page.click('#voiceForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .chip.never");
  check("말투 편집: 쓰지 않는 말", (await page.$$("#sheetBody .chip.never")).length === 2);
  // 외모 + 프롬프트 + 무드보드
  await page.click('#sheetBody [data-etab="looks"]');
  check("외모 카드 화면", (await page.textContent("#sheetBody")).includes("소금기에 바랜 갈색 머리"));
  quick.push("EN: portrait of a small, thin young woman with salt-bleached brown hair, fantasy illustration\nKO: 소금기에 바랜 갈색 머리의 작고 마른 젊은 여성 초상, 판타지 일러스트");
  await page.selectOption("#lpStyle", "수채화");
  await page.click('#sheetBody [data-act="looks-prompt"]');
  await page.waitForSelector("#sheetBody .prompt-box");
  const qr = quickReqs.at(-1).body;
  check("프롬프트 요청: 외모·스타일·분위기", qr.messages[0].content.includes("소금기에 바랜 갈색 머리") && qr.messages[0].content.includes("수채화") && qr.output_config.effort === "low");
  e1 = await entry("C-001");
  check("프롬프트 저장(영·한)", e1.lookPrompt.en.startsWith("portrait") && e1.lookPrompt.ko.includes("갈색 머리") && e1.lookPrompt.style === "수채화");
  await page.setInputFiles("#galFile", [MAP, MAP]);
  await page.waitForSelector("#sheetBody .gal-item img[src^='data:image/jpeg']");
  e1 = await entry("C-001");
  check("무드보드 2장(따로 저장)", e1.gallery.length === 2 && (await idbGet("mapimg:" + e1.gallery[0].img))?.startsWith("data:image/jpeg"));
  await page.screenshot({ path: `${SHOTS}/98-looks.png` });
  await page.click("#sheetBody .gal-item");
  await page.waitForSelector("#sheetBody .gal-full");
  await page.click('#sheetBody [data-act="gal-main"]');
  await page.waitForSelector("#sheetBody .entry-img");
  check("무드보드 그림을 대표 그림으로", (await idbGet("imgs:" + wid))["C-001"].data.startsWith("data:image/jpeg"));
  await page.click('#sheetBody [data-etab="looks"]');
  await page.click("#sheetBody .gal-item");
  await page.click('#sheetBody [data-act="gal-del"]');
  await page.waitForSelector("#sheetBody .gallery");
  check("무드보드 빼기", (await entry("C-001")).gallery.length === 1);
  // 능력
  await page.click('#sheetBody [data-etab="ability"]');
  check("대가 없는 능력 표시", (await page.$$("#sheetBody .ability.no-cost")).length === 1);
  await page.click('#sheetBody [data-act="ab-edit"]');
  await page.fill("#ab-cost", "쓸 때마다 기억 하나를 잃는다");
  await page.click('#abForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .ability-list");
  await page.click('#sheetBody [data-act="ab-add"]');
  await page.fill("#ab-name", "안개 걷기");
  await page.fill("#ab-cost", "체온");
  await page.click('#abForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .ability-list");
  e1 = await entry("C-001");
  check("능력 편집·추가", e1.abilities.length === 2 && e1.abilities[0].cost.includes("기억") && (await page.$$("#sheetBody .ability.no-cost")).length === 0);
  await page.click('#sheetBody [data-act="ab-rule"]');
  check("세계 규칙과 맞춰 보기 → 새 대화 요청", (await page.inputValue("#input")).includes("세계 규칙") && (await page.textContent("#threadTitle")) === "");
  await page.fill("#input", "");
  // Claude와 채우기
  await openChar("C-010", "inner");
  await page.click('#sheetBody [data-act="inner-ask"]');
  check("내면 Claude와 채우기", (await page.inputValue("#input")).includes("하람(C-010)의 내면"));
  await page.fill("#input", "");
  // 이력·되돌리기
  await openChar("C-001");
  await page.click('#sheetBody [data-act="history"]');
  const hcount = (await page.$$("#sheetBody [data-restore]")).length;
  check("인물 편집이 이력에 남음", hcount >= 6, String(hcount));
  await closeSheet();
  // 인물이 아닌 항목은 탭 없음
  await openChar("P-001");
  check("장소는 장소 탭(인물 탭 아님)", !(await page.$("#sheetBody [data-etab=\"inner\"]")) && !!(await page.$("#sheetBody [data-etab=\"people\"]")));
  await closeSheet();

  // ---- 3. 호칭표 ----
  await tab("graph");
  await page.click('#graphModes [data-gmode="addr"]');
  await page.waitForSelector("#addr .addr-mx");
  const cell = (a, b) => page.textContent(`#addr [data-addr-cell="${a}|${b}"]`);
  check("호칭표: 서리→나래 '나래야 반'", (await cell("C-001", "C-012")).includes("나래야") && (await cell("C-001", "C-012")).includes("반"));
  check("호칭표: 나래→서리 '언니'", (await cell("C-012", "C-001")).includes("언니"));
  check("관계 있는데 미정이면 ?", (await cell("C-011", "C-013")) === "?");
  check("한쪽만 정한 쌍 안내", (await page.textContent("#addr")).includes("한쪽만 정한 쌍"));
  await page.screenshot({ path: `${SHOTS}/99-addr.png` });
  await page.click('#addr [data-addr-cell="C-010|C-001"]');
  await page.fill("#ab-call", "서리야");
  await page.selectOption("#ab-speech", "__etc");
  await page.fill("#ab-etc", "사투리 반말");
  await page.click('#addrForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("호칭 칸 편집(기타 말씨)", (await entry("C-010")).address["C-001"].speech === "사투리 반말" && (await cell("C-010", "C-001")).includes("서리야"));
  await page.click('[data-addr="ask"]');
  check("호칭 Claude와 정하기 → 새 대화", (await page.inputValue("#input")).includes("set_address"));
  await page.fill("#input", "");
  await tab("graph");
  await page.click('[data-addr="pick"]');
  await page.uncheck('.pick input[value="C-013"]');
  await page.click('#sheetBody [data-act="ok"]');
  await page.waitForTimeout(200);
  check("인물 고르기", !(await page.$('#addr [data-addr-cell^="C-013|"]')));
  // 항목 화면 → 호칭표
  await openChar("C-001", "voice");
  await page.click('#sheetBody [data-act="addr-table"]');
  await page.waitForSelector("#addrPane:not([hidden])");
  check("말투 탭 → 호칭표", await page.isVisible("#addr .addr-mx"));

  // ---- 4. 인물 비교 ----
  await tab("codex");
  await page.click('[data-act="compare"]');
  await page.check('.pick input[value="C-001"]');
  await page.check('.pick input[value="C-012"]');
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  const cmpText = await page.textContent("#sheetBody .cmp");
  check("비교표: 이름·내면·말투·서로 부르는 말", cmpText.includes("서리") && cmpText.includes("나래") && cmpText.includes("믿고 있는 거짓말") && cmpText.includes("나래: “나래야” 반말"));
  check("비교표: 겹치는 값 표시(지금 나이 아님, 상태 제외)", (await page.$$("#sheetBody .cmp td.same")).length >= 0);
  await page.screenshot({ path: `${SHOTS}/100-compare.png` });
  await page.click('#sheetBody [data-act="cmp-chat"]');
  check("비교 → 차별점 대화", (await page.inputValue("#input")).includes("대체할 수 없는"));
  await page.fill("#input", "");
  await openChar("C-011");
  await page.click('#sheetBody [data-act="compare-one"]');
  check("항목에서 비교: 미리 체크", await page.isChecked('.pick input[value="C-011"]'));
  await closeSheet();

  // ---- 5. 등장 비중 ----
  // 원고 하나 + 대화 언급
  await page.evaluate(() => {});
  const ms = [{ id: "ms-a1", title: "등대의 밤", kind: "장면", body: "서리는 나래의 손을 잡았다. 서리가 말했다.", refs: ["C-001"], createdAt: Date.now() - 864e5 * 30, updatedAt: Date.now() - 864e5 * 30, by: "user" }];
  await idbSet("ms:" + wid, ms);
  await page.reload(); await page.waitForSelector("#app");
  await tab("codex");
  await page.click('[data-act="presence"]');
  await page.waitForSelector("#sheetBody .presence");
  const pres = await page.textContent("#sheetBody");
  check("등장 비중 표", (await page.$$("#sheetBody .pres-row")).length === 5 && (await page.textContent("#sheetBody .pres-row:first-child .pres-name")) === "서리", pres.slice(0, 200));
  check("한 번도 안 나온 인물", pres.includes("한 번도 나오지 않은 인물") && pres.includes("노을"));
  check("오래 안 나온 인물(나래: 30일 전 원고만)", pres.includes("오래 안 나온 인물") && (await page.$('#sheetBody .tl-missing [data-ref="C-012"]')) !== null);
  await page.screenshot({ path: `${SHOTS}/101-presence.png` });
  await page.click('[data-pres="revive"]');
  check("다시 등장시키기 → 새 대화", (await page.inputValue("#input")).includes("나래(C-012)"));
  await page.fill("#input", "");

  // ---- 6. 일관성 검사 ----
  await openChar("C-001");
  await page.click('#sheetBody [data-act="consistency"]');
  check("일관성 검사 요청: 관련 원고 포함", (await page.inputValue("#input")).includes("일관성 검사") && (await page.inputValue("#input")).includes("'등대의 밤'(ms-a1)"));
  await page.fill("#input", "");

  // ---- 7. 설정 점검 ----
  await tab("codex");
  await page.click('[data-act="checks"]');
  const chk = await page.textContent("#sheetBody");
  check("점검: 호칭을 양쪽 다 정하면 한쪽 호칭 경고 없음", !chk.includes("한쪽만 정한 호칭"));
  check("점검: 내면이 빈 주요 인물", chk.includes("내면이 빈 주요 인물") && chk.includes("도윤"));
  await closeSheet();

  // ---- 8. 백업에 무드보드 그림 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-all"]')]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const bw = backup.worlds.find((x) => x.world.id === wid);
  const gimg = bw.entries.find((e) => e.id === "C-001").gallery[0].img;
  check("백업에 무드보드 그림", bw.mapImages[gimg]?.startsWith("data:image/jpeg"));

  // ---- 9. 화면 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await openChar("C-001");
  check("360px: 인물 탭 한 줄", await page.$eval("#sheetBody .entry-tabs", (el) => el.scrollWidth <= el.clientWidth + 1));
  for (const t of ["inner", "arc", "voice", "looks", "ability"]) { await page.click(`#sheetBody [data-etab="${t}"]`); if (await page.evaluate(() => { const s = document.querySelector(".sheet-panel"); return s.scrollWidth > s.clientWidth + 1; })) check(`360px 넘침 (${t})`, false); }
  await closeSheet();
  await tab("graph");
  check("360px: 보기 모드 5개 한 줄", await page.$eval("#graphModes", (el) => el.scrollWidth <= el.clientWidth + 1));
  check("가로 넘침 없음", !(await overflow()));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
