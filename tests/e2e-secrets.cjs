// 비밀과 앎(v14): set_secret·learns 도구와 지침, get_plan의 '비밀과 앎', 첫 메시지, 항목의 비밀(속성에서 옮기기),
// 비밀과 앎 모아 보기·새어 나감, 작품 '앎' 탭, 현황판, 카드의 '알게 되는 것', 구조 점검에 비밀 포함, 문서 내보내기
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const L = require("./lib.cjs");
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V13 = L.PROMPT_SET(13);
const seed = require(path.join(L.TESTS, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8794);

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
  const msBy = async (title) => ((await idbGet("ms:" + wid0)) || []).find((m) => m.title === title);
  const trOf = (i) => requests[i].body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const openE = async (id) => { await tab("codex"); if (await page.$('#codex [data-ctab="entries"][aria-selected="false"]')) await page.click('#codex [data-ctab="entries"]'); await page.click(`.entry-card[data-ref="${id}"]`); await page.waitForSelector("#sheetBody .entry-name"); };
  const openWork = async (t) => { await tab("codex"); await page.click('#codex [data-ctab="ms"]'); await page.waitForTimeout(120); if (await page.$('#codex [data-msview="works"]')) await page.click('#codex [data-msview="works"]'); await page.waitForTimeout(100); await page.click(`#codex [data-wtab="${t}"]`); await page.waitForTimeout(150); };

  await page.goto("http://localhost:8794/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  const wid0 = await wid();
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 도구: 작품·장면·비밀 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [
    { tool: "set_work", id: "w1", input: { title: "등대지기의 딸", chapters: [{ title: "1장" }, { title: "2장" }] } },
    { tool: "set_scene_card", id: "c1", input: { work_id: "등대지기의 딸", chapter: "1장", title: "꺼진 불", summary: "불이 꺼진다", pov: "C-001", cast: ["C-012"], goal: "불을 켠다", conflict: "등명부가 찢김", outcome: "켜지 못함" } },
    { tool: "set_scene_card", id: "c2", input: { work_id: "등대지기의 딸", chapter: "1장", title: "아버지의 침묵", summary: "도윤이 말을 아낀다", pov: "C-001", cast: ["C-011"], goal: "이유를 묻는다", conflict: "도윤이 피한다", outcome: "도윤이 등명부를 숨긴다" } },
    { tool: "set_scene_card", id: "c3", input: { work_id: "등대지기의 딸", chapter: "2장", title: "드러난 대가", summary: "서리가 진실을 안다", pov: "C-001", cast: ["C-011"], goal: "진실을 안다", conflict: "도윤이 막는다", outcome: "서리가 대가를 안다" } },
    { tool: "set_secret", id: "s1", input: { entry_id: "K-001", text: "등명 계약은 기억이 아니라 수명을 태운다", knowers: ["C-011"], reveal_at: "2장", keys: ["수명"] } },
    { tool: "set_secret", id: "s2", input: { entry_id: "K-001", text: "x", level: "모두" } },
    { tool: "set_secret", id: "s3", input: { entry_id: "K-001", text: "y", knowers: ["C-999"] } },
    { tool: "set_secret", id: "s4", input: { entry_id: "K-001", text: "z", reveal_at: "없는장" } },
  ], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "rr", input: { message: "정리했어요." } }], "tool_use"));
  await send("비밀을 정리하자", 2);
  const r1 = requests[0];
  const tn = r1.body.tools.map((t) => t.name);
  check("v14 지침: 비밀과 앎", r1.body.system[0].text.includes("## 비밀과 앎") && r1.body.system[0].text.includes("암시까지만") && r1.body.system[0].text.includes("## 이야기 계획"));
  check("v14 도구 41개: set_secret·learns", tn.length === 41 && tn.includes("set_secret") && tn.at(-1) === "respond" && !!r1.body.tools.find((t) => t.name === "set_scene_card").input_schema.properties.learns);
  const tr = trOf(1);
  const res = (id) => tr.find((b) => b.tool_use_id === id);
  check("거부: 없는 범위·인물·드러낼 곳", res("s2").is_error && JSON.stringify(res("s2").content).includes("level") && res("s3").is_error && JSON.stringify(res("s3").content).includes("C-999") && res("s4").is_error && JSON.stringify(res("s4").content).includes("없는장"));
  let k1 = await entry("K-001");
  check("비밀 저장: 범위는 '일부 인물'(아는 이가 있으니), 드러낼 곳=2장, 낱말", k1.secrets?.length === 1 && k1.secrets[0].level === "일부 인물" && k1.secrets[0].knowers.join() === "C-011" && k1.secrets[0].reveal.kind === "ch" && k1.secrets[0].keys.join() === "수명");
  const sid = k1.secrets[0].id;
  const scA = await msBy("꺼진 불");
  const scB = await msBy("아버지의 침묵");
  const scC = await msBy("드러난 대가");
  // 둘째 턴: learns, 장면 본문(새어 나감), get_plan
  queue.push(() => msg("b1", [
    { tool: "set_scene_card", id: "l1", input: { id: scC.id, learns: [{ who: "C-001", secret_id: sid }, { who: "C-012", what: "언니가 무언가 숨긴다" }] } },
    { tool: "set_scene_card", id: "l2", input: { id: scB.id, learns: [{ who: "C-001", secret_id: "sc-없음" }] } },
    { tool: "save_manuscript", id: "sv", input: { id: scA.id, title: "꺼진 불", kind: "장면", body: "서리는 불이 수명을 먹는다는 소문을 떠올렸다.", work_id: "등대지기의 딸" } },
    { tool: "get_plan", id: "g1", input: { scene_id: scA.id } },
    { tool: "get_plan", id: "g2", input: { scene_id: scC.id } },
  ], "tool_use"));
  queue.push(() => msg("b2", [{ tool: "respond", id: "rr2", input: { message: "됐어요." } }], "tool_use"));
  const nb = requests.length;
  await send("앎을 기록해", nb + 2);
  const tr2 = trOf(nb + 1);
  const r2 = (id) => tr2.find((b) => b.tool_use_id === id);
  check("거부: 없는 비밀 id", r2("l2").is_error && JSON.stringify(r2("l2").content).includes("sc-없음"));
  const cC = (await msBy("드러난 대가")).card;
  check("learns 저장: 비밀이면 내용 자동", cC.learns.length === 2 && cC.learns[0].secret === sid && cC.learns[0].what.includes("수명을 태운다"));
  const g1 = JSON.stringify(r2("g1").content);
  const g2 = JSON.stringify(r2("g2").content);
  check("get_plan(앞 장면): 드러내지 말 비밀·시점 인물이 모름", g1.includes("아직 독자에게 드러낼 때가 아닌 비밀") && g1.includes("수명을 태운다") && g1.includes("서리이(가) 아직 모르는 비밀"), g1.slice(0, 600));
  check("get_plan(드러낼 장면): 드러낼 비밀·알게 되는 것", g2.includes("이 장면에서 독자에게 드러낼 비밀") && g2.includes("이 장면에서 알게 되는 것") && g2.includes("알게 됨: 서리"), g2.slice(0, 600));
  // 새 대화 첫 메시지
  await page.click("#newThreadBtn");
  const nc = requests.length;
  await send("이어서", nc + 1);
  const ctxText = requests[nc].body.messages[0].content.map((b) => b.text || "").join("");
  check("첫 메시지: 비밀 목록", ctxText.includes("비밀 1개") && ctxText.includes("수명을 태운다") && ctxText.includes("드러낼 곳"));
  // v13 대화는 그대로
  const tid = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.thread")));
  const threads = await idbGet("threads:" + wid0);
  threads.find((t) => t.id === tid).promptVersion = 13;
  await idbSet("threads:" + wid0, threads);
  await page.reload(); await page.waitForSelector("#app");
  await tab("chat");
  const b13 = requests.length;
  await send("하나 더", b13 + 1);
  check("v13 대화는 v13 지침·도구 그대로", requests[b13].body.system[0].text === V13.system && JSON.stringify(requests[b13].body.tools) === JSON.stringify(V13.tools));

  // ---- 2. 항목의 비밀 ----
  await openE("K-001");
  let t = await sheetText();
  check("항목 화면: 비밀·범위·아는 이·드러낼 곳", t.includes("수명을 태운다") && t.includes("일부 인물만 앎") && t.includes("도윤") && t.includes("2장"));
  await page.click('#sheetBody [data-sec^="edit|"]');
  await page.waitForSelector("#secretForm");
  await page.selectOption("#sc-reveal", `ms:${scC.id}`);
  await page.click('#secretForm [type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  k1 = await entry("K-001");
  check("비밀 고치기: 드러낼 곳=장면, 이력", k1.secrets[0].reveal.kind === "ms" && k1.secrets[0].reveal.id === scC.id && k1.history.at(-1).reason.includes("비밀"));
  await openE("C-001");
  const fieldBtn = await page.$('#sheetBody [data-sec^="field|"]');
  check("속성 '비밀'을 비밀로 옮기는 단추", !!fieldBtn);
  if (fieldBtn) {
    await fieldBtn.click();
    await page.waitForSelector("#secretForm");
    check("속성 내용이 채워짐", (await page.inputValue("#sc-text")).length > 3);
    await page.click('#secretForm [type="submit"]');
    await page.waitForSelector("#sheetBody .entry-name");
    check("작가만 앎으로 저장", (await entry("C-001")).secrets?.[0]?.level === "작가만" && !(await page.$('#sheetBody [data-sec^="field|"]')));
  }
  await closeSheet();

  // ---- 3. 모아 보기·새어 나감 ----
  await tab("codex");
  await page.click('#codex [data-ctab="entries"]');
  await page.click('#codex [data-act="secrets"]');
  await page.waitForSelector("#sheetBody .check-group");
  t = await sheetText();
  check("비밀과 앎: 정해진·안 정한 비밀", t.includes("드러낼 곳이 정해진 비밀 1") && t.includes("드러낼 곳을 정하지 않은 비밀 1"));
  check("새어 나감: 앞 장면에 '수명'", t.includes("새어 나갔을 수 있는 곳") && t.includes("꺼진 불") && t.includes("'수명'"));
  await page.screenshot({ path: path.join(SHOTS, "200-secrets.png") });
  await closeSheet();

  // ---- 4. 앎 탭 ----
  await openWork("know");
  t = await page.textContent("#codex .know");
  check("앎 탭: 인물×장 표", (await page.$$("#codex .know-table tr")).length >= 3 && t.includes("서리") && t.includes("도윤") && t.includes("1장") && t.includes("2장"));
  check("처음부터 아는 이(도윤)와 알게 되는 것(서리·나래)", t.includes("언니가 무언가") && t.includes("수명을 태운다"));
  check("비밀의 흐름: 도윤은 처음부터, 독자는 나중", t.includes("도윤은(는) 처음부터 알고") && t.includes("드러난 대가"));
  check("앎 탭에도 새어 나감 표시", t.includes("새어 나갔을 수 있는 곳"));
  await page.screenshot({ path: path.join(SHOTS, "201-know.png"), fullPage: true });

  // ---- 5. 현황판·카드 편집 ----
  await page.click('#codex [data-wtab="board"]');
  await page.waitForTimeout(150);
  await page.click(`#codex [data-card-status="${scB.id}"]`);
  await page.waitForTimeout(200);
  t = await sheetText();
  check("현황판: 비밀과 앎(드러내지 않을 비밀·도윤은 앎)", t.includes("비밀과 앎") && t.includes("아직 드러내지 않을 비밀") && t.includes("등장인물은 알고 독자는 모르는 것"));
  await closeSheet();
  await page.click(`#codex [data-card-open="${scB.id}"]`);
  await page.waitForSelector("#cardForm");
  await page.click('[data-act="cd-learn-add"]');
  await page.selectOption("#cd-learns .learn-row:last-child .lw", "C-001");
  await page.fill("#cd-learns .learn-row:last-child .lt", "아버지가 등명부를 숨긴다");
  await page.click('#cardForm [data-ok="0"]');
  await page.waitForTimeout(200);
  check("카드 편집: 알게 되는 것 저장", (await msBy("아버지의 침묵")).card.learns?.[0]?.what === "아버지가 등명부를 숨긴다");
  await page.click(`#codex [data-card-open="${scB.id}"]`);
  await page.waitForSelector("#cardForm");
  check("다시 열면 줄이 보임", (await page.$$("#cd-learns .learn-row")).length === 1);
  await page.click("#cd-learns [data-del-learn]");
  await page.click('#cardForm [data-ok="0"]');
  await page.waitForTimeout(200);
  check("줄 지우면 learns 빠짐", !(await msBy("아버지의 침묵")).card.learns);
  await page.click(`#codex [data-card-open="${scC.id}"]`);
  await page.waitForSelector("#cardForm");
  check("드러낼 장면의 카드에 안내", (await sheetText()).includes("이 장면에서 독자에게 드러낼 비밀"));
  await closeSheet();

  // ---- 6. 구조 점검에 비밀 ----
  await page.click('#codex [data-wtab="plan"]');
  await page.waitForTimeout(150);
  quick.push(JSON.stringify({ summary: "비밀이 먼저 샙니다.", issues: [{ ref: scA.id, kind: "비밀 새어 나감", severity: "높음", problem: "수명이 1장에 나온다", suggestion: "암시로 바꾼다" }] }));
  await page.click('#codex [data-plan="check"]');
  await page.waitForSelector(".check-issue");
  const cq = quickReqs.at(-1).body;
  check("구조 점검: 비밀과 앎을 보냄·새 종류", cq.messages[0].content.includes("비밀과 앎:") && cq.messages[0].content.includes("장면에서 알게 되는 것") && cq.output_config.format.schema.properties.issues.items.properties.kind.enum.includes("비밀 새어 나감"));
  t = await sheetText();
  check("점검 결과: 앱이 찾은 새어 나감", t.includes("드러낼 곳") && t.includes("'수명'"));
  await closeSheet();

  // ---- 7. 문서 내보내기 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-md"]')]);
  const md = fs.readFileSync(await dl.path(), "utf8");
  check("문서 내보내기: 비밀", md.includes("## 비밀") && md.includes("수명을 태운다") && md.includes("일부 인물만 앎"));

  // ---- 8. 화면 폭 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await openWork("know");
  check("360px: 앎 탭(표는 안에서 밀림)", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await openE("K-001");
  check("360px: 항목 비밀 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1);

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
