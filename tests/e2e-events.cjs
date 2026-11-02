// 사건·사물: v11 지침·도구, 사건 탭(전말·경과·바뀐 것·인과), 인과 흐름도, 달력·기념일, 복선, 역사 공백 채우기,
// 사물 탭(카드·마법 물건·제작), 소지품, 여정 지도, 화폐·물가, 기술 수준·시대착오, 사물 생성기, 비교, 설정 점검
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V10 = L.PROMPT_SET(10);
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const MAP = path.join(SCRATCH, "files/map.png");
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8784);

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
  const closeSheet = async () => { if (await page.isVisible("#sheet")) { await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); } };
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await closeSheet(); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const tlmode = async (m) => { await tab("timeline"); await page.click(`#tlModes [data-tlmode="${m}"]`); await page.waitForTimeout(150); };
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const entry = async (id) => (await idbGet("entries:" + (await wid()))).find((e) => e.id === id);
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const openE = async (id, t) => { await tab("codex"); if (await page.$('#codex [data-ctab="entries"][aria-selected="false"]')) await page.click('#codex [data-ctab="entries"]'); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); if (t) await page.click(`#sheetBody [data-etab="${t}"]`); };
  const sheetText = () => page.textContent("#sheetBody");
  const toastText = async () => { await page.waitForTimeout(150); return page.evaluate(() => document.querySelector("#toast")?.textContent || ""); };

  await page.goto("http://localhost:8784/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const wid0 = await wid();

  // ---- 1. v11: Claude가 사건·사물·달력·경제를 채운다 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "update_entry", id: "k1", input: { id: "K-001", magic: { source: "기억", cost: "기억 하나" } } },
    { tool: "set_spell", id: "k2", input: { id: "K-001", name: "등불 읽기", tier: "1등급", effect: "안개 속 배를 찾는다", cost: "사소한 기억" } },
    { tool: "create_entry", id: "p1", input: { type: "장소", name: "소금 항구", summary: "섬 동쪽의 항구" } },
    { tool: "create_entry", id: "i1", input: { type: "사물", name: "첫 등불", summary: "처음 켜진 등대의 불씨를 담은 등", item: { looks: "녹슨 청동 등", material: "청동", rarity: "유일" }, magic_item: { system_id: "K-001", spells: ["등불 읽기"], charges: "하룻밤 한 번" } } },
    { tool: "create_entry", id: "i2", input: { type: "사물", name: "고래기름", summary: "등대 연료", item: { use: "등대 연료" } } },
    { tool: "create_entry", id: "i3", input: { type: "사물", name: "등대 렌즈", summary: "빛을 멀리 보내는 렌즈" } },
    { tool: "create_entry", id: "i4", input: { type: "사물", name: "가짜 등", summary: "잘못된 체계", magic_item: { system_id: "F-001" } } },
    { tool: "set_recipe", id: "r1", input: { id: "I-003", materials: [{ ref: "I-002", qty: "한 통" }, { ref: "모래 유리", qty: "세 근" }], makers: ["F-002"], place_id: "P-001", time: "보름" } },
    { tool: "set_recipe", id: "r2", input: { id: "I-002", sources: ["P-001"] } },
    { tool: "set_recipe", id: "r3", input: { id: "I-003", makers: ["없는세력"] } },
    { tool: "set_artifact", id: "a1", input: { id: "I-001", made: 245, owners: [{ who: "C-013", from: 250, to: 301, at: "P-001" }, { who: "C-011", from: 290, to: 330, at: "P-002" }] } },
    { tool: "update_entry", id: "e1", input: { id: "E-002", event: { cause: "등대가 꺼져 항로가 끊김", outcome: "교단의 승리" } } },
    { tool: "set_event", id: "e2", input: { id: "E-002", participants: [{ id: "F-002", role: "주동" }, { id: "F-001", role: "피해" }, { id: "C-013", role: "목격", note: "먼 바다에서 보았다" }], steps: [{ at: "첫날 새벽", text: "교단의 배가 항구를 막다", place_id: "P-001" }, { at: "사흘째", text: "무등회 거점 함락" }] } },
    { tool: "set_event", id: "e3", input: { id: "E-001", participants: [{ id: "없음", role: "주동" }] } },
    { tool: "set_cause", id: "c1", input: { cause_id: "E-001", effect_id: "E-002", note: "불이 꺼지자 전쟁이 났다" } },
    { tool: "set_cause", id: "c2", input: { cause_id: "E-002", effect_id: "E-001" } },
    { tool: "create_entry", id: "e4", input: { type: "사건", name: "첫 불의 날 제정", summary: "기념일을 정함", time_start: 300 } },
    { tool: "set_cause", id: "c3", input: { cause_id: "E-002", effect_id: "E-003" } },
    { tool: "set_calendar", id: "m1", input: { months: [{ name: "서리달", days: 28 }, { name: "안개달", days: 30 }, { name: "등불달", days: 31 }] } },
    { tool: "set_observance", id: "o1", input: { name: "첫 불의 날", kind: "기념일", month: "등불달", day: 3, since: 313, event_id: "E-001", desc: "등대마다 불을 새로 붙인다" } },
    { tool: "set_observance", id: "o2", input: { name: "안개 축제", kind: "축제", month: "2", day: 31 } },
    { tool: "set_foreshadow", id: "f1", input: { text: "노을이 남긴 마지막 등명부 한 장", kind: "복선", planted_in: "E-001" } },
    { tool: "set_foreshadow", id: "f2", input: { text: "불이 세 번 꺼지면 바다가 열린다", kind: "예언", due: 315 } },
    { tool: "set_economy", id: "x1", input: { base: "은화", currencies: [{ name: "금화", rate: 20, where: ["F-003"] }], prices: [{ item: "빵 한 덩이", price: 2 }, { item: "등대 기름 한 통", price: 1.5, currency: "금화", where_id: "P-001" }] } },
    { tool: "set_economy", id: "x2", input: { prices: [{ item: "칼", price: 1, currency: "동전" }] } },
    { tool: "set_tech", id: "t1", input: { rows: [{ values: { 조명: "고래기름 등잔", 통신: "전서구" } }, { where_id: "F-003", from: 300, values: { 교통: "증기선", 천문: "망원경" } }] } },
    { tool: "get_entries", id: "g1", input: { ids: ["E-002", "I-001", "I-003", "P-001", "C-011", "E-001"] } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "사건과 사물을 정리했어요." } }], "tool_use"));
  await send("사건과 물건을 정리해 줘", 2);
  const r1 = requests.at(-2);
  const tn = r1.body.tools.map((t) => t.name);
  check("v11 도구 포함(지금 판은 40개)", tn.length === 40 && ["set_event", "set_cause", "set_observance", "set_foreshadow", "set_recipe", "set_economy", "set_tech"].every((n) => tn.includes(n)) && tn.at(-1) === "respond" && r1.body.tools.find((t) => t.name === "set_calendar").input_schema.properties.months && r1.body.tools.find((t) => t.name === "set_artifact").input_schema.properties.owners.items.properties.at && r1.body.tools.find((t) => t.name === "update_entry").input_schema.properties.magic_item, tn.length);
  check("v11 지침", r1.body.system[0].text.includes("## 사건") && r1.body.system[0].text.includes("## 사물과 경제"));
  const first = r1.body.messages[0].content.map((b) => b.text || "").join("");
  check("첫 메시지: 달(기본값)", first.includes("달: 1월(30일)") && first.includes("(기본값)"));
  const tr = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("거부: 마법 체계가 아닌 항목", res("i4").is_error && txt("i4").includes("마법 체계 항목이 아닙니다"));
  check("거부: 없는 만드는 이", res("r3").is_error && txt("r3").includes("없는세력"));
  check("거부: 없는 참여자", res("e3").is_error && txt("e3").includes("없음"));
  check("거부: 인과 순환", res("c2").is_error && txt("c2").includes("순환"));
  check("거부: 달에 없는 날짜", res("o2").is_error && txt("o2").includes("30일까지"));
  check("거부: 없는 화폐", res("x2").is_error && txt("x2").includes("동전"));
  const okIds = ["k1", "k2", "p1", "i1", "i2", "i3", "r1", "r2", "a1", "e1", "e2", "c1", "e4", "c3", "m1", "o1", "f1", "f2", "x1", "t1", "g1"];
  check("나머지 도구 성공", okIds.every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error && !["i4", "r3", "e3", "c2", "o2", "x2"].includes(b.tool_use_id)).map((b) => b.tool_use_id + ":" + JSON.stringify(b.content).slice(0, 90))));
  check("경고: 유물 소유 겹침", txt("a1").includes("함께 가졌다고"), txt("a1"));
  check("경고: 죽은 참여자", txt("e2").includes("노을") && txt("e2").includes("살아 있지 않았다"));
  check("경고: 결과가 원인보다 앞섬", txt("c3").includes("결과") && txt("c3").includes("앞선다"));
  check("기술: 모르는 분야는 더함", txt("t1").includes("분야를 더했다: 천문"));
  const g1 = txt("g1");
  check("get_entries에 사건·사물", ["사건 카드:", "원인: 등대가 꺼져", "참여자:", "[주동]", "세부 경과:", "첫날 새벽: 교단의 배가", "인과:", "원인: 대등화(E-001)", "결과: 첫 불의 날 제정(E-003)", "이 사건 기간에 바뀐 것:", "죽음: 하람(C-010)", "사물 카드:", "희귀도: 유일", "마법 물건: 체계 등명 계약(K-001), 주문 등불 읽기, 대가 미정", "만드는 법:", "재료: 고래기름(I-002) 한 통, 모래 유리 세 근", "만드는 이: 등대 교단(F-002)", "여기서 나는 재료: 고래기름(I-002)", "가진 것: 첫 등불(I-001)", "잿빛 첨탑 등대(P-001)에 있었음", "남긴 날: 첫 불의 날(기념일, 등불달 3일)", "[복선·깔림] 노을이 남긴"].every((x) => g1.includes(x)), g1.slice(0, 1500));
  const w1 = await world();
  check("세계: 달·기념일·복선·경제·기술 저장", w1.calendar.months.length === 3 && w1.calendar.now === 320 && w1.observances.length === 1 && w1.foreshadows.length === 2 && w1.economy.base === "은화" && w1.economy.prices.length === 2 && w1.tech.areas.includes("천문") && w1.tech.rows.length === 2);
  check("엔트리: 사물·사건 데이터", (await entry("I-001")).magicItem.system === "K-001" && (await entry("I-003")).recipe.materials[1].name === "모래 유리" && (await entry("I-002")).sources[0] === "P-001" && (await entry("E-002")).causes[0].ref === "E-001" && (await entry("E-002")).steps[0].place === "P-001");
  // 새 대화의 첫 메시지
  await page.click("#newThreadBtn");
  const nb = requests.length;
  await send("다음 이야기", nb + 1);
  const ctxText = requests[nb].body.messages[0].content.map((b) => b.text || "").join("");
  check("새 대화 현황: 달·기념일·복선·화폐·기술", ["달: 서리달(28일), 안개달(30일), 등불달(31일)", "기념일·축제: 첫 불의 날[기념일] 등불달 3일", "회수되지 않은 복선·예언 2개", "[예언] 불이 세 번 꺼지면", "화폐: 기준 은화. 금화 = 20 은화(해안 공화국)", "물가: 빵 한 덩이 2 은화", "등대 기름 한 통 1.5 금화 (30 은화)(잿빛 첨탑 등대)", "기술 수준:", "- 전역: 조명 고래기름 등잔"].every((x) => ctxText.includes(x)), ctxText.slice(ctxText.indexOf("달:"), ctxText.indexOf("달:") + 600));
  // v10 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 10;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b10 = requests.length;
  await send("하나 더", b10 + 1);
  check("v10 대화는 v10 지침·도구 그대로", requests[b10].body.system[0].text === V10.system && JSON.stringify(requests[b10].body.tools) === JSON.stringify(V10.tools));

  // ---- 2. 설정 점검 ----
  await tab("codex");
  await page.click('#codex [data-act="checks"]');
  let st = await sheetText();
  check("점검: 결과가 원인보다 앞섬", st.includes("결과가 원인보다 앞섬") && st.includes("안개 전쟁"));
  check("점검: 참여자가 그때 없음", st.includes("참여자가 그때 없음") && st.includes("노을은(는) 301년에 죽었습니다"));
  check("점검: 대가 없는 마법 물건·유물 겹침", st.includes("대가 없는 마법 물건") && st.includes("함께 가졌다고"));
  check("점검: 때가 지난 예언·회수되지 않은 복선", st.includes("때가 지난 예언") && st.includes("회수되지 않은 복선"));
  await closeSheet();

  // ---- 3. 사건 탭 ----
  await openE("E-002");
  const etabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.dataset.etab));
  check("사건 탭 5개", etabs.join("|") === "base|story|steps|changes|causal", etabs.join("|"));
  await page.click('#sheetBody [data-etab="story"]');
  st = await sheetText();
  check("전말: 카드·참여자", st.includes("등대가 꺼져 항로가 끊김") && (await page.$$("#sheetBody .part-list li")).length === 3 && st.includes("먼 바다에서 보았다"));
  await page.screenshot({ path: `${SHOTS}/140-event-story.png` });
  await page.click('#sheetBody [data-act="event-edit"]');
  await page.fill('#eventForm textarea[data-k="legacy"]', "등대마다 교단 사제가 상주");
  await page.click('#eventForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("사건 카드 편집", (await entry("E-002")).event.legacy === "등대마다 교단 사제가 상주" && (await entry("E-002")).event.cause);
  await page.click('#sheetBody [data-etab="story"]').catch(() => {});
  await page.click('#sheetBody [data-act="part-edit"]');
  await page.selectOption("#partRows .part-row:nth-child(3) .pl", "기타");
  await page.click('#partForm [data-act="part-row-add"]');
  await page.selectOption("#partRows .part-row:nth-child(4) .pr", "C-012");
  await page.selectOption("#partRows .part-row:nth-child(4) .pl", "목격");
  await page.click('#partForm button[type="submit"]');
  await page.waitForTimeout(250);
  let e2 = await entry("E-002");
  check("참여자 편집", e2.participants.length === 4 && e2.participants[2].role === "기타" && e2.participants[3].ref === "C-012");
  await page.click('#sheetBody [data-etab="steps"]');
  check("경과: 단계와 장소", (await page.$$("#sheetBody .step-list li")).length === 2 && (await sheetText()).includes("잿빛 첨탑 등대"));
  await page.click('#sheetBody [data-act="steps-edit"]');
  await page.click('#stepsForm [data-act="step-add"]');
  await page.fill("#stepRows .step-row:nth-child(3) .sa", "이튿날");
  await page.fill("#stepRows .step-row:nth-child(3) .st", "무등회가 반격하다");
  await page.click("#stepRows .step-row:nth-child(3) [data-arc-up]");
  await page.click('#stepsForm button[type="submit"]');
  await page.waitForTimeout(250);
  e2 = await entry("E-002");
  check("경과 편집: 순서", e2.steps.map((x) => x.at).join(">") === "첫날 새벽>이튿날>사흘째");
  await page.click('#sheetBody [data-etab="changes"]');
  st = await sheetText();
  check("바뀐 것: 죽음·이어진 사건", st.includes("하람") && st.includes("이어진 사건") && st.includes("첫 불의 날 제정"), st.slice(0, 300));
  await page.click('#sheetBody [data-etab="causal"]');
  st = await sheetText();
  check("인과: 원인·결과·순서 확인", st.includes("대등화") && st.includes("불이 꺼지자 전쟁이 났다") && st.includes("첫 불의 날 제정") && (await page.$$("#sheetBody .cause-list .pill-danger")).length === 1);
  await page.screenshot({ path: `${SHOTS}/141-event-causal.png` });
  await page.click('#sheetBody [data-act="cause-del"][data-id="E-003"]');
  await page.waitForTimeout(250);
  check("인과 끊기", !((await entry("E-003")).causes || []).length);
  await page.click('#sheetBody [data-act="cause-add"][data-dir="effect"]');
  await page.selectOption("#cz-other", "E-003");
  await page.fill("#cz-note", "전쟁이 끝나고 날을 정했다");
  await page.click('#causeForm button[type="submit"]');
  check("결과 잇기: 순서 경고", (await toastText()).includes("연도를 확인"));
  check("결과 잇기 저장", (await entry("E-003")).causes[0].ref === "E-002" && (await entry("E-003")).causes[0].note === "전쟁이 끝나고 날을 정했다");
  // 기념일·복선 더하기
  await openE("E-001", "causal");
  st = await sheetText();
  check("원인 사건 쪽에 결과·남긴 날·복선", st.includes("안개 전쟁") && st.includes("첫 불의 날") && st.includes("노을이 남긴"));
  await page.click('#sheetBody [data-act="obs-add"]');
  check("기념일 더하기: 계기 사건 미리 채움", (await page.inputValue("#ob-ref")) === "E-001" && (await page.inputValue("#ob-since")) === "312");
  await page.fill("#ob-name", "등불 끄는 밤");
  await page.click('#obsForm input[value="금기일"] + span');
  await page.selectOption("#ob-month", "1");
  await page.fill("#ob-day", "29");
  await page.click('#obsForm button[type="submit"]');
  check("기념일: 달에 없는 날 거부", (await toastText()).includes("28일까지"));
  await page.fill("#ob-day", "28");
  await page.click('#obsForm button[type="submit"]');
  await page.waitForTimeout(300);
  check("기념일 저장 후 사건으로 돌아옴", (await world()).observances.length === 2 && (await page.textContent("#sheetBody .entry-name")) === "대등화");
  await page.click('#sheetBody [data-act="fs-add-here"]');
  await page.fill("#fs-text", "꺼진 불 아래 남은 이름");
  await page.click('#fsForm button[type="submit"]');
  await page.waitForTimeout(300);
  const fs3 = (await world()).foreshadows.find((f) => f.text === "꺼진 불 아래 남은 이름");
  check("복선 더하기(깔린 곳 = 이 사건)", fs3 && fs3.plant === "E-001" && fs3.status === "깔림");
  // 흐름도
  await page.click('#sheetBody [data-etab="causal"]').catch(() => {});
  await page.click('#sheetBody [data-act="causal-view"]');
  await page.waitForSelector("#timeline .causal-canvas");
  check("흐름도: 3개 사건·화살표 2개", (await page.$$("#timeline .c-node")).length === 3 && (await page.$$("#timeline .c-edge")).length === 2);
  check("흐름도: 순서가 뒤집힌 선 표시", (await page.$$("#timeline .c-edge.bad")).length === 1 && (await page.textContent("#timeline")).includes("결과가 원인보다 앞선 연결이 1개"));
  check("흐름도: 선택한 사건 강조", (await page.$$("#timeline .c-node.sel")).length === 1 && (await page.textContent("#timeline .c-card")).includes("대등화"));
  await page.screenshot({ path: `${SHOTS}/142-causal.png` });
  await page.click('#timeline [data-cnode="E-002"]');
  check("흐름도: 다른 사건 선택", (await page.textContent("#timeline .c-card")).includes("안개 전쟁"));
  await page.click('#timeline [data-cnode="E-002"]');
  await page.waitForSelector("#sheetBody .entry-name");
  check("흐름도: 두 번 누르면 사건 화면", (await page.textContent("#sheetBody .entry-name")) === "안개 전쟁");
  await closeSheet();
  await page.click('#timeline [data-causal="whatif"]');
  check("흐름도: 없었다면?", (await page.inputValue("#input")).includes("안개 전쟁(E-002)이(가) 일어나지 않았다면"));
  await page.fill("#input", "");

  // ---- 4. 달력 ----
  await tlmode("cal");
  st = await page.textContent("#timeline");
  check("달력: 달 3개·기념일", (await page.$$("#timeline .cal-mon")).length === 3 && st.includes("한 해 89일") && st.includes("첫 불의 날") && st.includes("등불 끄는 밤") && (await page.$$("#timeline .cal-dot:not(.static)")).length === 2);
  await page.screenshot({ path: `${SHOTS}/143-calendar.png` });
  await page.click('#timeline [data-calv="months"]');
  await page.fill("#monthRows .month-row:first-child .mdays", "25");
  await page.click('#monthForm button[type="submit"]');
  check("달 편집: 어긋난 기념일 알림", (await toastText()).includes("등불 끄는 밤"));
  await page.waitForTimeout(200);
  check("달력: 없는 날짜 표시", (await page.textContent("#timeline")).includes("달력에 없는 날짜: 등불 끄는 밤"));
  await page.click('#timeline .cal-item[data-obs]:has-text("등불 끄는 밤")');
  await page.fill("#ob-day", "20");
  await page.click('#obsForm button[type="submit"]');
  await page.waitForTimeout(300);
  check("기념일 날짜 고침", (await world()).observances.find((o) => o.name === "등불 끄는 밤").day === 20 && !(await page.textContent("#timeline")).includes("달력에 없는 날짜"));
  // 연표 공백 채우기
  await tlmode("list");
  const gaps = await page.$$eval("#timeline [data-gap]", (els) => els.map((x) => x.dataset.gap));
  check("연표: 공백 채우기 버튼", gaps.includes("240|276"), gaps.join());
  quick.push(JSON.stringify({ events: [
    { name: "첫 등명부", summary: "노을이 등명부를 처음 쓰다", start: 250, end: 250, cause: "기억을 기록할 필요", outcome: "계약이 제도가 됨", causes: [], effects: ["E-001", "X-999"] },
    { name: "검은 해일", summary: "안개가 해안을 덮다", start: 262, end: 264, cause: "", outcome: "", causes: [], effects: [] },
  ] }));
  await page.click('#timeline [data-gap="240|276"]');
  await page.click('#sheetBody [data-gp="make"]');
  await page.waitForSelector("#sheetBody .gap-pick");
  const gq = quickReqs.at(-1).body;
  check("공백 채우기: Haiku·스키마·앞뒤 사건", gq.model === "claude-haiku-5-5" && gq.output_config.format.schema.properties.events && JSON.stringify(gq.messages).includes("빈 구간: 240년 ~ 276년"));
  check("후보 2개", (await page.$$("#sheetBody .gap-pick")).length === 2);
  await page.uncheck("#sheetBody .gap-pick:nth-child(2) input");
  await page.click('#sheetBody [data-gp="save"]');
  await page.waitForTimeout(300);
  const ents = await idbGet("entries:" + wid0);
  const ne = ents.find((x) => x.name === "첫 등명부");
  check("고른 후보만 초안으로·인과 연결", ne && ne.status === "draft" && ne.when.start === 250 && ne.when.end == null && ne.event.outcome === "계약이 제도가 됨" && !ents.some((x) => x.name === "검은 해일") && (await entry("E-001")).causes?.some((c) => c.ref === ne.id));

  // ---- 5. 복선 탭 ----
  await tab("codex");
  await page.click('#codex [data-ctab="foreshadow"]');
  check("복선 탭: 3장", (await page.$$("#codex .fs-card")).length === 3);
  await page.screenshot({ path: `${SHOTS}/144-foreshadow.png` });
  const fs1 = (await world()).foreshadows.find((f) => f.text.startsWith("노을이"));
  await page.click(`#codex [data-fs-st="${fs1.id}|회수"]`);
  await page.waitForTimeout(250);
  check("회수됨 표시", (await world()).foreshadows.find((f) => f.id === fs1.id).status === "회수");
  await page.click('#codex [data-fsfilter="깔림"]');
  check("깔림만 보기", (await page.$$("#codex .fs-card")).length === 2);
  await page.click('#codex [data-fsfilter="all"]');
  await page.click(`#codex [data-fs-edit="${fs1.id}"]`);
  await page.selectOption("#fs-payoff", "E-003");
  await page.click('#fsForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("복선 편집: 회수된 곳", (await world()).foreshadows.find((f) => f.id === fs1.id).payoff === "E-003");
  const fs2 = (await world()).foreshadows.find((f) => f.kind === "예언");
  await page.click(`#codex [data-fs-chat="${fs2.id}"]`);
  check("회수 방법 정하기 → 대화", (await page.inputValue("#input")).includes("회수되지 않은 예언") && (await page.inputValue("#input")).includes("set_foreshadow"));
  await page.fill("#input", "");

  // ---- 6. 사물 탭 ----
  await openE("I-001");
  const itabs = await page.$$eval("#sheetBody [data-etab]", (els) => els.map((x) => x.dataset.etab));
  check("사물 탭 4개", itabs.join("|") === "base|card|history|craft", itabs.join("|"));
  await page.click('#sheetBody [data-etab="card"]');
  st = await sheetText();
  check("카드: 칸·마법 물건", st.includes("녹슨 청동 등") && st.includes("유일") && st.includes("등명 계약") && st.includes("등불 읽기") && st.includes("1등급") && st.includes("대가 미정"));
  await page.screenshot({ path: `${SHOTS}/145-item-card.png` });
  await page.click('#sheetBody [data-act="item-edit"]');
  await page.fill('#itemForm [data-k="value"]', "값을 매길 수 없음");
  await page.click('#itemForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("카드 편집(다른 칸 유지)", (await entry("I-001")).item.value === "값을 매길 수 없음" && (await entry("I-001")).item.material === "청동");
  await page.click('#sheetBody [data-etab="card"]').catch(() => {});
  await page.click('#sheetBody [data-act="mi-edit"]');
  check("마법 물건 편집: 주문 미리 체크", await page.isChecked('#mi-spells input[value="등불 읽기"]'));
  await page.fill("#mi-cost", "쓸 때마다 가장 오래된 기억 하나");
  await page.click('#miForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("마법 물건 대가 저장", (await entry("I-001")).magicItem.cost === "쓸 때마다 가장 오래된 기억 하나" && (await entry("I-001")).magicItem.spells[0] === "등불 읽기");
  await page.click('#sheetBody [data-etab="card"]').catch(() => {});
  await page.click('#sheetBody [data-act="mi-ruling"]');
  await page.waitForSelector("#ruSituation");
  await page.fill("#ruSituation", "첫 등불로 안개 너머를 볼 수 있나?");
  quick.push(JSON.stringify({ verdict: "가능", reason: "등불 읽기", cost: "기억", conditions: "밤", consequence: "없음" }));
  await page.click('#sheetBody [data-act="ruling-ask"]');
  await page.waitForSelector("#ruOut .ruling");
  check("판정 근거에 마법 물건", JSON.stringify(quickReqs.at(-1).body.messages).includes("이 체계를 쓰는 마법 물건") && JSON.stringify(quickReqs.at(-1).body.messages).includes("첫 등불(I-001)"));
  await closeSheet();
  // 이력: 있던 곳
  await openE("I-001", "history");
  st = await sheetText();
  check("이력: 있던 곳·겹침 경고", st.includes("있던 곳") && st.includes("소금 항구") && st.includes("함께 가졌다고"));
  await page.click('#sheetBody [data-act="art-edit"]');
  check("이력 편집: 있던 곳 칸", (await page.inputValue("#ownerRows .owner-row:first-child .o-at")) === "잿빛 첨탑 등대");
  await closeSheet();

  // ---- 7. 제작 · 나는 곳 · 장소 경제 ----
  await openE("I-003", "craft");
  st = await sheetText();
  check("제작: 재료·만드는 이·곳", st.includes("고래기름") && st.includes("한 통") && st.includes("모래 유리") && st.includes("등대 교단") && st.includes("보름"));
  await page.click('#sheetBody [data-act="craft-edit"]');
  await page.fill("#matRows .mat-row:nth-child(2) .mq", "다섯 근");
  await page.click('#craftForm [data-act="mat-add"]');
  await page.fill("#matRows .mat-row:nth-child(3) .mr", "등대 렌즈");
  await page.click('#craftForm button[type="submit"]');
  check("제작: 자기 자신을 재료로 거부", (await toastText()).includes("자기 자신"));
  await page.click("#matRows .mat-row:nth-child(3) [data-del-row]");
  await page.click('#craftForm button[type="submit"]');
  await page.waitForTimeout(250);
  check("제작 편집 저장", (await entry("I-003")).recipe.materials[1].qty === "다섯 근" && (await entry("I-003")).recipe.makers[0] === "F-002");
  await openE("I-002", "craft");
  check("재료 쪽: 이것을 재료로 쓰는 것", (await sheetText()).includes("등대 렌즈") && (await sheetText()).includes("잿빛 첨탑 등대"));
  await page.click('#sheetBody [data-act="src-edit"]');
  await page.check('#sheetBody .pick input[value="P-002"]');
  await page.click('#sheetBody [data-act="src-save"]');
  await page.waitForTimeout(250);
  check("나는 곳 편집", (await entry("I-002")).sources.length === 2);
  await openE("P-001", "economy");
  st = await sheetText();
  check("장소 경제: 나는 재료(막혀도 다른 곳에서 남)", st.includes("여기서 나는 재료") && st.includes("고래기름") && !st.includes("이곳이 막히면"));
  await page.click('#sheetBody [data-etab="economy"]').catch(() => {});
  await openE("I-002", "craft");
  await page.click('#sheetBody [data-act="src-edit"]');
  await page.uncheck('#sheetBody .pick input[value="P-002"]');
  await page.click('#sheetBody [data-act="src-save"]');
  await page.waitForTimeout(250);
  await openE("P-001", "economy");
  check("장소 경제: 이곳이 막히면 만들 수 없는 것", (await sheetText()).includes("이곳이 막히면 만들 수 없는 것") && (await sheetText()).includes("등대 렌즈"));
  await closeSheet();

  // ---- 8. 소지품 ----
  await openE("C-011");
  check("인물: 가진 것", (await page.textContent("#sheetBody .hold-line")).includes("첫 등불"));
  await page.click('#sheetBody [data-act="hold-pass"][data-id="I-001"]');
  await page.selectOption("#hd-to", "C-001");
  await page.fill("#hd-how", "유언으로 물려받음");
  await page.click('#holdForm button[type="submit"]');
  await page.waitForTimeout(300);
  const i1 = await entry("I-001");
  check("넘기기: 이력에 더하고 앞 주인 끝냄", i1.artifact.holder === "C-001" && i1.artifact.owners.at(-1).who === "C-001" && i1.artifact.owners.at(-1).from === 320 && i1.artifact.owners.at(-1).how === "유언으로 물려받음" && i1.artifact.owners[1].to === 320 && i1.artifact.owners[0].at === "P-001");
  check("넘긴 쪽에는 없음", !(await page.textContent("#sheetBody .hold-line")).includes("첫 등불"));
  await openE("C-012");
  await page.click('#sheetBody [data-act="hold-add"]');
  await page.selectOption("#hd-item", "I-002");
  await page.click('#holdForm button[type="submit"]');
  await page.waitForTimeout(300);
  check("물건 주기", (await entry("I-002")).artifact.holder === "C-012" && (await page.textContent("#sheetBody .hold-line")).includes("고래기름"));
  await closeSheet();

  // ---- 9. 여정 지도 ----
  await tab("graph");
  await page.click('#graphModes [data-gmode="map"]');
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click('#mapEmpty [data-map="upload"]')]);
  await fc.setFiles(MAP);
  await page.waitForSelector("#mapVp:not([hidden])");
  const vb = await page.$eval("#mapVp", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const pinAt = async (ref, fx, fy) => { await page.click('[data-map="add"]'); await page.mouse.click(vb.x + vb.w * fx, vb.y + vb.h * fy); await page.waitForSelector(`#pinList [data-ref="${ref}"]`); await page.click(`#pinList [data-ref="${ref}"]`); await page.waitForSelector(`.map-pin[data-pin="${ref}"]`); };
  await pinAt("P-001", 0.2, 0.3);
  await pinAt("P-002", 0.7, 0.6);
  await page.click('[data-map="add"]');
  await page.click('[data-map="add"]');
  await openE("I-001", "history");
  await page.click('#sheetBody [data-act="journey"]');
  await page.waitForSelector("#mapOverlay .journey");
  check("여정: 지점 2개와 선", (await page.$$("#mapOverlay .j-pt")).length === 2 && (await page.$$("#mapOverlay .journey polyline")).length === 1);
  check("여정 카드: 소유 기록", (await page.textContent("#mapCard")).includes("노을 250~301") && (await page.textContent("#mapCard")).includes("도윤 290~320"));
  check("여정: 연도 슬라이더", await page.isVisible("#mapYear"));
  await page.$eval("#mapYear", (el) => { el.value = "260"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(250);
  check("여정: 그해 지점 강조", (await page.$$("#mapOverlay .j-pt.cur")).length === 1 && (await page.textContent("#mapCard .journey-list li.cur")).includes("노을"));
  await page.screenshot({ path: `${SHOTS}/146-journey.png` });
  await page.click('#mapCard [data-map="journey-off"]');
  await page.waitForTimeout(150);
  check("여정 닫기", !(await page.$("#mapOverlay .journey")));

  // ---- 10. 화폐·물가 ----
  await tab("codex");
  await page.click('#codex [data-act="economy"]');
  check("화폐: 기준·화폐·물가", (await page.inputValue("#eco-base")) === "은화" && (await page.$$("#curRows .cur-row")).length === 1 && (await page.$$("#priceRows .price-row")).length === 2);
  await page.fill("#cv-amt", "3");
  await page.selectOption("#cv-from", "금화");
  await page.selectOption("#cv-to", "은화");
  await page.waitForTimeout(100);
  check("환산: 3 금화 = 60 은화", (await page.textContent("#cv-out")) === "3 금화 = 60 은화");
  await page.screenshot({ path: `${SHOTS}/147-economy.png` });
  await page.click('#ecoForm [data-act="cur-add"]');
  await page.fill("#curRows .cur-row:nth-child(2) .cn", "동화");
  await page.fill("#curRows .cur-row:nth-child(2) .cr", "0.1");
  await page.click('#ecoForm [data-act="price-add"]');
  await page.fill("#priceRows .price-row:nth-child(3) .pi", "맥주 한 잔");
  await page.fill("#priceRows .price-row:nth-child(3) .pp", "5");
  await page.fill("#priceRows .price-row:nth-child(3) .pc", "엽전");
  await page.click('#ecoForm button[type="submit"]');
  check("물가: 없는 화폐 거부", (await toastText()).includes("엽전"));
  await page.fill("#priceRows .price-row:nth-child(3) .pc", "동화");
  await page.click('#ecoForm button[type="submit"]');
  await page.waitForTimeout(300);
  const eco = (await world()).economy;
  check("화폐·물가 저장", eco.currencies.length === 2 && eco.prices.length === 3 && eco.prices[2].currency === "동화" && eco.prices[1].where === "P-001");
  await closeSheet();

  // ---- 11. 기술 수준 ----
  await page.click('#codex [data-act="tech"]');
  check("기술 표: 열 2·분야 9", (await page.$$("#sheetBody .tech-table thead th.cmp-head")).length === 2 && (await page.$$("#sheetBody .tech-table tbody tr")).length === 9 && (await sheetText()).includes("증기선"));
  await page.screenshot({ path: `${SHOTS}/148-tech.png` });
  await page.click("#sheetBody .tech-table [data-techrow]");
  await page.fill('#techRowForm [data-area="의료"]', "약초와 사혈");
  await page.click('#techRowForm button[type="submit"]');
  await page.waitForTimeout(300);
  check("기술 줄 편집", (await world()).tech.rows.find((r) => !r.where).values.의료 === "약초와 사혈" && (await sheetText()).includes("약초와 사혈"));
  quick.push(JSON.stringify({ problems: [{ ref: "I-003", what: "등대 렌즈의 정밀 연마", why: "전역 조명이 등잔 수준", fix: "거친 유리로 바꾸기" }] }));
  await page.click('#sheetBody [data-act="tech-check"]');
  await page.waitForSelector("#techOut .hole");
  const tq = quickReqs.at(-1).body;
  check("시대착오 찾기: 요청에 기술표·사물", tq.output_config.format.schema.properties.problems && JSON.stringify(tq.messages).includes("기술 수준:") && JSON.stringify(tq.messages).includes("I-003 등대 렌즈"));
  check("시대착오 카드", (await page.textContent("#techOut")).includes("등대 렌즈의 정밀 연마") && (await page.textContent("#techOut")).includes("등대 렌즈(I-003)"));
  await page.click('#techOut [data-act="tp-chat"]');
  check("시대착오 → 대화", (await page.inputValue("#input")).includes("시대착오로 보이는 곳"));
  await page.fill("#input", "");

  // ---- 12. 사물 생성기 ----
  await page.click("#toolsBtn");
  await page.click('#sheetBody details.ct summary:has-text("사물 생성기")');
  await page.selectOption("#ig-kind", "무기");
  await page.selectOption("#ig-rarity", "희귀");
  quick.push(JSON.stringify({ name: "안개 가르는 작살", summary: "안개를 가르는 작살", item: { looks: "고래뼈 자루", material: "고래뼈와 쇠", size: "길이 두 걸음", use: "안개 속 사냥", value: "금화 3닢", rarity: "희귀", make: "등대 교단 대장간", state: "날이 무뎌짐" }, history: "첫 안개 사냥꾼이 썼다", hook: "작살이 가리키는 쪽에 섬이 있다" }));
  await page.click('#sheetBody [data-ct="itemgen"]');
  await page.waitForSelector("#igOut .gen-place");
  const iq = quickReqs.at(-1).body;
  check("사물 생성기: 요청에 종류·희귀도·기술·물가", JSON.stringify(iq.messages).includes("종류: 무기") && JSON.stringify(iq.messages).includes("희귀도: 희귀") && JSON.stringify(iq.messages).includes("기술 수준:") && JSON.stringify(iq.messages).includes("화폐: 기준 은화"));
  await page.click('#sheetBody [data-ct="itemgen-save"]');
  await page.waitForSelector("#sheetBody .entry-name");
  const gen = (await idbGet("entries:" + wid0)).find((x) => x.name === "안개 가르는 작살");
  check("사물 생성기 저장(초안·카드·내력)", gen && gen.status === "draft" && gen.item.material === "고래뼈와 쇠" && gen.body.includes("## 내력") && (await page.$eval('#sheetBody [data-etab="card"]', (el) => el.getAttribute("aria-selected"))) === "true");
  await closeSheet();

  // ---- 13. 비교 ----
  await tab("codex");
  await page.click('#codex [data-act="compare"]');
  const eg = await page.$$eval("#sheetBody [data-cmpgroup]", (els) => els.map((x) => x.dataset.cmpgroup));
  check("비교: 사건·사물 분류", eg.includes("event") && eg.includes("item"), eg.join());
  await page.click('#sheetBody [data-cmpgroup="event"]');
  await page.check('.pick input[value="E-001"]');
  await page.check('.pick input[value="E-002"]');
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("사건 비교: 전말·참여자·인과", st.includes("등대가 꺼져 항로가 끊김") && st.includes("등대 교단[주동]") && st.includes("원인") && st.includes("대등화"));
  await closeSheet();
  await page.click('#codex [data-act="compare"]');
  await page.click('#sheetBody [data-cmpgroup="item"]');
  await page.check('.pick input[value="I-001"]');
  await page.check('.pick input[value="I-003"]');
  await page.click('#sheetBody [data-act="cmp"]');
  await page.waitForSelector("#sheetBody .cmp");
  st = await page.textContent("#sheetBody .cmp");
  check("사물 비교: 카드·마법·가진 이·재료", st.includes("청동") && st.includes("등명 계약") && st.includes("서리") && st.includes("고래기름"));
  await closeSheet();

  // ---- 14. 좁은 화면 ----
  await page.setViewportSize({ width: 360, height: 760 });
  for (const [id, t] of [["E-002", "causal"], ["I-003", "craft"], ["I-001", "card"], ["C-001", null]]) {
    await openE(id, t);
    const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, sheet: document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth }));
    check(`360px: ${id} 가로 넘침 없음`, over.doc <= 360 && over.sheet <= 1, JSON.stringify(over));
  }
  await closeSheet();
  for (const m of ["causal", "cal", "list"]) {
    await tlmode(m);
    check(`360px: 연표 ${m} 넘침 없음`, (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  }
  await tab("codex");
  await page.click('#codex [data-act="economy"]');
  check("360px: 화폐·물가 넘침 없음", (await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth])).every((v, i) => (i ? v <= 1 : v <= 360)));
  await page.screenshot({ path: `${SHOTS}/149-economy-360.png` });
  await closeSheet();

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
