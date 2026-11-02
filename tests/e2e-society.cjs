// 사회 체계(v15): 신앙(교단·신격·신자 분포·신앙의 날), 법과 제도(법 탭·법전·이곳의 법), 용어집(탭·원고 속 용어·새 낱말 찾기),
// 천문(달 위상·요일·별자리·천문 사건), get_plan의 이곳의 법·그날의 하늘, 첫 메시지, 현황판·연도 단면·빈 곳 지도·문서 내보내기
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const L = require("./lib.cjs");
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V14 = L.PROMPT_SET(14);
const seed = require(path.join(L.TESTS, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8795);

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
  const entry = async (id) => (await idbGet("entries:" + wid0)).find((e) => e.id === id);
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const trOf = (i) => requests[i].body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const openE = async (id, t) => { await tab("codex"); if (await page.$('#codex [data-ctab="entries"][aria-selected="false"]')) await page.click('#codex [data-ctab="entries"]'); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); if (t) { await page.click(`#sheetBody [data-etab="${t}"]`); await page.waitForTimeout(120); } };

  await page.goto("http://localhost:8795/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  const wid0 = await wid();
  // 신·신격 분류와 항목, 항구
  const ws = await idbGet("worlds");
  const w0 = ws.find((w) => w.id === wid0);
  const DEF = [["character", "인물", "C"], ["place", "장소", "P"], ["faction", "세력", "F"], ["species", "종족", "S"], ["event", "사건", "E"], ["item", "사물", "I"], ["concept", "개념", "K"], ["other", "기타", "X"]];
  if (!w0.types?.length) w0.types = DEF.map(([key, label, code]) => ({ key, label, code, color: key, desc: "", template: "" }));
  w0.types.push({ key: "deity", label: "신·신격", code: "D", color: "concept", desc: "신과 신격", template: "" });
  w0.counters = { ...(w0.counters || {}), D: 2, P: 2 };
  await idbSet("worlds", ws);
  const ents = await idbGet("entries:" + wid0);
  const now = Date.now();
  const mk = (o) => ({ aliases: [], fields: {}, body: "", tags: [], relations: [], status: "canon", createdAt: now, updatedAt: now, updatedBy: "user", history: [], ...o });
  ents.push(
    mk({ id: "D-001", type: "deity", name: "불의 어머니", summary: "등대의 불을 낳은 신", relations: [{ to: "D-002", label: "어머니" }] }),
    mk({ id: "D-002", type: "deity", name: "안개의 아이", summary: "안개를 다스리는 신" }),
    mk({ id: "P-002", type: "place", name: "바람꼬리 항구", summary: "등대 아래 항구", relations: [{ to: "F-003", label: "통치", since: 300 }] }),
  );
  await idbSet("entries:" + wid0, ents);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. v15 도구 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "set_faith", id: "f1", input: { id: "F-002", doctrine: "불은 기억으로 산다", rites: "해 질 녘 등불을 올린다", deities: ["D-001"], holy_places: ["P-001"], heresies: [{ name: "무등파", belief: "불을 꺼야 안개가 돌아온다", status: "박해" }] } },
    { tool: "set_faith", id: "f2", input: { id: "F-002", deities: ["D-999"] } },
    { tool: "set_deity", id: "d1", input: { id: "D-001", domains: "불과 기억", symbols: "꺼지지 않는 심지" } },
    { tool: "set_faith_share", id: "s1", input: { place_id: "P-001", shares: [{ faith_id: "F-002", pct: 70 }, { faith_id: "F-001", pct: 20 }] } },
    { tool: "set_faith_share", id: "s2", input: { place_id: "P-002", shares: [{ faith_id: "F-002", pct: 80 }, { faith_id: "F-001", pct: 30 }] } },
    { tool: "set_law", id: "l1", input: { faction_id: "F-003", name: "야간 등화 금지령", kind: "금지", text: "밤에 항구에서 불을 켜지 않는다", penalty: "벌금 은화 10닢", place_ids: ["P-002"] } },
    { tool: "set_law", id: "l2", input: { faction_id: "F-003", name: "항구세", kind: "의무", text: "배는 입항세를 낸다", since: 310 } },
    { tool: "set_law", id: "l3", input: { faction_id: "F-003", name: "x", kind: "벌칙", text: "y" } },
    { tool: "set_term", id: "t1", input: { term: "등명", meaning: "등대에 바친 기억의 이름", category: "의례", example: "그는 세 번째 등명을 올렸다" } },
    { tool: "set_term", id: "t2", input: { term: "새말" } },
    { tool: "set_sky", id: "k1", input: { moons: [{ name: "은달", period: 30, offset: 0 }, { name: "붉은달", period: 45, offset: 10 }], weekdays: ["불", "물", "바람", "흙", "별"], stars: [{ name: "등대자리", months: ["3월", "4"], meaning: "길잡이" }], events: [{ name: "대일식", kind: "일식", year: 312, month: "3월", day: 2 }] } },
    { tool: "set_observance", id: "o1", input: { name: "등불제", month: "3월", day: 2, kind: "축제", faith_id: "F-002" } },
    { tool: "set_work", id: "w1", input: { title: "등대지기의 딸", chapters: [{ title: "1장" }] } },
    { tool: "set_scene_card", id: "c1", input: { work_id: "등대지기의 딸", chapter: "1장", title: "항구의 밤", summary: "서리가 밤에 항구로 간다", pov: "C-001", place: "P-002", year: 320, month: "3월", day: 2, goal: "등불을 켠다", conflict: "금지령", outcome: "붙잡힌다" } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "정했어요." } }], "tool_use"));
  await send("사회 체계를 정하자", 2);
  const r1 = requests[0];
  const tn = r1.body.tools.map((t) => t.name);
  check("v15 지침: 신앙과 법·용어와 하늘", r1.body.system[0].text.includes("## 신앙과 법") && r1.body.system[0].text.includes("## 용어와 하늘") && r1.body.system[0].text.includes("## 비밀과 앎"));
  check("v15 도구 47개", tn.length === 47 && ["set_faith", "set_deity", "set_faith_share", "set_law", "set_term", "set_sky"].every((n) => tn.includes(n)) && tn.at(-1) === "respond" && !!r1.body.tools.find((t) => t.name === "set_observance").input_schema.properties.faith_id, tn.length);
  const tr = trOf(1);
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("거부: 없는 신·합 100 넘음·없는 종류·뜻 없는 새 용어", res("f2").is_error && txt("f2").includes("D-999") && res("s2").is_error && txt("s2").includes("100") && res("l3").is_error && txt("l3").includes("kind") && res("t2").is_error && txt("t2").includes("meaning"));
  check("나머지 성공", ["f1", "d1", "s1", "l1", "l2", "t1", "k1", "o1", "w1", "c1"].every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error).map((b) => [b.tool_use_id, b.content])));
  const f2 = await entry("F-002");
  check("신앙 저장", f2.faith.doctrine === "불은 기억으로 산다" && f2.faith.deities.join() === "D-001" && f2.faith.holy.join() === "P-001" && f2.faith.heresies[0].status === "박해" && (await entry("F-002")).faith.deities.length === 1);
  check("신격·신자 분포 저장(거부된 것은 바뀌지 않음)", (await entry("D-001")).deity.domains === "불과 기억" && (await entry("P-001")).faiths.length === 2 && !(await entry("P-002")).faiths);
  const f3 = await entry("F-003");
  check("법 저장", f3.laws.length === 2 && f3.laws[0].places.join() === "P-002" && f3.laws[1].since === 310);
  let w = await world();
  check("용어·하늘·신앙의 날 저장", w.glossary[0].term === "등명" && w.calendar.moons.length === 2 && w.calendar.weekdays.length === 5 && w.sky.stars[0].months.join() === "3,4" && w.sky.events[0].month === 3 && w.observances.find((o) => o.name === "등불제").faith === "F-002");
  // get_plan: 이곳의 법·그날의 하늘
  const sc = ((await idbGet("ms:" + wid0)) || []).find((m) => m.title === "항구의 밤");
  queue.push(() => msg("b1", [{ tool: "get_plan", id: "g1", input: { scene_id: sc.id } }, { tool: "get_entries", id: "g2", input: { ids: ["F-002", "F-003"] } }], "tool_use"));
  queue.push(() => msg("b2", [{ tool: "respond", id: "rr2", input: { message: "봤어요." } }], "tool_use"));
  const nb = requests.length;
  await send("장면 확인", nb + 2);
  const g1 = JSON.stringify(trOf(nb + 1).find((b) => b.tool_use_id === "g1").content);
  const g2 = JSON.stringify(trOf(nb + 1).find((b) => b.tool_use_id === "g2").content);
  check("get_plan: 이곳의 법(지역 법 + 다스리는 세력의 법)", g1.includes("이곳의 법") && g1.includes("야간 등화 금지령") && g1.includes("항구세"), g1.slice(g1.indexOf("이곳의 법"), g1.indexOf("이곳의 법") + 300));
  check("get_plan: 그날의 하늘(달 위상·요일·별자리)", g1.includes("그날의 하늘") && g1.includes("은달 보름") && g1.includes("붉은달 기우는 달") && g1.includes("물요일") && g1.includes("등대자리"), g1.slice(g1.indexOf("그날의 하늘"), g1.indexOf("그날의 하늘") + 200));
  check("항목 글: 신앙·법", g2.includes("교리: 불은 기억으로 산다") && g2.includes("모시는 신: 불의 어머니") && g2.includes("법:") && g2.includes("야간 등화 금지령"));
  // 첫 메시지
  await page.click("#newThreadBtn");
  const nc = requests.length;
  await send("이어서", nc + 1);
  const ctxText = requests[nc].body.messages[0].content.map((b) => b.text || "").join("");
  check("첫 메시지: 용어집·하늘·신앙·법", ctxText.includes("용어집(1): 등명=") && ctxText.includes("하늘: 달 은달(30일)") && ctxText.includes("신앙: 등대 교단") && ctxText.includes("법: 2개"));
  // v14 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 14;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b14 = requests.length;
  await send("하나 더", b14 + 1);
  check("v14 대화는 v14 지침·도구 그대로", requests[b14].body.system[0].text === V14.system && JSON.stringify(requests[b14].body.tools) === JSON.stringify(V14.tools));

  // ---- 2. 신앙·신격 화면 ----
  await openE("F-002", "faith");
  let t = await sheetText();
  check("교단: 신앙 탭(교리·신·성지·이단·신자 분포·신앙의 날)", t.includes("불은 기억으로 산다") && t.includes("불의 어머니") && t.includes("잿빛 첨탑 등대") && t.includes("무등파") && t.includes("70%") && t.includes("등불제"));
  check("신들의 관계는 교단이 모신 신끼리만", !t.includes("안개의 아이"));
  await page.screenshot({ path: path.join(SHOTS, "210-faith.png") });
  await page.click('#sheetBody [data-act="faith-edit"]');
  await page.waitForSelector("#faithForm");
  await page.fill('#faithForm [data-k="taboos"]', "불을 입으로 끄지 않는다");
  await page.check('#faithForm [data-god="D-002"]');
  await page.click('#faithForm [type="submit"]');
  await page.waitForTimeout(250);
  check("신앙 편집 저장", (await entry("F-002")).faith.taboos === "불을 입으로 끄지 않는다" && (await entry("F-002")).faith.deities.length === 2);
  check("이제 두 신의 관계가 보임", (await sheetText()).includes("불의 어머니 → 어머니 → 안개의 아이"));
  await openE("F-001");
  check("교단이 아닌 세력에는 신앙 탭 없음, 법 탭은 있음", !(await page.$('#sheetBody [data-etab="faith"]')) && !!(await page.$('#sheetBody [data-etab="law"]')));
  await openE("D-001", "deity");
  t = await sheetText();
  check("신격 탭: 다스리는 것·섬기는 신앙", t.includes("불과 기억") && t.includes("섬기는 신앙") && t.includes("등대 교단"));
  await openE("P-001", "people");
  t = await sheetText();
  check("장소 사람들 탭: 신자 분포", t.includes("신자 분포") && t.includes("등대 교단 70%"));
  await page.click('#sheetBody [data-act="faith-share-edit"]');
  await page.waitForSelector("#fsForm");
  check("신자 분포 편집: 신앙 세력이 아닌 세력 줄도 남음", (await page.$$eval("#fsForm .fr", (els) => els.map((e) => e.value))).join() === "F-002,F-001");
  await page.fill("#fsForm .fs-row:first-child .fp", "90");
  await page.click('#fsForm [type="submit"]');
  await page.waitForTimeout(200);
  check("신자 분포: 합 100 넘으면 거부", (await page.evaluate(() => document.querySelector("#toast")?.textContent || "")).includes("100"));
  await closeSheet();

  // ---- 3. 법 ----
  await openE("F-003", "law");
  t = await sheetText();
  check("법 탭: 종류별·처벌·지역·기간", t.includes("금지") && t.includes("야간 등화 금지령") && t.includes("벌금 은화 10닢") && t.includes("바람꼬리 항구") && t.includes("의무") && t.includes("항구세") && t.includes("다스리는 곳: 바람꼬리 항구"));
  await page.click('#sheetBody [data-act="law-add"]');
  await page.waitForSelector("#lawForm");
  await page.fill("#lw-name", "등명 의무");
  await page.check('[name="lw-kind"][value="의무"]');
  await page.fill("#lw-text", "등대지기는 해마다 기억 하나를 바친다");
  await page.fill("#lw-since", "330");
  await page.fill("#lw-until", "320");
  await page.click('#lawForm [type="submit"]');
  check("법 편집: 폐지가 시행보다 앞서면 거부", (await page.evaluate(() => document.querySelector("#toast")?.textContent || "")).includes("앞섭니다"));
  await page.fill("#lw-until", "");
  await page.click('#lawForm [type="submit"]');
  await page.waitForTimeout(250);
  check("법 더하기 저장", (await entry("F-003")).laws.length === 3);
  await page.click('#sheetBody [data-act="law-code"]');
  await page.waitForSelector("#lc-place");
  t = await sheetText();
  check("법전: 다스리는 곳(항구)의 그해 법", (await page.inputValue("#lc-place")) === "P-002" && t.includes("야간 등화 금지령") && t.includes("항구세") && !t.includes("등명 의무"));
  await page.fill("#lc-year", "305");
  await page.dispatchEvent("#lc-year", "change");
  await page.waitForTimeout(200);
  t = await sheetText();
  check("법전 305년: 시행 전 법은 빠짐", t.includes("야간 등화 금지령") && !t.includes("항구세"));
  await page.screenshot({ path: path.join(SHOTS, "211-lawcode.png") });
  await closeSheet();

  // ---- 4. 용어집 ----
  await tab("codex");
  await page.click('#codex [data-ctab="glossary"]');
  await page.waitForSelector("#glSearch");
  check("용어집 탭: 낱말·뜻·분류", (await page.textContent("#codex .gl-list")).includes("등명") && (await page.textContent("#codex .gl-list")).includes("등대에 바친 기억의 이름"));
  await page.click('#codex [data-act="gl-new"]');
  await page.waitForSelector("#termForm");
  await page.fill("#gl-term", "등명");
  await page.fill("#gl-mean", "중복");
  await page.click('#termForm [type="submit"]');
  check("같은 낱말 거부", (await page.evaluate(() => document.querySelector("#toast")?.textContent || "")).includes("이미"));
  await page.fill("#gl-term", "안개값");
  await page.fill("#gl-mean", "안개 속 뱃길 안내료");
  await page.fill("#gl-cat", "화폐");
  await page.click('#termForm [type="submit"]');
  await page.waitForTimeout(250);
  check("용어 더하기", (await world()).glossary.length === 2);
  await page.fill("#glSearch", "화폐");
  await page.waitForTimeout(150);
  check("용어 찾기", (await page.$$("#codex .gl-item")).length === 1);
  await page.fill("#glSearch", "");
  await page.waitForTimeout(100);
  // 원고에 용어가 나오면 원고 화면에 뜻
  const mss = await idbGet("ms:" + wid0);
  mss.find((m) => m.title === "항구의 밤").body = "서리는 등명을 떠올리며 안개값을 치렀다. 뱃사람이 쑥불을 피웠다.";
  await idbSet("ms:" + wid0, mss);
  await page.reload(); await page.waitForSelector("#app");
  quick.push(JSON.stringify({ words: [{ term: "쑥불", meaning: "뱃사람이 안개를 쫓으려 피우는 불", example: "뱃사람이 쑥불을 피웠다" }, { term: "등명", meaning: "x", example: "" }] }));
  await tab("codex");
  await page.click('#codex [data-ctab="glossary"]');
  await page.waitForSelector("#glSearch");
  await page.click('#codex [data-act="gl-find"]');
  await page.waitForSelector("[data-nw]");
  check("새 낱말 찾기: 아는 낱말은 빼고 보냄·결과에서도 뺌", quickReqs.at(-1).body.messages[0].content.includes("이미 아는 낱말: 등명") && (await page.$$("[data-nw]")).length === 1);
  await page.click('[data-act="nw-add"]');
  await page.waitForTimeout(250);
  check("새 낱말 넣기", (await world()).glossary.some((g) => g.term === "쑥불"));
  await page.click('#codex [data-ctab="ms"]');
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('#codex [data-msview="all"]')?.click());
  await page.waitForTimeout(150);
  await page.click(`#codex [data-ms="${sc.id}"]`);
  await page.waitForSelector("#sheetBody .ms-body");
  t = await sheetText();
  check("원고 화면: 용어와 뜻", t.includes("용어:") && t.includes("등명") && t.includes("안개값") && t.includes("쑥불"));
  await closeSheet();

  // ---- 5. 하늘 편집·현황판·연도 단면·기념일 ----
  await tab("timeline");
  await page.click('#timeline [data-tlmode="cal"]');
  await page.waitForTimeout(150);
  check("달력 보기: 하늘 요약", (await page.textContent("#timeline")).includes("은달(30일)"));
  await page.click('#timeline [data-calv="sky"]');
  await page.waitForSelector("#skyForm");
  check("하늘 편집: 기존 값", (await page.$$("#skyForm .moon-row")).length === 2 && (await page.inputValue("#sk-wd")).includes("바람") && (await page.$$("#skyForm .skyev-row")).length === 1);
  await page.fill("#skyForm .moon-row:first-child .mp", "0");
  await page.click('#skyForm [type="submit"]');
  check("하늘 편집: 잘못된 주기 거부", (await page.evaluate(() => document.querySelector("#toast")?.textContent || "")).includes("period"));
  await page.fill("#skyForm .moon-row:first-child .mp", "30");
  await page.fill("#sk-wd", "불, 물, 바람, 흙, 별, 달");
  await page.click('#skyForm [type="submit"]');
  await page.waitForTimeout(250);
  w = await world();
  check("하늘 편집 저장(달력의 다른 값은 그대로)", w.calendar.weekdays.length === 6 && w.calendar.moons.length === 2 && Array.isArray(w.calendar.months) === Array.isArray(w0.calendar?.months) && w.log === undefined);
  await page.click('#timeline [data-tlmode="list"]');
  await page.waitForTimeout(100);
  await page.click('#timeline [data-tl="slice"]');
  await page.waitForSelector("#sl-year");
  await page.fill("#sl-year", "312");
  await page.dispatchEvent("#sl-year", "change");
  await page.waitForTimeout(200);
  check("연도 단면 312: 하늘(대일식)", (await sheetText()).includes("대일식"));
  await page.fill("#sl-year", "310");
  await page.dispatchEvent("#sl-year", "change");
  await page.waitForTimeout(200);
  check("연도 단면 310: 법 시행(항구세)", (await sheetText()).includes("법 시행") && (await sheetText()).includes("항구세"));
  await closeSheet();
  await tab("codex");
  await page.click('#codex [data-ctab="ms"]');
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('#codex [data-msview="works"]')?.click());
  await page.waitForTimeout(120);
  await page.click('#codex [data-wtab="board"]');
  await page.waitForTimeout(150);
  await page.click(`#codex [data-card-status="${sc.id}"]`);
  await page.waitForTimeout(200);
  t = await sheetText();
  check("현황판: 이곳의 법·신앙·하늘", t.includes("이곳의 법·신앙·하늘") && t.includes("야간 등화 금지령") && t.includes("은달 보름"));
  await page.click("[data-law-code]");
  await page.waitForSelector("#lc-place");
  check("현황판 → 법전(그 장소·그해)", (await page.inputValue("#lc-place")) === "P-002" && (await page.inputValue("#lc-year")) === "320");
  await closeSheet();

  // ---- 6. 빈 곳 지도·문서 내보내기 ----
  await tab("codex");
  await page.click('#codex [data-ctab="entries"]');
  await page.click('#codex [data-act="coverage"]');
  await page.waitForSelector(".cov-grid");
  t = await sheetText();
  check("빈 곳 지도: 새 신호(신앙·법·용어집·하늘)", t.includes("교리를 정한 신앙") && t.includes("신격 항목") && t.includes("법") && t.includes("용어집") && t.includes("달·요일·하늘"));
  await closeSheet();
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-md"]')]);
  const md = fs.readFileSync(await dl.path(), "utf8");
  check("문서 내보내기: 용어집·하늘", md.includes("## 용어집") && md.includes("**등명**") && md.includes("## 하늘") && md.includes("은달(30일)"));

  // ---- 7. 화면 폭 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await openE("F-002", "faith");
  check("360px: 신앙 탭 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1);
  await closeSheet();
  await tab("timeline");
  await page.click('#timeline [data-tlmode="cal"]');
  await page.click('#timeline [data-calv="sky"]');
  await page.waitForSelector("#skyForm");
  check("360px: 하늘 편집 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1);
  await closeSheet();
  await page.click('#timeline [data-tlmode="list"]');

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
