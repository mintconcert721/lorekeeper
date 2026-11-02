// 공통 작성 규칙: 템플릿에서 공통 줄 찾기, 가져오기 정리, 자동 참조 규칙, Claude에게 전달(get_template·첫 메시지)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
// 사용자 템플릿은 개인 자료라 저장소에 넣지 않는다(tests/private/templates-user에 두면 이 테스트가 돈다)
const TU = path.join(L.TESTS, "private", "templates-user");
if (!fs.existsSync(TU)) { console.log("SKIP: tests/private/templates-user 없음"); process.exit(0); }
const FILES = fs.readdirSync(TU).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(TU, f));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8787);

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
const requests = [];

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
    requests.push({ body });
    const make = queue.shift() || (() => msg("x", [{ tool: "respond", id: "rsx", input: { message: "네." } }], "tool_use"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const send = async (text, n) => { await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle(); await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(250); };
  const closeSheet = async () => { if (await page.isVisible("#sheet")) { await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); } };
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await closeSheet(); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const world = async () => (await idbGet("worlds"))[0];
  const typeBy = async (label) => (await world()).types.find((t) => t.label === label);
  const openTypes = async () => { await tab("codex"); await page.click('#codex [data-act="types"]'); await page.waitForSelector("#sheetBody .common-rules"); };
  const importFiles = async (files) => {
    const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click('#sheetBody [data-ts="import"]')]);
    await fc.setFiles(files);
    await page.waitForSelector("#sheetBody #importTplForm");
  };
  const toastText = async () => { await page.waitForTimeout(150); return page.evaluate(() => document.querySelector("#toast")?.textContent || ""); };
  const L1 = "확정되지 않은 설정은 임의로 단정하지 말고 미정이라고 표기하세요.";
  const L3 = "인물 이름, 날짜, 능력의 조건, 인과관계 등은 기존 세계관 문서와 모순되지 않도록 유지하세요.";

  await page.goto("http://localhost:8787/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 처음: 공통 규칙 칸과 자동 참조 규칙 ----
  await openTypes();
  check("공통 규칙 칸·자동 참조 규칙", (await page.inputValue("#cr-text")) === "" && (await page.textContent("#sheetBody .ref-rule")).includes("인물 C, 장소 P, 세력 F, 종족 S, 사건 E, 사물 I, 개념 K, 기타 X"));
  // ---- 2. 정리 없이 장소·세력만 가져온 뒤 '공통 줄 찾기' ----
  await importFiles([FILES.find((f) => f.includes("place_P")), FILES.find((f) => f.includes("faction_F"))]);
  const clean0 = await page.$$eval("#sheetBody .imp-clean .pick", (els) => els.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  check("가져오기: 공통 줄 정리 후보(반복 2줄 + 참조 줄)", clean0.length === 3 && clean0.some((x) => x.includes(L1) && x.includes("파일 2개")) && clean0.some((x) => x.includes("참조 안내 줄") && x.includes("파일 2개")), clean0.join(" / "));
  for (const b of await page.$$("#sheetBody .imp-clean input")) await b.uncheck();
  await page.click('#importTplForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .common-rules");
  check("정리 안 하면 템플릿 그대로", (await typeBy("장소")).template.includes(L1) && (await typeBy("장소")).template.includes("인물 C, 장소 P") && !(await world()).commonRules);
  await page.click('#sheetBody [data-ts="cr-find"]');
  await page.waitForSelector("#crFind .cr-find");
  const found = await page.$$eval("#crFind .crf-line", (els) => els.length);
  check("공통 줄 찾기: 반복 2줄", found === 2 && (await page.textContent("#crFind")).includes("템플릿 2개") && (await page.textContent("#crFind")).includes("참조 안내 줄(템플릿 2개)"));
  await page.click('#crFind [data-ts="cr-move"]');
  await page.waitForSelector("#sheetBody .common-rules");
  let w = await world();
  check("공통 규칙으로 옮기고 템플릿에서 뺌", w.commonRules.split("\n").length === 2 && w.commonRules.includes(L1) && !(await typeBy("장소")).template.includes(L1) && !(await typeBy("세력")).template.includes("인물 C, 장소 P") && (await typeBy("장소")).template.startsWith("## 01.") && (await typeBy("장소")).template.includes("- 장소 이름과 별칭:"));
  check("편집 칸에 옮긴 줄", (await page.inputValue("#cr-text")).split("\n").length === 2);
  await page.screenshot({ path: `${SHOTS}/160-common-rules.png` });

  // ---- 3. 10개 한꺼번에 가져오기: 이미 있는 규칙 + 참조 줄 정리 ----
  await importFiles(FILES);
  const clean1 = await page.$$eval("#sheetBody .imp-clean .pick", (els) => els.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  check("가져오기 정리: 이미 있는 규칙 표시·참조 줄 10개", clean1.some((x) => x.includes(L1) && x.includes("이미 공통 규칙에 있음") && x.includes("파일 9개")) && clean1.some((x) => x.includes(L3) && x.includes("이미 공통 규칙에 있음")) && clean1.some((x) => x.includes("참조 안내 줄") && x.includes("파일 10개")), clean1.join(" / "));
  await page.screenshot({ path: `${SHOTS}/161-import-clean.png` });
  await page.click('#importTplForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .common-rules");
  w = await world();
  const ch = await typeBy("인물");
  const dt = await typeBy("신·신격");
  const bt = await typeBy("마수 도감");
  check("새 분류 D·B", dt?.code === "D" && bt?.code === "B");
  check("공통 규칙은 중복 없이 2줄", w.commonRules.split("\n").length === 2);
  check("인물 템플릿: 참조 줄만 빠지고 고유 안내는 남음", !ch.template.includes("다른 분류 참조 시") && ch.template.includes("신체 치수는 캐릭터 설정상 필요한 경우에만") && ch.template.includes("기존에 확정된 정보를 우선하며"));
  check("신·신격 템플릿: 공통 줄 빠지고 고유 안내 남음", !dt.template.includes(L1) && !dt.template.includes("마수 B의 식별자") && dt.template.includes("작가만 아는 진실인지를 항상 구분"));
  check("사건 템플릿 섹션 안의 작성 안내는 그대로", (await typeBy("사건")).template.includes("진행 단계를 시간 순서대로"));
  check("속성 칸 수는 그대로", (await page.textContent("#sheetBody")).includes("칸 36") && (await page.textContent("#sheetBody")).includes("칸 34"));
  check("자동 참조 규칙에 새 코드", (await page.textContent("#sheetBody .ref-rule")).includes("신·신격 D, 마수 도감 B"));

  // ---- 4. Claude에게 전달 ----
  await tab("chat");
  await page.click("#newThreadBtn");
  queue.push(() => msg("a1", [{ tool: "get_template", id: "t1", input: { type: "마수 도감" } }, { tool: "get_template", id: "t2", input: { type: "기타" } }], "tool_use"));
  queue.push(() => msg("a2", [{ tool: "respond", id: "r1", input: { message: "확인했어요." } }], "tool_use"));
  await send("마수 템플릿 보여 줘", 2);
  const first = requests.at(-2).body.messages[0].content.map((b) => b.text || "").join("");
  check("첫 메시지: 공통 작성 규칙과 참조 규칙", first.includes("공통 작성 규칙(모든 분류에 적용):") && first.includes(`- ${L1}`) && first.includes("신·신격 D, 마수 도감 B의 식별자") && first.includes("이 목록이 템플릿 안의 참조 안내보다 우선한다"));
  const tr = requests.at(-1).body.messages.at(-1).content.filter((b) => b.type === "tool_result");
  const t1 = JSON.stringify(tr.find((b) => b.tool_use_id === "t1").content);
  check("get_template: 공통 규칙 + 템플릿 원문(공통 줄 없음)", t1.includes("공통 작성 규칙(모든 분류에 적용)") && t1.includes(L3) && t1.includes("마수 도감 B") && t1.includes("--- 템플릿 원문 ---") && t1.split(L1).length === 2, t1.slice(0, 300));

  // ---- 5. 규칙 고치기 · 분류 이름 바꾸기 ----
  await openTypes();
  await page.fill("#cr-text", `${L1}\n${L3}\n> Claude 작성 지침: 고유명사는 처음 나올 때 한 번만 풀어 쓰세요.\n${L1}`);
  await page.click('#sheetBody [data-ts="cr-save"]');
  await page.waitForTimeout(300);
  w = await world();
  check("규칙 저장: 머리말 정리·중복 제거", w.commonRules.split("\n").length === 3 && w.commonRules.includes("고유명사는 처음 나올 때") && !w.commonRules.includes("Claude 작성 지침") && !w.commonRules.includes(">"));
  await page.click(`#sheetBody [data-type-edit="${bt.key}"]`);
  await page.fill("#t-label", "마수·괴물 도감");
  await page.click('#sheetBody button[type="submit"]');
  await page.waitForSelector("#sheetBody .common-rules");
  check("분류 이름을 바꾸면 참조 규칙도 바뀜", (await page.textContent("#sheetBody .ref-rule")).includes("마수·괴물 도감 B"));
  await page.click('#sheetBody [data-ts="cr-find"]');
  check("다시 찾으면 정리할 줄 없음", (await page.textContent("#crFind")).includes("반복된 작성 안내가 없습니다"));

  // ---- 6. 좁은 화면 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(150);
  check("360px: 넘침 없음", (await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth])).every((v, i) => (i ? v <= 1 : v <= 360)));

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 400));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
