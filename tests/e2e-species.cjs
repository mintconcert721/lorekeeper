// 종족·세력: v10 지침·도구, 종족 카드 탭, 수명·나이 환산, 특성 물려받기, 언어 스케치, 분포·구성표,
// 혼혈표, 연도별 관계표, 관계 기간 편집, 직위 사다리, 분류별 비교, 설정 점검
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V9 = L.PROMPT_SET(9);
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8783);

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
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); if (await page.isVisible("#sheet")) { await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); } await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const gmode = async (m) => { await tab("graph"); await page.click(`#graphModes [data-gmode="${m}"]`); await page.waitForTimeout(150); };
  const closeSheet = async () => { if (await page.isVisible("#sheet")) await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); };
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const entry = async (id) => (await idbGet("entries:" + (await wid()))).find((e) => e.id === id);
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const openE = async (id, t) => { await tab("codex"); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); if (t) await page.click(`#sheetBody [data-etab="${t}"]`); };
  const sheetText = () => page.textContent("#sheetBody");
  const toastText = async () => { await page.waitForTimeout(150); return page.evaluate(() => document.querySelector("#toast")?.textContent || ""); };

  await page.goto("http://localhost:8783/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const wid0 = await wid();

  // ---- 1. v10: Claude가 종족·세력을 채운다 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "create_entry", id: "c1", input: { type: "종족", name: "인간", summary: "섬마다 흩어져 사는 짧은 수명의 종족", life: { lifespan: 80, stages: [{ name: "유년", from: 0 }, { name: "성년", from: 18 }, { name: "노년", from: 60 }] } } },
    { tool: "create_entry", id: "c2", input: { type: "종족", name: "안개엘프", summary: "안개 속에서 태어나는 오래 사는 종족", life: { lifespan: 600, stages: [{ name: "유년", from: 0 }, { name: "성년", from: 100 }, { name: "노년", from: 450 }] }, species: { body: "창백한 피부와 회색 눈", diet: "안개 이슬", family: "세 세대가 한 탑에 산다" } } },
    { tool: "update_entry", id: "u1", input: { id: "C-011", species_id: "S-002", species_note: "다른 엘프보다 일찍 늙었다" } },
    { tool: "update_entry", id: "u2", input: { id: "C-012", summary: "바뀌면 안 되는 요약", species_id: "F-001" } },
    { tool: "set_language", id: "l1", input: { id: "S-002", sounds: "받침이 거의 없고 ㄹ 소리가 많다", words: [{ word: "엘라", meaning: "안개" }, { word: "수인", meaning: "감사" }], phrases: [{ text: "엘라 수인", meaning: "안개에 감사를" }] } },
    { tool: "set_hybrid", id: "h1", input: { a_id: "S-002", b_id: "S-001", possible: "드묾", child: "반안개", traits: "수명 200년 무렵", stigma: "엘프 탑에 들지 못한다" } },
    { tool: "set_demographics", id: "d1", input: { id: "P-001", parts: [{ ref: "S-001", pct: 70 }, { ref: "S-002", pct: 20 }] } },
    { tool: "set_demographics", id: "d2", input: { id: "F-001", parts: [{ ref: "S-001", pct: 80 }, { ref: "S-002", pct: 40 }] } },
    { tool: "set_ranks", id: "k1", input: { id: "F-002", ranks: [{ name: "대사제", desc: "불의 맹세를 주관한다", count: 1, holders: ["C-013"] }, { name: "사제", count: 1, holders: ["C-011", "C-010"] }, { name: "견습" }] } },
    { tool: "set_ranks", id: "k2", input: { id: "F-003", ranks: [{ name: "의장", holders: ["없는사람"] }] } },
    { tool: "set_relation", id: "r1", input: { from_id: "F-002", to_id: "F-003", label: "동맹", since: 300, until: 318 } },
    { tool: "set_relation", id: "r2", input: { from_id: "F-002", to_id: "F-003", label: "적대", since: 318 } },
    { tool: "set_relation", id: "r3", input: { from_id: "F-001", to_id: "F-003", label: "협력", since: 200, until: 100 } },
    { tool: "set_relation", id: "r4", input: { from_id: "C-001", to_id: "S-001", label: "종족" } },
    { tool: "set_relation", id: "r5", input: { from_id: "C-013", to_id: "F-002", label: "창립자", since: 310 } },
    { tool: "create_entry", id: "c3", input: { type: "인물", name: "늙은 현자", summary: "기록보다 오래 산 사람", time_start: 100, species_id: "S-001" } },
    { tool: "get_entries", id: "g1", input: { ids: ["S-002", "C-011", "F-002", "P-001"] } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "종족과 세력을 정리했어요." } }], "tool_use"));
  await send("종족을 정리해 줘", 2);
  const r1 = requests.at(-2);
  const tn = r1.body.tools.map((t) => t.name);
  check("v10 도구", ["set_language", "set_hybrid", "set_demographics", "set_ranks"].every((n) => tn.includes(n)) && tn.at(-1) === "respond" && r1.body.tools.find((t) => t.name === "set_relation").input_schema.properties.since && r1.body.tools.find((t) => t.name === "update_entry").input_schema.properties.species_id);
  check("v10 지침", r1.body.system[0].text.includes("## 종족") && r1.body.system[0].text.includes("## 세력과 관계의 시간"));
  check("첫 메시지: 나이 기준", r1.body.messages[0].content.map((b) => b.text || "").join("").includes("나이 기준: 인간(성년 18세"));
  const tr = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("도구: 종족이 아닌 항목 거부", res("u2").is_error && txt("u2").includes("종족 분류가 아닙니다"));
  check("도구: 구성 합 100 초과 거부", res("d2").is_error);
  check("도구: 없는 인물 직위 거부", res("k2").is_error && txt("k2").includes("없는사람"));
  check("도구: 끝이 시작보다 앞선 관계 거부", res("r3").is_error && txt("r3").includes("until"));
  check("도구: 나머지 성공", ["c1", "c2", "u1", "l1", "h1", "d1", "k1", "r1", "r2", "r4", "r5", "c3", "g1"].every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error).map((b) => b.tool_use_id + ":" + JSON.stringify(b.content).slice(0, 80))));
  const c12 = await entry("C-012");
  check("거부된 수정은 아무것도 바꾸지 않음", c12.summary === "서리의 여동생" && !c12.speciesRef && !(c12.history || []).length, c12.summary);
  const g1 = txt("g1");
  check("get_entries에 종족·세력", ["종족 카드:", "체격·외형: 창백한 피부", "수명과 단계: 평균 600년", "언어 스케치:", "엘라(안개)", "혼혈 규칙:", "드묾", "반안개", "종족: 안개엘프(S-002)", "종족과 다른 점: 다른 엘프보다", "지금 나이: 44세 · 유년 · 인간으로 치면 8세 무렵", "직위: 등대 교단의 사제", "직위(위에서 아래):", "대사제", "종족 구성: 인간 70%, 안개엘프 20%"].every((x) => g1.includes(x)), g1.slice(0, 1200));
  const f2 = await entry("F-002");
  const ally = f2.relations.find((r) => r.to === "F-003" && r.label === "동맹");
  check("기존 관계에 연도만 더함", ally && ally.since === 300 && ally.until === 318 && f2.relations.some((r) => r.label === "적대" && r.since === 318 && r.until == null));
  // v9 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 9;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b9 = requests.length;
  await send("하나 더", b9 + 1);
  check("v9 대화는 v9 지침·도구 그대로", requests[b9].body.system[0].text === V9.system && JSON.stringify(requests[b9].body.tools) === JSON.stringify(V9.tools));

  // ---- 2. 종족 탭 ----
  await openE("S-002");
  const stabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.dataset.etab));
  check("종족 탭 6개", stabs.join("|") === "base|bio|society|culture|lang|dist", stabs.join("|"));
  await page.click('#sheetBody [data-etab="bio"]');
  let st = await sheetText();
  check("생물: 단계·환산·특성", st.includes("성년") && st.includes("100세") && st.includes("나이 환산: 유년 0세 ≈ 인간 0세 · 성년 100세 ≈ 인간 18세") && st.includes("안개 이슬"), st.slice(0, 400));
  await page.screenshot({ path: `${SHOTS}/130-species-bio.png` });
  await page.click('#sheetBody [data-act="life-edit"]');
  await page.fill("#lf-span", "500");
  await page.fill("#stageRows .stage-row:nth-child(3) .sf", "");
  await page.click('#lifeForm button[type="submit"]');
  check("수명 편집: 빈 나이 거부", (await toastText()).includes("시작 나이"));
  await page.fill("#stageRows .stage-row:nth-child(3) .sf", "400");
  await page.click('#lifeForm button[type="submit"]');
  await page.waitForTimeout(300);
  let s2 = await entry("S-002");
  check("수명 편집 저장", s2.life.lifespan === 500 && s2.life.stages[2].from === 400);
  await page.click('#sheetBody [data-etab="bio"]');
  await page.click('#sheetBody [data-act="age-base"]');
  await page.waitForTimeout(250);
  check("나이 환산 기준 지정", (await world()).ageBase === "S-002");
  await page.click('#sheetBody [data-etab="bio"]').catch(() => {});
  await page.click('#sheetBody [data-act="age-base-off"]');
  await page.waitForTimeout(250);
  check("기준 해제", !(await world()).ageBase);
  // 사회 · 문화 편집
  await page.click('#sheetBody [data-etab="society"]');
  await page.click('#sheetBody [data-act="species-edit-society"]');
  await page.fill('#speciesForm textarea[data-k="government"]', "가장 오래된 탑의 장로회");
  await page.click('#speciesForm button[type="submit"]');
  await page.waitForTimeout(250);
  s2 = await entry("S-002");
  check("사회 편집 저장(다른 칸 유지)", s2.species.government === "가장 오래된 탑의 장로회" && s2.species.family === "세 세대가 한 탑에 산다" && s2.species.body);
  await page.click('#sheetBody [data-etab="culture"]');
  await page.click('#sheetBody [data-act="species-ask-culture"]');
  check("문화: Claude와 정하기", (await page.inputValue("#input")).includes("안개엘프(S-002) 종족의 문화"));
  await page.fill("#input", "");
  // 언어
  await openE("S-002", "lang");
  st = await sheetText();
  check("언어: 말소리·낱말·예문", st.includes("받침이 거의 없고") && st.includes("엘라") && st.includes("안개에 감사를"));
  await page.click('#sheetBody [data-act="lang-edit"]');
  await page.fill("#lg-words", "엘라 = 안개\n수인 = 감사\n모라 = 바다\n잘못된 줄");
  await page.click('#langForm button[type="submit"]');
  await page.waitForTimeout(250);
  s2 = await entry("S-002");
  check("언어 편집: '낱말 = 뜻' 줄만", s2.lang.words.length === 3 && s2.lang.words[2].word === "모라" && s2.lang.phrases.length === 1);
  quick.push(JSON.stringify({ sounds: "무시될 말소리", words: [{ word: "엘라", meaning: "중복" }, { word: "토린", meaning: "불" }, { word: "네이", meaning: "작별" }], phrases: [{ text: "토린 네이", meaning: "불이여 잘 가라" }] }));
  await page.click('#sheetBody [data-etab="lang"]').catch(() => {});
  await page.click('#sheetBody [data-act="lang-gen"]');
  await until(() => quickReqs.length >= 1);
  await page.waitForTimeout(500);
  s2 = await entry("S-002");
  const qb = quickReqs[0].body;
  check("낱말 만들기: Haiku + 스키마", qb.model === "claude-haiku-5-5" && qb.output_config?.format?.type === "json_schema" && JSON.stringify(qb.messages).includes("받침이 거의 없고"), qb.model);
  check("낱말 만들기: 중복 빼고 더함, 말소리 유지", s2.lang.words.length === 5 && s2.lang.words.some((w) => w.word === "토린") && s2.lang.sounds === "받침이 거의 없고 ㄹ 소리가 많다" && s2.lang.phrases.length === 2);
  // 분포
  await page.click('#sheetBody [data-etab="dist"]');
  st = await sheetText();
  check("분포: 사는 곳·인물", st.includes("잿빛 첨탑 등대") && st.includes("20%") && st.includes("도윤"));
  await page.click('#sheetBody [data-act="hybrid-matrix"]');
  await page.waitForSelector("#matrix .hy-cell");
  check("혼혈표 보기로 이동", (await page.textContent("#matrix")).includes("반안개"));
  await page.screenshot({ path: `${SHOTS}/131-hybrid.png` });

  // ---- 3. 인물: 종족 물려받기 · 나이 · 직위 ----
  await openE("C-011");
  st = await sheetText();
  check("인물: 나이 환산", st.includes("44세 · 유년 · 인간으로 치면 9세 무렵") || st.includes("44세 · 유년 · 인간으로 치면 8세 무렵"), (st.match(/44세[^\n]{0,30}/) || [""])[0]);
  check("인물: 직위", st.includes("등대 교단의 사제"));
  check("인물: 종족 특성 물려받기", (await page.textContent("#sheetBody .species-inherit")).includes("창백한 피부") && st.includes("다른 엘프보다 일찍 늙었다"));
  await page.screenshot({ path: `${SHOTS}/132-char-species.png` });
  await openE("C-001");
  await page.click('#sheetBody [data-act="species-adopt"]');
  await page.waitForTimeout(300);
  check("관계로 이어진 종족 → 종족으로 정하기", (await entry("C-001")).speciesRef === "S-001");
  check("인간은 환산 문구 없음", (await sheetText()).includes("15세 · 성년") === false && (await sheetText()).includes("15세 · 유년") && !(await sheetText()).includes("인간으로 치면"));
  // 편집기에서 종족 고르기
  await openE("C-010");
  await page.click('#sheetBody [data-act="edit"]');
  await page.selectOption("#f-species", "S-002");
  await page.fill("#f-species-note", "인간 마을에서 자랐다");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForTimeout(300);
  const c10 = await entry("C-010");
  check("편집기: 종족·다른 점 저장", c10.speciesRef === "S-002" && c10.speciesNote === "인간 마을에서 자랐다");

  // ---- 4. 관계 기간: 편집기 ----
  await openE("F-001");
  await page.click('#sheetBody [data-act="edit"]');
  await page.click("#f-rels .rel-row:first-child [data-rel-years]");
  await page.fill("#f-rels .rel-row:first-child .rs", "320");
  await page.fill("#f-rels .rel-row:first-child .ru", "310");
  await page.click('#entryForm button[type="submit"]');
  check("관계 기간: 끝<시작 거부", (await toastText()).includes("관계 기간"));
  await page.fill("#f-rels .rel-row:first-child .ru", "");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForTimeout(300);
  const f1 = await entry("F-001");
  check("관계 기간 저장", f1.relations.find((r) => r.to === "P-001").since === 320 && f1.relations.find((r) => r.to === "P-001").until === undefined);
  check("관계 목록에 기간 표시", (await sheetText()).includes("320년~") || (await sheetText()).includes("320~"), (await sheetText()).match(/다음 표적[^\n]{0,30}/)?.[0]);
  await page.click('#sheetBody [data-act="edit"]');
  check("편집기 다시 열면 기간 칸 보임", await page.isVisible("#f-rels .rel-row:first-child .rs") && (await page.inputValue("#f-rels .rel-row:first-child .rs")) === "320");
  await closeSheet();

  // ---- 5. 관계표: 보기 · 연도 · 칸 편집 · 혼혈 ----
  await gmode("matrix");
  check("관계표 탭 이름", (await page.$$eval("#graphModes [data-gmode]", (els) => els.map((e) => e.textContent).join(","))) === "관계도,계보,관계표,호칭,지도");
  await page.click('#matrix [data-mxview="rel"]');
  await page.waitForTimeout(150);
  await page.click('#matrix [data-mxpreset="0"]');
  await page.waitForTimeout(200);
  check("세력끼리 프리셋", (await page.$$("#matrix .mx th.mx-row")).length === 3);
  check("연도 슬라이더 있음", await page.isVisible("#mxYear"));
  const cell = (a, b) => page.textContent(`#matrix [data-mx="${a}|${b}"]`);
  check("모든 시기: 동맹·적대 함께", (await cell("F-002", "F-003")).includes("동맹") && (await cell("F-002", "F-003")).includes("적대"));
  const setYear = async (y) => { await page.$eval("#mxYear", (el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, y); await page.waitForTimeout(200); };
  await setYear(310);
  check("310년: 동맹만", (await cell("F-002", "F-003")) === "동맹" && (await page.textContent("#mxYearLabel")).includes("310"));
  await setYear(319);
  check("319년: 적대만", (await cell("F-002", "F-003")) === "적대");
  await page.screenshot({ path: `${SHOTS}/133-matrix-year.png` });
  await page.click("#matrix [data-mxyear-all]");
  await page.waitForTimeout(150);
  check("전체로 되돌림", (await page.textContent("#mxYearLabel")) === "모든 시기");
  await page.click('#matrix [data-mx="F-001|F-003"]');
  await page.fill("#mx-ab .mx-rel-row:first-child .ml", "경계");
  await page.fill("#mx-ab .mx-rel-row:first-child .ms", "abc");
  await page.click('#mxForm button[type="submit"]');
  check("칸 편집: 잘못된 연도 거부", (await toastText()).includes("기간"));
  await page.fill("#mx-ab .mx-rel-row:first-child .ms", "315");
  await page.click('#mxForm [data-mxadd="ab"]');
  await page.fill("#mx-ab .mx-rel-row:nth-child(2) .ml", "무시");
  await page.fill("#mx-ab .mx-rel-row:nth-child(2) .mu", "315");
  await page.click('#mxForm button[type="submit"]');
  await page.waitForTimeout(300);
  const f1b = await entry("F-001");
  check("칸 편집: 관계마다 기간 저장", f1b.relations.some((r) => r.to === "F-003" && r.label === "경계" && r.since === 315) && f1b.relations.some((r) => r.to === "F-003" && r.label === "무시" && r.until === 315) && f1b.relations.some((r) => r.to === "P-001"));
  await page.click('#matrix [data-mxpreset="1"]');
  await page.waitForTimeout(200);
  check("종족끼리 프리셋", (await page.$$("#matrix .mx th.mx-row")).length === 2 && (await page.textContent("#matrix .mx")).includes("안개엘프"));
  // 혼혈
  await page.click('#matrix [data-mxview="hybrid"]');
  await page.waitForSelector("#matrix .hy-cell");
  check("혼혈표: 대칭 칸", (await page.textContent('#matrix [data-hy="S-001|S-002"]')).includes("드묾") && (await page.textContent('#matrix [data-hy="S-002|S-001"]')).includes("반안개"));
  await page.click('#matrix [data-hy="S-002|S-001"]');
  await page.click('#hyForm input[value="가능"] + span');
  await page.fill("#hy-child", "안개혼");
  await page.click('#hyForm button[type="submit"]');
  await page.waitForTimeout(300);
  const s1 = await entry("S-001");
  check("혼혈 편집: 작은 id 쪽에 저장", s1.hybrids?.["S-002"]?.possible === "가능" && s1.hybrids["S-002"].child === "안개혼" && s1.hybrids["S-002"].traits === "수명 200년 무렵");
  check("혼혈표 갱신", (await page.textContent('#matrix [data-hy="S-001|S-002"]')).includes("안개혼") && (await page.$eval('#matrix [data-hy="S-001|S-002"]', (el) => el.parentElement.className)).includes("hy-가능"));
  await page.click('#matrix [data-mxview="rel"]');
  await page.waitForTimeout(150);

  // ---- 6. 세력: 직위 · 구성 ----
  await openE("F-002");
  const ftabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.textContent));
  check("세력 탭(교단은 신앙·법까지)", ftabs.join("|") === "기본|직위3|구성|신앙0/8|법", ftabs.join("|"));
  await page.click('#sheetBody [data-etab="ranks"]');
  st = await page.textContent("#sheetBody .rank-ladder");
  check("직위 사다리: 순서·인물·정원 초과", (await page.$$("#sheetBody .rank-ladder li")).length === 3 && st.indexOf("대사제") < st.indexOf("사제", st.indexOf("대사제") + 3) && st.includes("노을") && st.includes("2/1 · 정원 초과"), st);
  await page.screenshot({ path: `${SHOTS}/134-ranks.png` });
  await page.click('#sheetBody [data-act="ranks-edit"]');
  await page.fill("#rankRows .rank-row:nth-child(2) .rh", "도윤, 없는이름");
  await page.click('#ranksForm button[type="submit"]');
  check("직위 편집: 없는 인물 거부", (await toastText()).includes("없는이름"));
  await page.fill("#rankRows .rank-row:nth-child(2) .rh", "도윤");
  await page.click("#rankRows .rank-row:nth-child(3) [data-arc-up]");
  await page.click('#ranksForm button[type="submit"]');
  await page.waitForTimeout(300);
  let f2b = await entry("F-002");
  check("직위 편집: 인물·순서 저장", f2b.ranks.map((r) => r.name).join(">") === "대사제>견습>사제" && f2b.ranks[2].holders.join() === "C-011" && f2b.ranks[0].holders.join() === "C-013");
  await page.click('#sheetBody [data-etab="comp"]');
  st = await sheetText();
  check("구성: 이어진 인물(직위·관계)", st.includes("노을") && st.includes("도윤") && st.includes("안개엘프"));
  await page.click('#sheetBody [data-act="demo-edit"]');
  await page.selectOption("#demoRows .demo-row:first-child .dr", "S-001");
  await page.fill("#demoRows .demo-row:first-child .dp", "60");
  await page.click('#demoForm [data-act="demo-add"]');
  await page.selectOption("#demoRows .demo-row:nth-child(2) .dr", "S-002");
  await page.fill("#demoRows .demo-row:nth-child(2) .dp", "50");
  await page.click('#demoForm button[type="submit"]');
  check("구성 편집: 합 100 초과 거부", (await toastText()).includes("100"));
  await page.fill("#demoRows .demo-row:nth-child(2) .dp", "30");
  await page.click('#demoForm button[type="submit"]');
  await page.waitForTimeout(300);
  f2b = await entry("F-002");
  check("구성 편집 저장", f2b.demographics.length === 2 && f2b.demographics[0].pct === 60);
  check("구성 막대", (await page.$$("#sheetBody .demo-bar span")).length === 3 && (await sheetText()).includes("기타·미정 10%"));
  await page.screenshot({ path: `${SHOTS}/135-comp.png` });
  await page.click('#sheetBody [data-act="ranks-ask"]').catch(() => {});
  await page.click('#sheetBody [data-etab="ranks"]').catch(() => {});

  // ---- 7. 구성표 · 분류별 비교 ----
  await closeSheet().catch(() => {});
  await tab("codex");
  await page.click('#codex [data-act="comp-table"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("구성표: 장소·세력 행", st.includes("잿빛 첨탑 등대") && st.includes("등대 교단") && st.includes("70%") && st.includes("60%"));
  await closeSheet();
  await page.click('#codex [data-act="compare"]');
  const groups = await page.$$eval("#sheetBody [data-cmpgroup]", (els) => els.map((x) => x.dataset.cmpgroup));
  check("비교: 분류 고르기", groups[0] === "@char" && groups.includes("species") && groups.includes("faction"), groups.join());
  await page.click('#sheetBody [data-cmpgroup="species"]');
  await page.check('.pick input[value="S-001"]');
  await page.check('.pick input[value="S-002"]');
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("종족 비교: 수명·특성·혼혈", st.includes("평균 수명") && st.includes("500년") && st.includes("80년") && st.includes("창백한 피부") && st.includes("서로 혼혈") && st.includes("안개혼"), st.slice(0, 300));
  check("종족 비교 제목", (await page.textContent("#sheetBody .sheet-title")).includes("종족 비교 · 2개"));
  await page.click('#sheetBody [data-act="cmp-chat"]');
  check("종족 비교 → 대화", (await page.inputValue("#input")).includes("종족을 비교해 줘"));
  await page.fill("#input", "");
  await tab("codex");
  await page.click('#codex [data-act="compare"]');
  await page.click('#sheetBody [data-cmpgroup="faction"]');
  for (const id of ["F-001", "F-002", "F-003"]) await page.check(`.pick input[value="${id}"]`);
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("세력 비교: 직위·구성·서로를 보는 눈", st.includes("직위") && st.includes("대사제 › 견습 › 사제") && st.includes("구성원 종족") && st.includes("서로를 보는 눈") && st.includes("해안 공화국: 동맹, 적대"), st.slice(0, 400));
  await page.screenshot({ path: `${SHOTS}/136-compare-faction.png` });
  await closeSheet();
  await page.click('#codex [data-act="compare"]');
  check("비교: 기본은 인물", (await page.textContent("#sheetBody .sheet-title")) === "인물 비교");
  await page.check('.pick input[value="C-011"]');
  await page.check('.pick input[value="C-010"]');
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("인물 비교: 종족·직위·나이 단계", st.includes("안개엘프") && st.includes("등대 교단 사제") && st.includes("44세 · 유년"), st.slice(0, 400));
  await closeSheet();
  await openE("S-001");
  await page.click('#sheetBody [data-act="compare-one"]');
  check("종족 화면에서 비교: 종족 목록에 미리 체크", (await page.textContent("#sheetBody .sheet-title")).includes("종족 비교") && await page.isChecked('.pick input[value="S-001"]'));
  await closeSheet();

  // ---- 8. 설정 점검 ----
  await tab("codex");
  await page.click('#codex [data-act="checks"]');
  st = await sheetText();
  check("점검: 수명 넘김", st.includes("수명 넘김") && st.includes("늙은 현자: 지금 220세"), st.match(/수명 넘김[^\n]{0,80}/)?.[0]);
  check("점검: 죽은 인물이 직위에", st.includes("죽은 인물이 직위에") && st.includes("노을(301년 사망)"));
  check("점검: 관계 기간이 존재 시기 밖", st.includes("관계 기간이 존재 시기 밖") && st.includes("창립자"));
  await closeSheet();
  // 정원 초과 · 구성 합: 저장소에 직접 넣어 확인
  const ents = await idbGet("entries:" + wid0);
  const ff = ents.find((e) => e.id === "F-003");
  ff.ranks = [{ id: "x1", name: "의장", count: 1, holders: ["C-001", "C-012"] }];
  ff.demographics = [{ ref: "S-001", pct: 90 }, { ref: "S-002", pct: 30 }];
  await idbSet("entries:" + wid0, ents);
  await page.reload(); await page.waitForSelector("#app");
  await tab("codex");
  await page.click('#codex [data-act="checks"]');
  st = await sheetText();
  check("점검: 정원 초과·구성 합", st.includes("정원 초과") && st.includes("'의장': 정원 1자리에 2명") && st.includes("구성 합이 100을 넘음") && st.includes("해안 공화국: 120%"));
  await closeSheet();

  // ---- 9. 생애 겹쳐 보기: 종족 단계 ----
  await tab("timeline");
  await page.click('[data-tlmode="life"]').catch(() => {});
  await page.waitForTimeout(200);

  // ---- 10. 좁은 화면 ----
  await page.setViewportSize({ width: 360, height: 760 });
  for (const [id, t] of [["S-002", "dist"], ["F-002", "ranks"], ["C-011", null]]) {
    await openE(id, t);
    const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, sheet: document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth }));
    check(`360px: ${id} 가로 넘침 없음`, over.doc <= 360 && over.sheet <= 1, JSON.stringify(over));
    await closeSheet();
  }
  await gmode("matrix");
  await page.click('#matrix [data-mxpreset="0"]');
  await page.waitForTimeout(150);
  check("360px: 관계표 문서 넘침 없음", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await page.screenshot({ path: `${SHOTS}/137-matrix-360.png` });

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 400));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
