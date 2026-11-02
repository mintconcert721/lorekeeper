// 이야기 계획(v13): 구조 사다리(한 줄 → 한 문단 → 시놉시스 → 장 요약 → 장면 카드 → 본문), 단계 상태(초안·확정·다시 볼 것),
// Claude 도구(get_plan·set_plan·set_scene_card)와 계획 따라 쓰기 지침, Claude로 펼치기(한 문단·시놉시스·장·카드),
// 카드판·카드 편집, 장면 현황판(나이·생사·세력·기념일·이동 시간), 구조 점검·연재 점검, 연재 회차 표시
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const L = require("./lib.cjs");
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V12 = L.PROMPT_SET(12);
const seed = require(path.join(L.TESTS, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8791);

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
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const mss = async () => (await idbGet("ms:" + wid0)) || [];
  const msBy = async (title) => (await mss()).find((m) => m.title === title);
  const sheetText = () => page.textContent("#sheetBody");
  const toastText = async () => { await page.waitForTimeout(150); return page.evaluate(() => document.querySelector("#toast")?.textContent || ""); };
  const openPlan = async (t = "plan") => { await tab("codex"); await page.click('#codex [data-ctab="ms"]'); await page.waitForTimeout(150); if (await page.$('#codex [data-msview="works"]')) await page.click('#codex [data-msview="works"]'); await page.waitForTimeout(100); await page.click(`#codex [data-wtab="${t}"]`); await page.waitForTimeout(150); };
  const rungBadge = (key) => page.evaluate((k) => document.querySelector(`#codex .rung[data-rung="${k}"] .lv-badge`)?.textContent || "", key);
  const trOf = (i) => requests[i].body.messages.at(-1).content.filter((b) => b.type === "tool_result");

  await page.goto("http://localhost:8791/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  const wid0 = await wid();
  // 장소 하나 더, 길, 기념일
  const ents = await idbGet("entries:" + wid0);
  const now = Date.now();
  ents.push({ id: "P-002", type: "place", name: "바람꼬리 항구", aliases: [], summary: "등대 아래 항구", fields: {}, body: "", tags: [], relations: [{ to: "F-003", label: "통치" }], status: "canon", createdAt: now, updatedAt: now, updatedBy: "user", history: [], climate: { seasons: { 봄: "짙은 아침 안개" }, climate: "서늘한 해양성" } });
  await idbSet("entries:" + wid0, ents);
  const ws0 = await idbGet("worlds");
  const w0 = ws0.find((w) => w.id === wid0);
  w0.routes = [{ a: "P-001", b: "P-002", dist: 300 }];
  w0.observances = [{ id: "ob1", name: "등불제", kind: "축제", month: 3, day: 2, days: 1 }];
  w0.counters = { ...(w0.counters || {}), P: 2 };
  await idbSet("worlds", ws0);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. v13 지침·도구: 계획과 카드 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "set_work", id: "w1", input: { title: "등대지기의 딸", logline: "기억을 바쳐 불을 켜는 견습 등대지기가 꺼져 가는 등대를 지킨다", chapters: [{ title: "1장 꺼진 불" }, { title: "2장 안개 속으로" }] } },
    { tool: "set_plan", id: "p1", input: { work_id: "등대지기의 딸", paragraph: "시작: 서리는 견습 등대지기다.\n위기 1: 등대가 꺼진다.\n위기 2: 무등회가 섬을 노린다.\n위기 3: 서리는 어머니의 기억을 바쳐야 한다.\n결말: 불은 다시 켜지고 서리는 어머니를 잊는다.", synopsis: "서리는 등대에서 일한다.\n\n불이 꺼진다.", chapters: [{ title: "1장 꺼진 불", summary: "등대가 꺼지고 서리가 이유를 찾기 시작한다." }, { title: "3장 마지막 기억", summary: "서리가 기억을 바친다." }] } },
    { tool: "set_plan", id: "p2", input: { work_id: "등대지기의 딸", chapters: [{ id: "ch-없음", summary: "x" }] } },
    { tool: "set_scene_card", id: "c1", input: { work_id: "등대지기의 딸", chapter: "1장 꺼진 불", title: "꺼진 등대", summary: "서리가 꺼진 불을 발견한다.", pov: "C-001", place: "P-001", cast: ["C-012", "C-001"], year: 320, month: "3월", day: 1, goal: "불을 다시 켠다", conflict: "등명부가 찢겨 있다", outcome: "불을 켜지 못하고 무등회의 표식을 본다", decision: "항구로 내려가 단서를 찾는다", value: "희망", turn: "＋→－", tension: 3 } },
    { tool: "set_scene_card", id: "c2", input: { work_id: "등대지기의 딸", chapter: "1장 꺼진 불", title: "잘못된 카드", pov: "없는인물", goal: "x" } },
    { tool: "set_scene_card", id: "c3", input: { work_id: "등대지기의 딸", chapter: "1장 꺼진 불", title: "긴장 초과", tension: 9 } },
    { tool: "set_scene_card", id: "c4", input: { work_id: "등대지기의 딸", chapter: "1장 꺼진 불", title: "항구의 아침", summary: "서리가 항구에서 등불제를 본다.", pov: "C-001", place: "P-002", cast: ["C-013"], year: 320, month: "3월", day: 2, goal: "단서를 찾는다", conflict: "축제 인파", outcome: "무등회 신도를 놓친다", turn: "－→－" } },
    { tool: "get_plan", id: "g1", input: { work_id: "등대지기의 딸" } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "계획을 세웠어요." } }], "tool_use"));
  await send("작품 계획을 세우자", 2);
  const r1 = requests[0];
  const tn = r1.body.tools.map((t) => t.name);
  check("v13 지침: 이야기 계획·카드 범위", r1.body.system[0].text.includes("## 이야기 계획") && r1.body.system[0].text.includes("카드의 결과에서 끝낸다") && r1.body.system[0].text.includes("계획 밖 아이디어"));
  check("새 대화(v15) 도구 47개: get_plan·set_plan·set_scene_card, 끝은 respond", tn.length === 47 && ["get_plan", "set_plan", "set_scene_card"].every((n) => tn.includes(n)) && tn.at(-1) === "respond", tn.length);
  // v15에서 set_observance에 faith_id가 붙었으므로 그 하나를 빼고 v12 도구와 같아야 한다
  check("v12에서 이어진 도구는 그대로(set_observance만 확장)", JSON.stringify(r1.body.tools.filter((t) => t.name !== "set_observance" && V12.tools.some((x) => x.name === t.name))) === JSON.stringify(V12.tools.filter((t) => t.name !== "set_observance")) && !!r1.body.tools.find((t) => t.name === "set_observance").input_schema.properties.faith_id);
  const tr = trOf(1);
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("거부: 없는 장 id(아무것도 안 바뀜)", res("p2").is_error && txt("p2").includes("ch-없음"));
  check("거부: 없는 시점 인물", res("c2").is_error && txt("c2").includes("없는인물"));
  check("거부: 긴장도 범위", res("c3").is_error && txt("c3").includes("1에서 5"));
  check("나머지 성공", ["w1", "p1", "c1", "c4", "g1"].every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error).map((b) => [b.tool_use_id, b.content])));
  check("잘못된 카드는 장면을 만들지 않음", !(await msBy("잘못된 카드")) && !(await msBy("긴장 초과")));
  check("get_plan: 단계·장·카드·진행·다음 장면", ["한 문단 [초안]", "시놉시스 [초안]", "1장 꺼진 불", "3장 마지막 기억", "목표: 불을 다시 켠다", "진행: 장 요약 2/3", "카드 2/2", "다음에 쓸 장면:", "꺼진 등대"].every((s) => txt("g1").includes(s)), txt("g1").slice(0, 600));
  let w = await world();
  let wk = w.works[0];
  check("계획 저장: 한 문단·시놉시스·장 요약·새 장", wk.plan.paragraph.startsWith("시작: 서리") && wk.plan.synopsis.includes("불이 꺼진다") && wk.chapters.length === 3 && wk.chapters[0].summary.includes("이유를 찾기") && wk.chapters[2].title === "3장 마지막 기억" && wk.plan.lv.paragraph.ok === false);
  let card1 = await msBy("꺼진 등대");
  check("카드 저장: 인물·장소·때·등장(시점 인물 뺌)·전환·긴장", card1.card.pov === "C-001" && card1.card.place === "P-001" && card1.card.when.year === 320 && card1.card.when.month === 3 && card1.card.when.day === 1 && card1.card.cast.join() === "C-012" && card1.card.turn === "＋→－" && card1.card.tension === 3 && card1.status === "구상" && !card1.body);
  // get_plan(scene_id): 앞 결과·다음 카드
  const harborId = (await msBy("항구의 아침")).id;
  queue.push(() => msg("b1", [{ tool: "get_plan", id: "g2", input: { scene_id: harborId } }], "tool_use"));
  queue.push(() => msg("b2", [{ tool: "respond", id: "rr2", input: { message: "봤어요." } }], "tool_use"));
  const nb = requests.length;
  await send("두 번째 장면 카드 보여줘", nb + 2);
  const g2 = JSON.stringify(trOf(nb + 1).find((b) => b.tool_use_id === "g2").content);
  check("get_plan(scene_id): 장 요약·앞 장면 결과·결정·마지막 장면", g2.includes("장 요약: 등대가 꺼지고") && g2.includes("앞 장면") && g2.includes("결과 불을 켜지 못하고") && g2.includes("결정 항구로 내려가") && g2.includes("2/2번째 장면") && g2.includes("다음 장면: 없음"), g2.slice(0, 500));
  // set_work로 장 이름을 바꿔도 요약이 남는다
  queue.push(() => msg("b3", [{ tool: "set_work", id: "sw", input: { work_id: wk.id, chapters: wk.chapters.map((c, i) => ({ id: c.id, title: i === 0 ? "1장 꺼진 등불" : c.title })) } }], "tool_use"));
  queue.push(() => msg("b4", [{ tool: "respond", id: "rr3", input: { message: "바꿨어요." } }], "tool_use"));
  const nc = requests.length;
  await send("1장 이름 바꿔", nc + 2);
  w = await world();
  wk = w.works[0];
  check("set_work로 장 이름을 바꿔도 요약 유지", wk.chapters[0].title === "1장 꺼진 등불" && wk.chapters[0].summary.includes("이유를 찾기"));
  // 새 대화 현황
  await page.click("#newThreadBtn");
  const nd = requests.length;
  await send("이어서 쓰자", nd + 1);
  const ctxText = requests[nd].body.messages[0].content.map((b) => b.text || "").join("");
  check("새 대화 현황: 이야기 계획·다음에 쓸 장면", ctxText.includes("이야기 계획(장면 본문은 카드 범위 안에서 쓴다") && ctxText.includes("다음에 쓸 장면") && ctxText.includes("한 문단: 시작: 서리"), ctxText.slice(ctxText.indexOf("이야기 계획"), ctxText.indexOf("이야기 계획") + 400));
  // v12 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 12;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b12 = requests.length;
  await send("하나 더", b12 + 1);
  check("v12 대화는 v12 지침·도구 그대로", requests[b12].body.system[0].text === V12.system && JSON.stringify(requests[b12].body.tools) === JSON.stringify(V12.tools));

  // ---- 2. 계획 화면: 사다리와 상태 ----
  await openPlan("plan");
  check("계획 탭: 6단계와 진행", (await page.$$("#codex .rung[data-rung]")).length === 6 && (await page.textContent("#codex .plan-progress")).includes("장 요약 2/3") && (await page.textContent("#codex .plan-progress")).includes("카드 2/2"));
  check("한 문단·시놉시스는 초안", (await rungBadge("paragraph")) === "초안" && (await rungBadge("synopsis")) === "초안");
  await page.screenshot({ path: path.join(SHOTS, "170-plan.png"), fullPage: true });
  await page.click('#codex [data-plan="ok-paragraph"]');
  await page.waitForTimeout(150);
  check("한 문단 확정", (await rungBadge("paragraph")) === "확정" && (await world()).works[0].plan.lv.paragraph.ok === true);
  // 한 줄 소개를 고치면 한 문단이 '다시 볼 것'
  await page.click('#codex [data-plan="edit-logline"]');
  await page.fill("#pt-text", "기억을 바쳐 불을 켜는 소녀가 어머니를 잊기로 한다");
  await page.click('#planTextForm [type="submit"]');
  await page.waitForTimeout(200);
  check("한 줄을 고치면 한 문단이 다시 볼 것", (await rungBadge("paragraph")) === "다시 볼 것" && (await page.textContent("#codex .plan-stale")).includes("한 문단"));
  await page.click('#codex [data-plan="ok-paragraph"]');
  await page.waitForTimeout(150);
  check("그대로 두기 → 확정", (await rungBadge("paragraph")) === "확정");
  // 시놉시스를 고치면 장 요약이 다시 볼 것(요약이 있는 장)
  await page.click('#codex [data-plan="edit-synopsis"]');
  await page.fill("#pt-text", "서리는 등대에서 일한다.\n\n불이 꺼지고 무등회가 움직인다.");
  await page.click('#planTextForm [data-ok="1"]');
  await page.waitForTimeout(200);
  check("시놉시스 저장하고 확정", (await rungBadge("synopsis")) === "확정");
  check("장 요약에 다시 볼 것", (await page.textContent('#codex [data-chp]')).includes("다시 볼 것"));
  const chId0 = (await world()).works[0].chapters[0].id;
  await page.click(`#codex [data-ch-ok="${chId0}"]`);
  await page.waitForTimeout(150);
  check("장 요약 그대로 두기 → 확정", (await page.textContent(`#codex [data-chp="${chId0}"]`)).includes("확정"));
  // 장 편집에서 요약
  const chId1 = (await world()).works[0].chapters[1].id;
  await page.click(`#codex [data-chp="${chId1}"] [data-ch-edit]`);
  await page.fill("#ch-sum", "서리가 안개 속으로 배를 띄운다. 무등회의 배를 따라잡는 데서 끝난다.");
  await page.click('#chForm [type="submit"]');
  await page.waitForTimeout(200);
  check("장 편집: 요약 저장(초안)", (await world()).works[0].chapters[1].summary.includes("안개 속으로") && (await page.textContent(`#codex [data-chp="${chId1}"]`)).includes("초안"));

  // ---- 3. Claude로 펼치기 ----
  quick.push(JSON.stringify({ setup: "서리는 기억을 바치지 못한 견습 등대지기다.", crisis1: "등대가 꺼진다.", crisis2: "무등회가 어머니의 기억을 쥐고 있다.", crisis3: "불을 켜려면 어머니를 잊어야 한다.", ending: "서리는 어머니를 잊고 불을 켠다." }));
  await page.click('#codex [data-plan="expand-paragraph"]');
  await page.waitForSelector("#pp-text");
  const qp = quickReqs.at(-1).body;
  check("한 문단 펼치기: 강한 모델·형식·설정집 색인", qp.model === "claude-opus-5-5" && qp.output_config.format.schema.required.includes("ending") && qp.messages[0].content.includes("설정집 색인") && qp.messages[0].content.includes("어머니를 잊기로"));
  check("제안: 다섯 줄", (await page.inputValue("#pp-text")).split("\n").length === 5);
  await page.click('#planPropForm [type="submit"]');
  await page.waitForTimeout(200);
  w = await world();
  check("받아들이면 초안, 시놉시스는 다시 볼 것", w.works[0].plan.paragraph.startsWith("서리는 기억을") && (await rungBadge("paragraph")) === "초안" && (await rungBadge("synopsis")) === "다시 볼 것");
  // 장 펼치기
  const chs = w.works[0].chapters;
  quick.push(JSON.stringify({ chapters: [{ id: chs[0].id, title: chs[0].title, summary: "등대가 꺼진다. 서리는 무등회의 표식을 본다." }, { id: "", title: "1.5장 등불제", summary: "항구 축제에서 단서를 쫓는다." }, { id: chs[1].id, title: chs[1].title, summary: chs[1].summary }, { id: chs[2].id, title: chs[2].title, summary: "서리가 어머니의 기억을 바치고 불이 켜진다." }] }));
  await page.click('#codex [data-plan="expand-chapters"]');
  await page.waitForSelector(".prop-row");
  const rows = await page.$$eval(".prop-row", (els) => els.map((e) => [e.querySelector("input").checked, e.textContent]));
  check("장 제안: 바뀐 장·새 장은 체크, 그대로인 장은 해제", rows.length === 4 && rows[0][0] && rows[0][1].includes("바뀜") && rows[1][0] && rows[1][1].includes("새 장") && !rows[2][0] && rows[2][1].includes("그대로"));
  await page.click('#sheetBody [data-act="accept"]');
  await page.waitForTimeout(200);
  w = await world();
  check("장 반영: 순서·새 장·요약", w.works[0].chapters.map((c) => c.title).join("|") === "1장 꺼진 등불|1.5장 등불제|2장 안개 속으로|3장 마지막 기억" && w.works[0].chapters[0].summary.includes("표식을 본다") && w.works[0].chapters[1].summary.includes("축제"));
  // 카드 펼치기(1장): 있는 장면 + 새 장면, 없는 이름
  const ms1 = await msBy("꺼진 등대");
  const ms2 = await msBy("항구의 아침");
  quick.push(JSON.stringify({ cards: [
    { scene_id: ms1.id, title: "꺼진 등대", summary: "서리가 꺼진 불을 발견한다.", pov: "서리", place: "잿빛 첨탑 등대", goal: "불을 켠다", conflict: "등명부가 찢겼다", outcome: "표식을 본다", decision: "항구로 간다", value: "희망", turn: "＋→－", tension: 3 },
    { scene_id: "", title: "등명부의 빈칸", summary: "서리가 찢긴 쪽을 맞춘다.", pov: "서리", place: "모르는 탑", goal: "누가 찢었는지 안다", conflict: "글씨가 지워졌다", outcome: "어머니의 이름을 찾는다", decision: "어머니를 찾기로 한다", value: "진실", turn: "－→＋", tension: 4 },
  ] }));
  await page.click(`#codex [data-chp="${chId0}"] [data-card-expand]`);
  await page.waitForSelector(".prop-row");
  const qc = quickReqs.at(-1).body.messages[0].content;
  check("카드 펼치기 요청: 장 요약·다음 장·지금 장면", qc.includes("이번 장 1장 꺼진 등불: 등대가 꺼진다") && qc.includes("다음 장 1.5장 등불제") && qc.includes(ms1.id) && qc.includes("decision이 다음 장면의 goal"));
  check("카드 제안: 없는 이름 경고", (await sheetText()).includes("설정집에 없는 이름: 모르는 탑"));
  await page.click('#sheetBody [data-act="accept"]');
  await page.waitForTimeout(250);
  const vellum = await msBy("등명부의 빈칸");
  check("카드 반영: 새 장면(구상)·장소는 비움·순서", vellum && vellum.card.pov === "C-001" && !vellum.card.place && vellum.status === "구상" && vellum.order === 1 && (await msBy("꺼진 등대")).order === 0 && (await msBy("항구의 아침")).order === 2);
  check("있는 장면 카드: 때·등장은 지킴", (await msBy("꺼진 등대")).card.when.year === 320 && (await msBy("꺼진 등대")).card.cast.join() === "C-012");
  check("카드 반영 뒤 카드판으로", (await page.$$("#codex .card-row")).length >= 3);
  await page.screenshot({ path: path.join(SHOTS, "171-board.png"), fullPage: true });

  // ---- 4. 카드 편집·현황판 ----
  await page.click(`#codex [data-card-open="${ms2.id}"]`);
  await page.waitForSelector("#cardForm");
  await page.fill("#cd-day", "40");
  await page.click('#cardForm [data-ok="0"]');
  check("카드 편집: 잘못된 날 거부", (await toastText()).includes("30일까지"));
  await page.fill("#cd-day", "2");
  await page.fill('[data-ck="goal"]', "무등회 신도를 쫓는다");
  await page.check('[name="cd-ten"][value="4"]');
  await page.click('#cardForm [data-ok="1"]');
  await page.waitForTimeout(200);
  let harbor = await msBy("항구의 아침");
  check("카드 편집: 저장하고 확정", harbor.card.goal === "무등회 신도를 쫓는다" && harbor.card.tension === 4 && harbor.card.ok === true && harbor.card.cast.join() === "C-013");
  await page.click(`#codex [data-card-status="${harbor.id}"]`);
  await page.waitForTimeout(200);
  const st = await sheetText();
  check("현황판: 나이(320년 서리 15세)", st.includes("서리") && st.includes("15세"));
  check("현황판: 죽은 인물 경고(노을 301년)", st.includes("노을") && st.includes("죽어") && st.includes("301년에 죽음"));
  check("현황판: 그날의 기념일·계절", st.includes("등불제") && st.includes("봄") && st.includes("짙은 아침 안개"));
  check("현황판: 세력(장소를 통치)", st.includes("해안 공화국") || st.includes("세력"));
  check("현황판: 이동 시간 부족 경고", st.includes("앞 장면에서 오는 길") && st.includes("가장 빨리") && st.includes("1일 차이") || st.includes("일 차이입니다"), st.slice(0, 600));
  await page.screenshot({ path: path.join(SHOTS, "172-status.png") });
  await closeSheet();

  // ---- 5. 이 카드로 쓰기 · 집필 화면 카드 · 본문 다시 볼 것 ----
  await page.click(`#codex [data-card-write="${ms1.id}"]`);
  await page.waitForTimeout(250);
  const inputVal = await page.inputValue("#input");
  check("이 카드로 쓰기: 새 대화에 장면 id·get_plan 요청", inputVal.includes(ms1.id) && inputVal.includes("get_plan") && inputVal.includes("카드의 결과에서 끝내"));
  queue.push(() => msg("d1", [{ tool: "save_manuscript", id: "sv", input: { id: ms1.id, title: "꺼진 등대", kind: "장면", body: "서리는 꺼진 화로 앞에 섰다. 무등회의 표식이 문에 그려져 있었다.", work_id: wk.id } }], "tool_use"));
  queue.push(() => msg("d2", [{ tool: "respond", id: "rd", input: { message: "썼어요." } }], "tool_use"));
  const ne = requests.length;
  await send(null, ne + 2);
  check("본문 저장: bodyAt 기록", !!(await msBy("꺼진 등대")).bodyAt);
  await openPlan("board");
  check("카드판: 본문 글자 수", (await page.textContent(`#codex [data-sc="${ms1.id}"]`)).includes("본문"));
  // 카드를 고치면 본문이 다시 볼 것
  await page.click(`#codex [data-card-open="${ms1.id}"]`);
  await page.waitForSelector("#cardForm");
  await page.fill('[data-ck="outcome"]', "표식을 보고 항구로 달려간다");
  await page.click('#cardForm [data-ok="0"]');
  await page.waitForTimeout(200);
  check("카드를 고치면 본문 다시 볼 것", (await page.textContent(`#codex [data-sc="${ms1.id}"]`)).includes("본문 다시 볼 것"));
  // 집필 화면에 카드
  await page.click('#codex [data-wtab="scenes"]');
  await page.waitForTimeout(150);
  await page.click(`#codex [data-ms="${ms1.id}"]`);
  await page.waitForTimeout(200);
  if (await page.isVisible("#sheet")) { const wbtn = await page.$('#sheetBody [data-act="write"], #sheetBody [data-act="ms-write"]'); if (wbtn) await wbtn.click(); }
  await page.waitForTimeout(200);
  if (!(await page.isVisible("#writer"))) await page.evaluate((id) => openWriter(id), ms1.id);
  await page.waitForSelector("#writer:not([hidden])");
  check("집필 화면: 카드 줄", (await page.textContent("#writer .w-card summary")).includes("항구로 달려간다"));
  await page.fill("#w-body", "서리는 꺼진 화로 앞에 섰다. 표식을 보자마자 항구로 달렸다.");
  await page.click('[data-w="close"]');
  await page.waitForTimeout(300);
  await closeSheet();
  await openPlan("board");
  check("본문을 고치면 다시 볼 것 풀림", !(await page.textContent(`#codex [data-sc="${ms1.id}"]`)).includes("다시 볼 것"));

  // ---- 6. 연재·구조 점검 ----
  await page.click('#codex [data-act="work-edit"]');
  await page.fill("#wk-serial", "5000");
  await page.click('#workForm [type="submit"]');
  await page.waitForTimeout(200);
  await openPlan("plan");
  check("연재: 장 이름에 회차, 분량 막대", (await page.textContent("#codex .ladder")).includes("1화 · 1장 꺼진 등불") && (await page.$$("#codex .ep-bar")).length === 4 && (await page.textContent("#codex .plan-progress")).includes("연재"));
  check("연재 점검 단추", !!(await page.$('#codex [data-plan="check-serial"]')));
  quick.push(JSON.stringify({ summary: "결말까지 이어지지만 2화가 비어 있습니다.", issues: [{ ref: ms2.id, kind: "인과 끊김", severity: "높음", problem: "항구로 간 이유가 약하다", suggestion: "앞 장면 결정과 잇는다" }, { ref: "plan", kind: "결말로 안 이어짐", severity: "낮음", problem: "결말의 대가가 흐리다", suggestion: "잊는 기억을 구체화" }] }));
  await page.click('#codex [data-plan="check-serial"]');
  await page.waitForSelector(".check-issue");
  const qs = quickReqs.at(-1).body.messages[0].content;
  check("연재 점검 요청: 계획·본문 발췌·회차 정보·앱이 찾은 것", qs.includes("연재 점검") && qs.includes("1화 「1장 꺼진 등불」") && qs.includes("서리는 꺼진 화로") && qs.includes("앱이 이미 찾은 것"));
  const cr = await sheetText();
  check("점검 결과: Claude·앱", cr.includes("항구로 간 이유가 약하다") && cr.includes("높음") && cr.includes("앱이 찾은 것") && cr.includes("바뀌지 않습니다(－→－)") && cr.includes("죽어"));
  w = await world();
  check("점검 결과 저장", w.works[0].check.mode === "serial" && w.works[0].check.issues.length === 2 && w.works[0].check.issues[0].severity === "높음");
  await page.screenshot({ path: path.join(SHOTS, "173-check.png"), fullPage: true });
  await page.click(`#sheetBody [data-chk-open="${ms2.id}"]`);
  await page.waitForSelector("#cardForm");
  check("열기 → 카드 편집", (await page.inputValue("#cd-title")) === "항구의 아침");
  await closeSheet();
  await page.click('#codex [data-plan="check-last"]');
  await page.waitForSelector(".check-issue");
  await page.click('[data-fix="c0"]');
  await page.waitForTimeout(250);
  check("Claude와 고치기: 새 대화에 문제·get_plan", (await page.inputValue("#input")).includes("항구로 간 이유가 약하다") && (await page.inputValue("#input")).includes("get_plan"));

  // ---- 문서 내보내기에 계획 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-md"]')]);
  const md = fs.readFileSync(await dl.path(), "utf8");
  check("문서 내보내기: 이야기 계획·카드", md.includes("## 이야기 계획") && md.includes("### 작품 「등대지기의 딸」") && md.includes("#### 1화 · 1장 꺼진 등불") && md.includes("목표: 불을 켠다"));

  // ---- 7. 화면 폭 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await openPlan("plan");
  check("360px: 계획 넘침 없음", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await page.click('#codex [data-wtab="board"]');
  await page.waitForTimeout(150);
  check("360px: 카드판 넘침 없음", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await page.screenshot({ path: path.join(SHOTS, "174-board-360.png"), fullPage: true });
  await page.click('#codex [data-wtab="plan"]');
  await page.waitForTimeout(150);
  for (const k of ["paragraph", "chapters", "body"]) await (await page.$(`#codex .rung[data-rung="${k}"]`)).screenshot({ path: path.join(SHOTS, `175-rung-${k}.png`) });

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
