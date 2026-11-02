// 원고·집필: v12 지침·도구, 작품·장 구조(끌어 정렬·장면 메뉴·장 편집), 작품 설정과 문체 가이드,
// 집필 화면(자동 저장·글자 수·원고지·이전/다음·미리보기), 본문 속 설정 인식(밑줄·칩·무시), 부분 다듬기, 설정 뽑기, 작품에 넣기
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V11 = L.PROMPT_SET(11);
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8785);

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
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const world = async () => (await idbGet("worlds")).find((w) => w.id === wid0);
  const mss = async () => (await idbGet("ms:" + wid0)) || [];
  const msBy = async (title) => (await mss()).find((m) => m.title === title);
  const entry = async (id) => (await idbGet("entries:" + wid0)).find((e) => e.id === id);
  const sheetText = () => page.textContent("#sheetBody");
  const toastText = async () => { await page.waitForTimeout(150); return page.evaluate(() => document.querySelector("#toast")?.textContent || ""); };
  const openMs = async () => { await tab("codex"); await page.click('#codex [data-ctab="ms"]'); await page.waitForTimeout(150); };

  await page.goto("http://localhost:8785/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const wid0 = await wid();

  // ---- 1. v12: Claude가 작품과 장면을 만든다 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "set_work", id: "w1", input: { title: "등대지기의 딸", logline: "기억을 태우는 등대지기의 이야기", chapters: [{ title: "1장 꺼진 불" }, { title: "2장 안개 속으로" }], style: { pov: "3인칭 제한", pov_char: "서리", tense: "과거형", avoid: "갑자기" } } },
    { tool: "set_work", id: "w2", input: { logline: "제목 없음" } },
    { tool: "save_manuscript", id: "s1", input: { title: "등대의 밤", kind: "장면", body: "서리는 잿빛 첨탑 등대에 올랐다. 멀리 무등회의 배가 보였다.\n\n서리는 등명부를 펼쳤다.", work_id: "등대지기의 딸", chapter: "1장 꺼진 불", status: "초고" } },
    { tool: "save_manuscript", id: "s2", input: { title: "안개 속 배", kind: "장면", body: "도윤은 배를 띄웠다. 노을이 남긴 등불이 흔들렸다.", work_id: "등대지기의 딸", chapter: "2장 안개 속으로" } },
    { tool: "save_manuscript", id: "s3", input: { title: "새 장의 첫 장면", kind: "장면", body: "아직 쓰지 않았다.", work_id: "등대지기의 딸", chapter: "3장 돌아온 불", status: "구상" } },
    { tool: "save_manuscript", id: "s4", input: { title: "없는 작품 장면", kind: "장면", body: "x", work_id: "없는작품" } },
    { tool: "save_manuscript", id: "s5", input: { title: "등대 일지 메모", kind: "메모", body: "나래가 쓴 메모. 서리의 동생." } },
    { tool: "get_manuscripts", id: "g1", input: { work_id: "등대지기의 딸" } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "작품을 만들었어요." } }], "tool_use"));
  await send("작품을 시작하자", 2);
  const r1 = requests.at(-2);
  const tn = r1.body.tools.map((t) => t.name);
  check("새 대화 도구 40개(v13: v12 37개 + 계획 3개)", tn.length === 40 && tn.includes("set_work") && tn.includes("set_scene_card") && tn.at(-1) === "respond" && r1.body.tools.find((t) => t.name === "save_manuscript").input_schema.properties.work_id && r1.body.tools.find((t) => t.name === "get_manuscripts").input_schema.properties.work_id, tn.length);
  check("v12 지침", r1.body.system[0].text.includes("## 작품과 원고"));
  const tr = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  const txt = (id) => JSON.stringify(res(id).content);
  check("거부: 제목 없는 새 작품", res("w2").is_error && txt("w2").includes("title"));
  check("거부: 없는 작품", res("s4").is_error && txt("s4").includes("없는작품"));
  check("나머지 성공", ["w1", "s1", "s2", "s3", "s5", "g1"].every((id) => !res(id).is_error), JSON.stringify(tr.filter((b) => b.is_error).map((b) => b.tool_use_id)));
  check("작품 개요: 장·장면·문체", txt("g1").includes("1장 꺼진 불") && txt("g1").includes("[초고] 등대의 밤") && txt("g1").includes("3장 돌아온 불") && txt("g1").includes("시점: 3인칭 제한"), txt("g1").slice(0, 400));
  let w = await world();
  const wk = w.works[0];
  check("작품 저장: 장 3개(없는 장은 새로)", w.works.length === 1 && wk.chapters.length === 3 && wk.chapters[2].title === "3장 돌아온 불" && wk.style.avoid === "갑자기");
  let night = await msBy("등대의 밤");
  const ship = await msBy("안개 속 배");
  check("장면: 작품·장·상태·순서", night.workId === wk.id && night.chapterId === wk.chapters[0].id && night.status === "초고" && ship.chapterId === wk.chapters[1].id && ship.status === "초고");
  check("관련 항목 자동(본문에서 찾음)", ["C-001", "P-001", "F-001"].every((id) => night.refs.includes(id)) && ship.refs.includes("C-011") && ship.refs.includes("C-013"), night.refs.join());
  check("작품 밖 원고", !(await msBy("등대 일지 메모")).workId);
  // 둘째 턴: 장 옮기기 + after_id + 원고 하나 읽기
  queue.push(() => msg("b1", [
    { tool: "save_manuscript", id: "m1", input: { id: ship.id, title: "안개 속 배", kind: "장면", body: ship.body, work_id: wk.id, chapter: wk.chapters[0].id, after_id: night.id } },
    { tool: "get_manuscripts", id: "m2", input: { id: night.id } },
  ], "tool_use"));
  queue.push(() => msg("b2", [{ tool: "respond", id: "rr2", input: { message: "옮겼어요." } }], "tool_use"));
  const nb = requests.length;
  await send("배 장면을 1장으로", nb + 2);
  const tr2 = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const m2 = JSON.stringify(tr2.find((b) => b.tool_use_id === "m2").content);
  check("원고 읽기: 작품 위치·뒤 장면·문체", m2.includes("작품: 「등대지기의 딸」") && m2.includes("1장 꺼진 불") && m2.includes("뒤 장면") && m2.includes("안개 속 배") && m2.includes("문체 가이드: 시점: 3인칭 제한"), m2.slice(0, 300));
  check("after_id로 같은 장 뒤에 놓음", (await msBy("안개 속 배")).chapterId === wk.chapters[0].id && (await msBy("안개 속 배")).order === 1 && (await msBy("등대의 밤")).order === 0);
  // 새 대화 첫 메시지
  await page.click("#newThreadBtn");
  const nc = requests.length;
  await send("이어서", nc + 1);
  const ctxText = requests[nc].body.messages[0].content.map((b) => b.text || "").join("");
  check("새 대화 현황: 작품·문체", ctxText.includes("작품:\n- 「등대지기의 딸」") && ctxText.includes("장 3 · 장면 3") && ctxText.includes("문체: 시점: 3인칭 제한"), ctxText.slice(ctxText.indexOf("작품:"), ctxText.indexOf("작품:") + 300));
  // v11 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 11;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b11 = requests.length;
  await send("하나 더", b11 + 1);
  check("v11 대화는 v11 지침·도구 그대로", requests[b11].body.system[0].text === V11.system && JSON.stringify(requests[b11].body.tools) === JSON.stringify(V11.tools));

  // ---- 2. 원고함 › 작품 보기 ----
  await openMs();
  check("작품이 있으면 작품 보기가 기본", (await page.getAttribute('#codex [data-msview="works"]', "aria-selected")) === "true");
  check("작품 보기: 장 3·장면 행", (await page.$$("#codex .ch-sec")).length === 3 && (await page.$$("#codex .sc-row")).length === 3);
  check("작품 머리: 통계·상태·문체", (await page.textContent("#codex .work-head")).includes("장면 3") && (await page.textContent("#codex .work-head")).includes("구상 1") && (await page.textContent("#codex .work-head")).includes("문체: 시점: 3인칭 제한"));
  await page.screenshot({ path: `${SHOTS}/150-works.png` });
  // 끌어서 순서 바꾸기: 1장의 '등대의 밤'을 '안개 속 배' 아래로
  const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; });
  const hNight = await box(`#codex .sc-row[data-sc="${night.id}"] .sc-handle`);
  const rShip = await box(`#codex .sc-row[data-sc="${ship.id}"]`);
  await page.mouse.move(hNight.x, hNight.y);
  await page.mouse.down();
  await page.mouse.move(hNight.x, hNight.y + 10, { steps: 3 });
  await page.mouse.move(rShip.x, rShip.y + rShip.h * 0.35, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("끌어서 순서 바꾸기", (await msBy("등대의 밤")).order === 1 && (await msBy("안개 속 배")).order === 0, JSON.stringify([(await msBy("등대의 밤")).order, (await msBy("안개 속 배")).order]));
  // 다른 장(빈 2장)으로 끌기
  const hShip = await box(`#codex .sc-row[data-sc="${ship.id}"] .sc-handle`);
  const ch2 = await box(`#codex .sc-list[data-ch="${wk.chapters[1].id}"]`);
  await page.mouse.move(hShip.x, hShip.y);
  await page.mouse.down();
  await page.mouse.move(hShip.x, hShip.y + 10, { steps: 3 });
  await page.mouse.move(ch2.x, ch2.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("다른 장으로 끌기", (await msBy("안개 속 배")).chapterId === wk.chapters[1].id);
  // 장면 메뉴
  await page.click(`#codex [data-sc-menu="${night.id}"]`);
  await page.click('#sheetBody input[name="sm-st"][value="퇴고"] + span');
  await page.waitForTimeout(250);
  check("장면 메뉴: 상태", (await msBy("등대의 밤")).status === "퇴고");
  await page.selectOption("#sm-ch", wk.chapters[1].id);
  await page.waitForTimeout(250);
  check("장면 메뉴: 장 옮기기(끝에)", (await msBy("등대의 밤")).chapterId === wk.chapters[1].id && (await msBy("등대의 밤")).order === 1);
  await page.click('#sheetBody [data-act="sm-up"]');
  await page.waitForTimeout(250);
  check("장면 메뉴: 위로", (await msBy("등대의 밤")).order === 0 && (await msBy("안개 속 배")).order === 1);
  await closeSheet();
  // 작품 설정
  await page.click('#codex [data-act="work-edit"]');
  await page.fill('#workForm [data-sk="tone"]', "담담하고 건조하게");
  await page.fill('#workForm [data-sk="sample"]', "불은 꺼지지 않았다. 다만 작아졌을 뿐이다.");
  await page.fill('#workForm [data-sk="avoid"]', "");
  await page.click('#workForm button[type="submit"]');
  await page.waitForTimeout(300);
  w = await world();
  check("작품 설정: 문체 저장·지운 칸", w.works[0].style.tone === "담담하고 건조하게" && w.works[0].style.sample && !w.works[0].style.avoid && w.works[0].style.pov === "3인칭 제한");
  // 장 추가 · 고치기 · 지우기
  await page.click('#codex [data-act="ch-add"]');
  await page.fill("#ch-title", "외전");
  await page.click('#chForm button[type="submit"]');
  await page.waitForTimeout(250);
  w = await world();
  const ext = w.works[0].chapters.find((c) => c.title === "외전");
  check("장 추가", w.works[0].chapters.length === 4 && ext);
  await page.click(`#codex [data-ch-edit="${ext.id}"]`);
  await page.fill("#ch-title", "외전: 노을");
  await page.click('#sheetBody [data-act="ch-up"]');
  await page.waitForTimeout(250);
  w = await world();
  check("장 앞으로", w.works[0].chapters[2].id === ext.id);
  const ch3 = w.works[0].chapters.find((c) => c.title === "3장 돌아온 불");
  await page.click(`#codex [data-ch-edit="${ch3.id}"]`);
  await page.click('#sheetBody [data-act="ch-del"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForTimeout(300);
  w = await world();
  check("장 지우기: 장면은 작품 밖으로", w.works[0].chapters.length === 3 && !(await msBy("새 장의 첫 장면")).workId);
  // 장면 추가 → 집필 화면
  await page.click(`#codex [data-sc-add="${ext.id}"]`);
  await page.waitForSelector("#writer:not([hidden]) #w-body");
  check("장면 추가 → 집필 화면", (await page.inputValue("#w-title")) === "새 장면" && (await page.inputValue("#w-status")) === "구상");

  // ---- 3. 집필 화면 ----
  await page.fill("#w-title", "노을의 마지막 불");
  await page.fill("#w-body", "가나다 라마");
  check("글자 수·원고지", (await page.textContent("#w-count")).startsWith("6자 · 공백 제외 5 · 원고지 약 0매"), await page.textContent("#w-count"));
  await page.waitForTimeout(1400);
  let sc = await msBy("노을의 마지막 불");
  check("자동 저장(제목·본문)", sc && sc.body === "가나다 라마" && (await page.textContent("#w-saved")) === "저장됨");
  const longText = "노을은 잿빛 첨탑 등대의 꼭대기에서 마지막 기억을 꺼냈다. 서리는 아직 어렸다.\n\n" + "바람이 불었다. ".repeat(40);
  await page.fill("#w-body", longText);
  await page.waitForTimeout(900);
  const ents = await page.$$eval("#w-ents .ent-chip", (els) => els.map((x) => x.dataset.went));
  check("등장 칩", ents.includes("C-013") && ents.includes("P-001") && ents.includes("C-001"), ents.join());
  check("작품 누계", (await page.textContent("#w-totals")).includes("작품"));
  await page.screenshot({ path: `${SHOTS}/151-writer.png` });
  await page.click('#w-ents [data-went="C-001"]');
  check("칩 → 요약 카드", (await page.textContent("#w-peek")).includes("서리") && (await page.textContent("#w-peek")).includes("견습 등대지기"));
  await page.click('#w-peek [data-act="ent-ignore"]');
  await page.waitForTimeout(250);
  check("이 원고에서 무시", !(await page.$('#w-ents [data-went="C-001"]')) && (await msBy("노을의 마지막 불")).ignore.includes("C-001"));
  await page.click('#w-ents [data-went="P-001"]');
  await page.click('#w-peek [data-ref="P-001"]');
  await page.waitForSelector("#sheetBody .entry-name");
  check("자세히 → 항목 시트가 집필 화면 위에", (await page.textContent("#sheetBody .entry-name")) === "잿빛 첨탑 등대" && await page.isVisible("#writer"));
  await closeSheet();
  // 부분 다듬기
  check("다듬기: 고르기 전엔 꺼짐", await page.isDisabled("#w-polish"));
  await page.evaluate(() => { const ta = document.querySelector("#w-body"); ta.focus(); ta.setSelectionRange(0, 30); document.dispatchEvent(new Event("selectionchange")); });
  await page.waitForTimeout(150);
  check("다듬기: 고르면 켜짐", !(await page.isDisabled("#w-polish")));
  await page.click("#w-polish");
  check("다듬기 모드: 문체 포함", (await page.$$("#w-peek [data-pm]")).length === 6);
  await page.click('#w-peek [data-pm="short"]');
  await page.fill("#pm-free", "더 쓸쓸하게");
  quick.push(JSON.stringify({ text: "노을은 등대 꼭대기에서 마지막 기억을 꺼냈다.", note: "수식어를 줄였습니다" }));
  await page.click('#w-peek [data-w="polish-run"]');
  await page.waitForSelector("#pm-out .pm-after");
  const pq = quickReqs.at(-1).body;
  const pqText = JSON.stringify(pq.messages);
  check("다듬기 요청: 대화 모델·문체·고칠 부분·지시", pq.model === "claude-opus-5-5" && pqText.includes("문체 가이드") && pqText.includes("담담하고 건조하게") && pqText.includes("[고칠 부분]") && pqText.includes("더 쓸쓸하게") && pqText.includes("짧고 간결하게"), pq.model);
  check("전·후 비교", (await page.textContent("#pm-out .pm-before")) === longText.slice(0, 30) && (await page.textContent("#pm-out .pm-after")).includes("마지막 기억"));
  await page.screenshot({ path: `${SHOTS}/152-polish.png` });
  quick.push(JSON.stringify({ text: "노을은 마지막 기억을 꺼냈다.", note: "더 짧게" }));
  await page.click('#w-peek [data-w="polish-again"]');
  await page.waitForFunction(() => document.querySelector("#pm-out .pm-after")?.textContent === "노을은 마지막 기억을 꺼냈다.");
  check("다른 안: 앞의 안을 알려 줌", JSON.stringify(quickReqs.at(-1).body.messages).includes("앞서 낸 안"));
  await page.click('#w-peek [data-w="polish-apply"]');
  await page.waitForTimeout(1300);
  check("바꾸기 → 본문·저장", (await page.inputValue("#w-body")).startsWith("노을은 마지막 기억을 꺼냈다.") && (await msBy("노을의 마지막 불")).body.startsWith("노을은 마지막 기억을 꺼냈다."));
  // 미리보기
  await page.click('[data-w="preview"]');
  check("미리보기", await page.isVisible("#w-preview") && !(await page.isVisible("#w-body")) && (await page.textContent("#w-preview")).includes("바람이 불었다"));
  await page.click('[data-w="preview"]');
  // 상태 바꾸기
  await page.selectOption("#w-status", "초고");
  await page.waitForTimeout(200);
  check("집필 화면: 상태", (await msBy("노을의 마지막 불")).status === "초고");
  // 앞 장면으로
  await page.click('[data-w="prev"]');
  await page.waitForTimeout(300);
  check("앞 장면으로 이동", (await page.inputValue("#w-title")) === "안개 속 배");
  await page.click('[data-w="close"]');
  await page.waitForTimeout(300);
  check("닫으면 작품 보기로", !(await page.isVisible("#writer")) && (await page.$$("#codex .sc-row")).length >= 3);

  // ---- 4. 원고 보기: 설정 인식 · 이어 쓰기 ----
  await page.click(`#codex .sc-main[data-ms="${night.id}"]`);
  await page.waitForSelector("#sheetBody .ms-body");
  const marks = await page.$$eval("#sheetBody .ent-mark", (els) => els.map((x) => x.dataset.ent + ":" + x.textContent));
  check("원고 보기: 설정 밑줄", marks.includes("C-001:서리") && marks.includes("P-001:잿빛 첨탑 등대") && marks.includes("F-001:무등회"), marks.join());
  check("원고 보기: 작품 위치·글자 수", (await sheetText()).includes("「등대지기의 딸」") && (await sheetText()).includes("원고지 약"));
  await page.click('#sheetBody .ent-mark[data-ent="C-001"]');
  check("밑줄 → 요약 카드", (await page.textContent("#entPeek")).includes("열일곱 살 견습 등대지기"));
  await page.click('#entPeek [data-act="ent-ignore"]');
  await page.waitForTimeout(300);
  check("무시 → 밑줄 사라짐·되돌리기 표시", !(await page.$('#sheetBody .ent-mark[data-ent="C-001"]')) && (await sheetText()).includes("이 원고에서 무시하는 이름: 서리") && !(await msBy("등대의 밤")).refs.includes("C-001"));
  await page.click('#sheetBody [data-act="ent-unignore"]');
  await page.waitForTimeout(300);
  check("되돌리기", !!(await page.$('#sheetBody .ent-mark[data-ent="C-001"]')) && (await msBy("등대의 밤")).refs.includes("C-001"));
  await page.screenshot({ path: `${SHOTS}/153-ms-view.png` });
  await page.click('#sheetBody [data-act="ms-continue"]');
  check("이어 쓰기: 작품과 문체 가이드 언급", (await page.inputValue("#input")).includes("작품 「등대지기의 딸」") && (await page.inputValue("#input")).includes("문체 가이드"));
  await page.fill("#input", "");

  // ---- 5. 설정 뽑기 ----
  await openMs();
  await page.click(`#codex .sc-main[data-ms="${night.id}"]`);
  await page.waitForSelector("#sheetBody .ms-body");
  await page.click('#sheetBody [data-act="ms-extract"]');
  quick.push(JSON.stringify({
    entries: [{ type: "인물", name: "검은 선장", summary: "무등회 배의 선장", quote: "멀리 무등회의 배가 보였다." }, { type: "인물", name: "서리", summary: "이미 있음", quote: "x" }],
    facts: [{ id: "C-001", fact: "서리는 등명부를 직접 펼친다", quote: "서리는 등명부를 펼쳤다." }, { id: "X-999", fact: "없는 항목", quote: "y" }],
    foreshadows: [{ text: "멀리 보인 무등회의 배", quote: "멀리 무등회의 배가 보였다." }],
  }));
  await page.click('#sheetBody [data-act="ex-run"]');
  await page.waitForSelector("#sheetBody .ex-pick");
  const eq = quickReqs.at(-1).body;
  check("설정 뽑기 요청: Haiku·스키마·원고", eq.model === "claude-haiku-5-5" && eq.output_config.format.schema.properties.foreshadows && JSON.stringify(eq.messages).includes("# 원고: 등대의 밤"));
  check("이미 있는 이름·없는 id는 뺌", (await page.$$("#sheetBody .ex-pick")).length === 3);
  await page.screenshot({ path: `${SHOTS}/154-extract.png` });
  await page.click('#sheetBody [data-act="ex-save"]');
  await page.waitForSelector("#sheetBody .ms-body");
  const capt = (await idbGet("entries:" + wid0)).find((x) => x.name === "검은 선장");
  check("새 항목: 초안·인용", capt && capt.status === "draft" && capt.type === "character" && capt.body.includes("멀리 무등회의 배가 보였다.") && capt.body.includes("원고 '등대의 밤'에서"));
  check("새 사실: 본문 끝에 출처와 함께", (await entry("C-001")).body.includes("### 원고 '등대의 밤'에서\n- 서리는 등명부를 직접 펼친다"));
  w = await world();
  check("복선: 깔린 곳 = 이 원고", w.foreshadows?.some((f) => f.text === "멀리 보인 무등회의 배" && f.plant === night.id && f.status === "깔림"));
  check("원고 관련 항목에 새 항목", (await msBy("등대의 밤")).refs.includes(capt.id));

  // ---- 6. 작품에 넣기 · 모든 원고 ----
  await closeSheet();
  await page.waitForTimeout(1500);
  await page.click('#codex [data-msview="all"]');
  await page.waitForTimeout(150);
  check("모든 원고 보기", (await page.$$("#codex .ms-card")).length === 5);
  await page.click(`#codex .ms-card:has-text("등대 일지 메모")`);
  await page.click('#sheetBody [data-act="ms-place"]');
  await page.selectOption("#pl-ch", "__new");
  await page.fill("#pl-chnew", "부록");
  await page.selectOption("#pl-st", "완료");
  await page.click('#placeForm button[type="submit"]');
  await page.waitForTimeout(300);
  const memo = await msBy("등대 일지 메모");
  w = await world();
  check("작품에 넣기(새 장)", memo.workId === wk.id && w.works[0].chapters.at(-1).title === "부록" && memo.chapterId === w.works[0].chapters.at(-1).id && memo.status === "완료");
  // 새 작품으로 넣기
  await closeSheet();
  await page.click(`#codex .ms-card:has-text("새 장의 첫 장면")`);
  await page.click('#sheetBody [data-act="ms-place"]');
  await page.selectOption("#pl-work", "__new");
  await page.fill("#pl-new", "외전집");
  await page.click('#placeForm button[type="submit"]');
  await page.waitForTimeout(300);
  w = await world();
  check("새 작품 만들며 넣기", w.works.length === 2 && w.works[1].title === "외전집" && (await msBy("새 장의 첫 장면")).workId === w.works[1].id);
  await closeSheet();
  await page.click('#codex [data-msview="works"]');
  await page.waitForTimeout(150);
  check("작품 칩 2개", (await page.$$("#codex .work-chips [data-work]")).length === 2);

  // ---- 7. 좁은 화면 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await openMs();
  check("360px: 작품 보기 넘침 없음", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await page.screenshot({ path: `${SHOTS}/155-works-360.png` });
  await page.click(`#codex [data-work="${wk.id}"]`);
  await page.click(`#codex .sc-main[data-ms="${night.id}"]`);
  await page.click('#sheetBody [data-act="ms-write"]');
  await page.waitForSelector("#writer:not([hidden])");
  check("360px: 집필 화면 넘침 없음", (await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector("#writer").scrollWidth])).every((v) => v <= 360));
  await page.screenshot({ path: `${SHOTS}/156-writer-360.png` });
  await page.click('[data-w="close"]');
  await page.waitForTimeout(200);
  check("원고 보기에서 연 집필 화면은 원고 보기로 돌아옴", (await page.textContent("#sheetBody .entry-name")) === "등대의 밤");
  await closeSheet();

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
