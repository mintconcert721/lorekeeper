// 장소·마법: 장소 계층, 장소 카드 탭, 일어난 일, 이동 시간, 지도 영역, 기후·날씨, 장소 생성기,
// 마법 체계 카드, 주문서, 규칙 판정, 허점 질문, 유물 이력, v9 지침·도구
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V8 = L.PROMPT_SET(8);
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const MAP = path.join(SCRATCH, "files/map.png");
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8782);

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
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const entry = async (id) => (await idbGet("entries:" + (await wid()))).find((e) => e.id === id);
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const openE = async (id, t) => { await tab("codex"); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); if (t) await page.click(`#sheetBody [data-etab="${t}"]`); };
  const sheetText = () => page.textContent("#sheetBody");

  await page.goto("http://localhost:8782/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const wid0 = await wid();

  // ---- 1. v9: Claude가 장소·마법·유물을 채운다 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "create_entry", id: "c1", input: { type: "장소", name: "서쪽 섬", summary: "안개바다 서쪽의 큰 섬", climate: { climate: "서늘한 해양성", seasons: { 겨울: "안개가 걷히지 않는다" } } } },
    { tool: "update_entry", id: "u1", input: { id: "P-001", parent: "P-002", place: { population: "등대지기 셋", language: "옛 등대말", danger: "밤마다 밀려드는 안개" } } },
    { tool: "create_entry", id: "c2", input: { type: "장소", name: "소금 시장", summary: "섬 동쪽 항구 시장", parent: "P-002" } },
    { tool: "update_entry", id: "u2", input: { id: "P-002", parent: "P-001" } },
    { tool: "set_rumor", id: "r1", input: { id: "P-001", text: "등대 지하에 꺼진 첫 불이 잠들어 있다" } },
    { tool: "set_travel", id: "t1", input: { unit: "리", modes: [{ name: "도보", speed: 80 }, { name: "배", speed: 200 }] } },
    { tool: "set_route", id: "t2", input: { from_id: "P-001", to_id: "P-003", distance: 40, terrain: "해안 절벽길" } },
    { tool: "set_route", id: "t3", input: { from_id: "P-003", to_id: "P-002", distance: 120, modes: ["배"] } },
    { tool: "set_route", id: "t4", input: { from_id: "P-003", to_id: "P-002", modes: ["비룡"] } },
    { tool: "get_travel", id: "t5", input: { from_id: "P-001", to_id: "P-002" } },
    { tool: "update_entry", id: "u3", input: { id: "K-001", magic: { source: "등대의 불", cost: "기억 하나" } } },
    { tool: "set_spell", id: "s1", input: { id: "K-001", name: "등불 읽기", tier: "1등급", effect: "안개 속 배를 찾는다", cost: "사소한 기억" } },
    { tool: "set_spell", id: "s2", input: { id: "K-001", name: "불의 맹세", tier: "3등급", effect: "등대 불을 되살린다" } },
    { tool: "create_entry", id: "c3", input: { type: "사물", name: "첫 등불", summary: "처음 켜진 등대의 불씨를 담은 등" } },
    { tool: "set_artifact", id: "a1", input: { id: "I-001", maker: "C-013", made: 250, owners: [{ who: "C-013", from: 250, to: 301 }, { who: "C-011", from: 270, to: 330, how: "스승에게 물려받음" }], location: "P-001", holder: "C-001", seal: "잠듦" } },
    { tool: "get_entries", id: "g1", input: { ids: ["P-001", "K-001", "I-001"] } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "섬과 등대, 마법 체계를 정리했어요." } }], "tool_use"));
  await send("섬을 정리해 줘", 2);
  const r1 = requests.at(-2);
  const tn = r1.body.tools.map((t) => t.name);
  check("v9 도구", ["set_rumor", "set_route", "set_travel", "get_travel", "set_spell", "set_artifact"].every((n) => tn.includes(n)) && tn.at(-1) === "respond" && r1.body.tools.find((t) => t.name === "update_entry").input_schema.properties.magic);
  check("v9 지침", r1.body.system[0].text.includes("## 장소") && r1.body.system[0].text.includes("## 마법과 유물"));
  check("첫 메시지: 이동 수단", requests.at(-2).body.messages[0].content.map((b) => b.text || "").join("").includes("이동: 거리 단위 km, 도보 하루 30km"));
  const tr = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("도구 결과: 계층 순환 거부", res("u2").is_error && txt("u2").includes("하위 장소라 상위로 둘 수 없습니다"));
  check("도구 결과: 없는 이동 수단 거부", res("t4").is_error && txt("t4").includes("없는 이동 수단"));
  check("도구 결과: 나머지 성공", ["c1", "u1", "c2", "r1", "t1", "t2", "t3", "t5", "u3", "s1", "s2", "c3", "a1", "g1"].every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error).map((b) => b.tool_use_id)));
  check("get_travel: 도보·배 경로", txt("t5").includes("도보: 이어진 길 없음") && txt("t5").includes("배: 160리") && txt("t5").includes("잿빛 첨탑 등대 → 소금 시장 → 서쪽 섬"), txt("t5"));
  check("주문 대가 없음 알림", txt("s2").includes("대가가 아직 없다"));
  check("유물 경고(태어나기 전 소유)", txt("a1").includes("확인할 점") && txt("a1").includes("도윤은(는) 276년에 태어났는데 270년부터"), txt("a1"));
  const g1 = txt("g1");
  check("get_entries에 장소·마법·유물", ["위치: 서쪽 섬 › 잿빛 첨탑 등대", "장소 카드:", "옛 등대말", "소문:", "[모름] 등대 지하", "길:", "소금 시장(P-003) 40리", "마법 체계 카드:", "주문서:", "등불 읽기 [1등급]", "유물 이력:", "만든 이: 노을(C-013), 250년", "봉인: 잠듦"].every((x) => g1.includes(x)), g1.slice(0, 900));
  // v8 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 8;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b8 = requests.length;
  await send("하나 더", b8 + 1);
  check("v8 대화는 v8 지침·도구 그대로", requests[b8].body.system[0].text === V8.system && JSON.stringify(requests[b8].body.tools) === JSON.stringify(V8.tools));

  // ---- 2. 장소 탭 ----
  await openE("P-001");
  const ptabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.textContent));
  check("장소 탭 6개", ptabs.join("|") === "기본|사람들2|경제1|소문1|기후|일어난 일", ptabs.join("|"));
  check("기본: 위치 경로·길", (await page.textContent("#sheetBody .crumbs")).includes("서쪽 섬") && (await sheetText()).includes("해안 절벽길"));
  await page.click('#sheetBody [data-etab="people"]');
  await page.click('#sheetBody [data-act="place-edit-people"]');
  await page.fill('#placeForm textarea[data-k="ruler"]', "등대장 도윤");
  await page.click('#placeForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .fields");
  check("사람들 편집(다른 칸 유지)", (await entry("P-001")).place.ruler === "등대장 도윤" && (await entry("P-001")).place.danger === "밤마다 밀려드는 안개");
  await page.click('#sheetBody [data-etab="rumor"]');
  await page.click('#sheetBody [data-act="rumor-edit"]');
  await page.click('#rumorForm input[value="참"]', { force: true });
  await page.fill("#ru-note", "노을이 묻었다");
  await page.click('#rumorForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .rumor");
  check("소문 진실 표시", (await page.textContent("#sheetBody .rumor .truth")) === "참" && (await entry("P-001")).rumors[0].note === "노을이 묻었다");
  await page.click('#sheetBody [data-etab="climate"]');
  await page.click('#sheetBody [data-act="climate-edit"]');
  await page.fill("#cl-climate", "짠 바람이 부는 서늘한 해안");
  await page.fill('#climateForm input[data-season="겨울"]', "바다가 얼지 않지만 안개가 짙다");
  await page.fill("#cl-seasons", "봄, 여름, 가을, 겨울, 안개철");
  await page.click('#climateForm button[type="submit"]');
  await page.waitForSelector('#sheetBody #wxSeason');
  check("기후 편집 + 세계 계절", (await entry("P-001")).climate.seasons["겨울"].includes("안개") && (await world()).seasons.includes("안개철") && (await page.$$('#wxSeason option')).length === 5);
  quick.push("겨울 새벽, 등대 아래로 안개가 소금기를 머금고 기어오른다.");
  await page.selectOption("#wxSeason", "겨울");
  await page.click('#sheetBody [data-act="weather"]');
  await page.waitForSelector("#wxOut .prompt-box");
  check("그날 날씨 만들기", (await page.textContent("#wxOut")).includes("소금기를 머금고") && quickReqs.at(-1).body.messages[0].content.includes("겨울: 바다가 얼지 않지만"));
  await page.click('#wxOut [data-wx="save"]');
  await page.waitForTimeout(150);
  check("날씨를 원고함에", (await idbGet("ms:" + wid0)).some((m) => m.title.includes("겨울") && m.refs.includes("P-001")));
  await page.click('#sheetBody [data-etab="happened"]');
  const hap = await sheetText();
  check("일어난 일: 인물·유물·원고", hap.includes("서리") && hap.includes("첫 등불") && hap.includes("이 장소가 나오는 원고"), hap.slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/102-place.png` });
  await closeSheet();
  await openE("P-002", "happened");
  check("상위 장소에서 하위 포함", (await sheetText()).includes("하위 장소 2곳 포함") && (await sheetText()).includes("첫 등불"));
  await page.click('#sheetBody [data-act="happened-kids"]');
  await page.waitForTimeout(150);
  check("하위 장소 빼기", !(await sheetText()).includes("첫 등불"));
  await closeSheet();
  // 계층 트리, 편집기의 상위 장소
  await tab("codex");
  await page.click('[data-act="place-tree"]');
  const tree = await page.textContent("#sheetBody .ptree");
  check("장소 계층 트리", tree.includes("서쪽 섬") && tree.includes("잿빛 첨탑 등대") && tree.includes("소금 시장"));
  await closeSheet();
  await openE("P-002");
  await page.click('#sheetBody [data-act="edit"]');
  const opts = await page.$$eval("#f-parent option", (els) => els.map((x) => x.value));
  check("편집기: 하위 장소는 상위 후보에서 빠짐", !opts.includes("P-001") && !opts.includes("P-003") && !opts.includes("P-002"));
  await closeSheet();

  // ---- 3. 이동 시간 ----
  await tab("codex");
  await page.click('[data-act="travel"]');
  await page.selectOption("#tr-from", "P-001");
  await page.selectOption("#tr-to", "P-002");
  await page.click('[data-tr="calc"]');
  const calc = await page.textContent("#trOut");
  check("이동 시간 계산(하루 미만은 시간으로)", calc.includes("배 약 19시간") && calc.includes("160리") && calc.includes("이어진 길 없음"), calc);
  await page.click('[data-tr="add"]');
  await page.selectOption("#ro-a", "P-001");
  await page.selectOption("#ro-b", "P-002");
  await page.fill("#ro-dist", "300");
  await page.fill("#ro-terrain", "산 넘는 길");
  await page.click('#routeForm button[type="submit"]');
  await page.waitForSelector("#tr-from");
  await page.selectOption("#tr-from", "P-001");
  await page.selectOption("#tr-to", "P-002");
  await page.click('[data-tr="calc"]');
  check("길 추가 → 도보도 계산", (await page.textContent("#trOut")).includes("도보 약 3.8일"), await page.textContent("#trOut"));
  await page.fill("#modeRows .mode-row:first-child .ms", "100");
  await page.click('#modeForm button[type="submit"]');
  await page.waitForSelector("#tr-from");
  check("이동 수단 저장", (await world()).travel.modes[0].speed === 100);
  await closeSheet();
  // 너무 빠른 이동: 서리가 대등화(312, 등대)와 안개 전쟁(소금 시장) 사이를 짧게
  const ents = await idbGet("entries:" + wid0);
  ents.find((e) => e.id === "E-001").relations.push({ to: "P-001", label: "장소" });
  ents.find((e) => e.id === "E-002").relations.push({ to: "P-002", label: "장소" });
  ents.find((e) => e.id === "E-002").when = { start: 312.002, end: null, label: "" };
  ents.find((e) => e.id === "C-001").relations.push({ to: "E-001", label: "목격" }, { to: "E-002", label: "참전" });
  await idbSet("entries:" + wid0, ents);
  await page.reload(); await page.waitForSelector("#app");
  await tab("codex");
  await page.click('[data-act="checks"]');
  const chk = await sheetText();
  check("점검: 너무 빠른 이동", chk.includes("너무 빠른 이동") && chk.includes("서리: 대등화(잿빛 첨탑 등대) → 안개 전쟁(서쪽 섬)"), chk.slice(0, 400));
  check("점검: 유물 이력·대가 없는 주문·마법 빈 칸", chk.includes("유물 이력 확인") && chk.includes("대가 없는 주문") && chk.includes("마법 체계 빈 칸"));
  await closeSheet();

  // ---- 4. 지도: 영역과 길 ----
  await tab("graph");
  await page.click('#graphModes [data-gmode="map"]');
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click('#mapEmpty [data-map="upload"]')]);
  await fc.setFiles(MAP);
  await page.waitForSelector("#mapVp:not([hidden])");
  const vb = await page.$eval("#mapVp", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const pinAt = async (ref, fx, fy) => { await page.click('[data-map="add"]'); await page.mouse.click(vb.x + vb.w * fx, vb.y + vb.h * fy); await page.waitForSelector(`#pinList [data-ref="${ref}"]`); await page.click(`#pinList [data-ref="${ref}"]`); await page.waitForSelector(`.map-pin[data-pin="${ref}"]`); };
  await pinAt("P-001", 0.2, 0.3);
  await pinAt("P-003", 0.6, 0.4);
  check("지도에 길 선", (await page.$$("#mapOverlay .route line")).length === 1 && (await page.textContent("#mapOverlay .route text")) === "40리");
  await page.click('[data-map="region"]');
  for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.1], [0.5, 0.6], [0.1, 0.6]]) await page.mouse.click(vb.x + vb.w * fx, vb.y + vb.h * fy);
  check("영역 그리기: 꼭짓점 4개", (await page.textContent("#mapHint")).includes("4개") && (await page.$$("#mapOverlay .region-draft circle")).length === 4);
  await page.click('[data-map="region-done"]');
  await page.selectOption("#rg-ref", "F-001");
  await page.fill("#rg-from", "300");
  await page.fill("#rg-to", "315");
  await page.click('#regionForm button[type="submit"]');
  await page.waitForSelector("#mapOverlay .region polygon");
  let maps = await idbGet("maps:" + wid0);
  check("영역 저장", maps[0].regions.length === 1 && maps[0].regions[0].ref === "F-001" && maps[0].regions[0].points.length === 4 && maps[0].regions[0].to === 315);
  check("영역 카드", (await page.textContent("#mapCard")).includes("무등회"));
  await page.screenshot({ path: `${SHOTS}/103-regions.png` });
  check("연도 슬라이더", await page.isVisible("#mapYear"));
  await page.$eval("#mapYear", (el) => { el.value = "320"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(150);
  check("320년엔 영역이 사라짐", (await page.$$("#mapOverlay .region")).length === 0 && (await page.textContent("#mapYearLabel")).includes("320"));
  await page.click('[data-map="year-all"]');
  await page.waitForTimeout(100);
  check("모든 시기로 되돌리기", (await page.$$("#mapOverlay .region")).length === 1);
  const vb2 = await page.$eval("#mapVp", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(vb2.x + vb2.w * 0.9, vb2.y + vb2.h * 0.9);
  await page.waitForTimeout(100);
  await page.mouse.click(vb2.x + vb2.w * 0.3, vb2.y + vb2.h * 0.5);
  await page.waitForTimeout(100);
  check("영역 눌러 고르기", (await page.textContent("#mapCard")).includes("무등회"));
  // 새 대화 첫 메시지에 영역
  await page.click('[data-map="travel"]');
  check("지도에서 길 시트", await page.isVisible("#tr-from"));
  await closeSheet();
  await tab("chat");
  await page.click("#newThreadBtn");
  const bR = requests.length;
  await send("지도 이야기", bR + 1);
  const first = requests[bR].body.messages[0].content.map((b) => b.text || "").join("");
  check("첫 메시지: 지도 영역·이동", first.includes("지도 영역:") && first.includes("무등회(F-001) 서쪽 일대 (300~315)") && first.includes("도보 하루 100리") && first.includes("길 3개"), first.split("\n").filter((l) => /영역|이동|무등회/.test(l)).join(" / "));

  // ---- 5. 장소 생성기 ----
  await page.click("#toolsBtn");
  await page.click('#sheetBody details.ct:has(summary:text("장소 생성기")) summary');
  await page.selectOption("#pg-kind", "여관");
  await page.selectOption("#pg-parent", "P-002");
  quick.push(JSON.stringify({ name: "물안개 여관", summary: "항구 뒤편 낡은 여관", place: { population: "투숙객 열댓", residents: "선원과 밀수꾼", language: "섬말", ruler: "여주인 해담", goods: "소금 절인 생선", trade: "밀수품", prices: "조개껍데기 화폐", work: "숙박", danger: "밤마다 사라지는 손님" }, senses: { sound: "삐걱이는 계단", smell: "젖은 밧줄", light: "기름등", touch: "축축한 벽", taste: "짠 국" }, rumors: [{ text: "지하에 밀수 통로가 있다", truth: "참" }, { text: "여주인은 마녀다", truth: "모름" }], hook: "사라진 손님의 방에 등대의 열쇠가 남아 있다." }));
  await page.click('[data-ct="placegen"]');
  await page.waitForSelector("#pgOut .gen-place");
  const gq = quickReqs.at(-1).body;
  check("생성 요청: 스키마·상위 장소·기존 장소", gq.output_config.format?.type === "json_schema" && gq.output_config.effort === "medium" && gq.messages[0].content.includes("이 장소가 속할 곳: 서쪽 섬") && gq.messages[0].content.includes("소금 시장"));
  check("생성 미리보기", (await page.textContent("#pgOut")).includes("물안개 여관") && (await page.textContent("#pgOut")).includes("지하에 밀수 통로"));
  await page.click('[data-ct="placegen-save"]');
  await page.waitForSelector("#sheetBody .entry-name");
  const inn = (await idbGet("entries:" + wid0)).find((e) => e.name === "물안개 여관");
  check("생성 장소 저장(초안·상위·카드·감각·소문)", inn && inn.status === "draft" && inn.parent === "P-002" && inn.place.ruler === "여주인 해담" && inn.senses["냄새"] === "젖은 밧줄" && inn.rumors.length === 2 && inn.body.includes("이야기 고리"));
  await closeSheet();

  // ---- 6. 마법 체계 ----
  await openE("K-001");
  const mtabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.textContent));
  check("마법 탭 5개", mtabs.join("|") === "기본|체계2/8|주문서2|판정|허점", mtabs.join("|"));
  await page.click('#sheetBody [data-etab="system"]');
  check("체계 카드: 한계 빈 칸 강조", (await page.$$("#sheetBody .inner-cell.key.blank")).length === 1);
  await page.click('#sheetBody [data-act="magic-edit"]');
  await page.fill('#magicForm textarea[data-k="limit"]', "불빛이 닿는 곳까지");
  await page.click('#magicForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .magic-grid");
  check("체계 편집", (await entry("K-001")).magic.limit === "불빛이 닿는 곳까지" && (await entry("K-001")).magic.source === "등대의 불");
  await page.click('#sheetBody [data-etab="spells"]');
  check("주문서: 등급 필터", (await page.$$('#sheetBody [data-act="spell-tier"]')).length === 3 && (await page.$$("#sheetBody .spell.no-cost")).length === 1);
  await page.click('#sheetBody [data-act="spell-tier"][data-tier="3등급"]');
  check("등급 거르기", (await page.$$("#sheetBody .spell")).length === 1);
  await page.click("#sheetBody .spell");
  await page.fill('#spellForm input[data-k="cost"]', "등대지기의 이름");
  await page.click('#spellForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .spell-list");
  check("주문 대가 넣기", (await page.$$("#sheetBody .spell.no-cost")).length === 0);
  // 판정
  await page.click('#sheetBody [data-etab="ruling"]');
  await page.fill("#ruSituation", "서리가 안개 너머 30리 밖 배를 찾을 수 있나?");
  await page.fill("#ruWho", "서리");
  quick.push(JSON.stringify({ verdict: "조건부 가능", reason: "한계: 불빛이 닿는 곳까지", cost: "사소한 기억", conditions: "등대 불이 켜져 있을 때", consequence: "서리는 그날 아침을 잊는다" }));
  await page.click('#sheetBody [data-act="ruling-ask"]');
  await page.waitForSelector("#ruOut .ruling");
  const rq = quickReqs.at(-1).body;
  check("판정 요청: 체계·주문·관련 인물", rq.output_config.format.schema.properties.verdict.enum.length === 3 && rq.messages[0].content.includes("한계: 불빛이 닿는 곳까지") && rq.messages[0].content.includes("등불 읽기") && rq.messages[0].content.includes("## C-001"));
  check("판정 결과", (await page.textContent("#ruOut .verdict")) === "조건부 가능");
  await page.click('#sheetBody [data-act="ruling-save"]');
  await page.waitForSelector("#sheetBody .ruling-list");
  check("판례 저장", (await entry("K-001")).rulings.length === 1);
  // 허점
  await page.click('#sheetBody [data-etab="holes"]');
  quick.push(JSON.stringify({ holes: [{ question: "기억으로 불을 켤 수 있다면 왜 등대마다 마법사를 두지 않지?", why: "대가만 치르면 누구나 쓸 수 있어 보인다" }, { question: "잊힌 기억은 어디로 가지?", why: "대가의 행방이 정해지지 않았다" }] }));
  await page.click('#sheetBody [data-act="holes-find"]');
  await page.waitForSelector("#sheetBody .hole");
  check("허점 카드 2장", (await page.$$("#sheetBody .hole")).length === 2 && quickReqs.at(-1).body.messages[0].content.includes("판례:"));
  await page.click('#sheetBody .hole:first-child [data-act="hole-done"]');
  await page.waitForSelector("#sheetBody details.tl-missing");
  check("허점 해결 처리", (await entry("K-001")).holes.filter((h) => h.status === "done").length === 1 && (await page.$$("#sheetBody .q-cards > .hole:not(.closed)")).length === 1);
  await page.screenshot({ path: `${SHOTS}/104-magic.png` });
  await page.click('#sheetBody .hole:not(.closed) [data-act="hole-chat"]');
  check("허점 대화로 메우기", (await page.inputValue("#input")).includes("잊힌 기억은 어디로"));
  await page.fill("#input", "");
  // 판례가 Claude에게 간다
  await page.click("#newThreadBtn");
  queue.push(() => msg("m1", [{ tool: "get_entries", id: "gm", input: { ids: ["K-001"] } }], "tool_use"));
  const bm = requests.length;
  await send("판례 확인", bm + 2);
  const gm = JSON.stringify(requests[bm + 1].body.messages.at(-1).content);
  check("get_entries에 판례", gm.includes("판례(따라야 할 규칙 판정)") && gm.includes("조건부 가능"));
  // 마법 체계로 쓰기(개념 항목)
  await openE("K-001");
  check("이미 마법이면 켜기 단추 없음", !(await page.$('#sheetBody [data-act="magic-on"]')));
  await closeSheet();

  // ---- 7. 유물 이력 ----
  await openE("I-001", "history");
  check("유물: 봉인·소유 이력·경고", (await sheetText()).includes("잠듦") && (await page.$$("#sheetBody .arc-steps li")).length === 4 && (await sheetText()).includes("태어났는데"));
  await page.click('#sheetBody [data-act="art-edit"]');
  await page.fill("#ownerRows .owner-row:nth-child(2) .o-from", "290");
  await page.fill("#ownerRows .owner-row:nth-child(2) .o-to", "320");
  await page.click('[data-act="owner-add"]');
  await page.fill("#ownerRows .owner-row:last-child .o-who", "서리");
  await page.fill("#ownerRows .owner-row:last-child .o-from", "320");
  await page.fill("#ownerRows .owner-row:last-child .o-how", "아버지에게 받음");
  await page.selectOption("#ar-seal", "깨어남");
  await page.click('#artForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .arc-steps");
  const art = (await entry("I-001")).artifact;
  check("유물 편집: 이름 → 번호, 경고 해소", art.owners.length === 3 && art.owners[2].who === "C-001" && art.seal === "깨어남" && !(await sheetText()).includes("태어났는데"));
  await page.click('#sheetBody [data-act="art-map"]');
  await page.waitForSelector("#mapPane:not([hidden])");
  check("유물 위치를 지도에서", await page.$eval('.map-pin[data-pin="P-001"]', (el) => el.classList.contains("sel")));

  // ---- 8. 동기화용 백업·화면 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-all"]')]);
  const bw = JSON.parse(fs.readFileSync(await dl.path(), "utf8")).worlds.find((x) => x.world.id === wid0);
  check("백업에 길·이동 수단·영역", bw.world.routes.length === 3 && bw.world.travel.unit === "리" && bw.maps[0].regions.length === 1);
  await page.setViewportSize({ width: 360, height: 760 });
  await openE("P-001");
  check("360px: 장소 탭", await page.$eval("#sheetBody .entry-tabs", (el) => el.scrollWidth <= el.clientWidth + 1));
  await closeSheet();
  await openE("K-001");
  check("360px: 마법 탭", await page.$eval("#sheetBody .entry-tabs", (el) => el.scrollWidth <= el.clientWidth + 1));
  await closeSheet();
  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
