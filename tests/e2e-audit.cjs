// 점검 센터: 카테고리 전수점검(묶음·항목별 판정·빠진 판정 다시 보내기·종합·캐시·바뀐 것만·멈춤과 이어서 하기),
// 스토리 전체 점검(원고 전문 / 장면 기록 → 전체, 기록 재사용, 본문으로 다시 확인), 보고서(거르기·해결·무시·Claude와 고치기)
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const L = require("./lib.cjs");
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const seed = require(path.join(L.TESTS, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8792);

const quickReqs = [];
const mock = { omitOnce: "F-001", failAt: -1, tokens: 1000, entryReqs: 0 };
function answer(body) {
  const sys = body.system.map((b) => b.text).join("\n");
  const user = body.messages[0].content;
  if (sys.includes("교정 편집자다. 주어진 항목을")) {
    mock.entryReqs++;
    const ids = (user.match(/점검할 항목 id: ([^\n]+)/) || [])[1].split(", ");
    const verdicts = ids.filter((id) => { if (id === mock.omitOnce) { mock.omitOnce = null; return false; } return true; }).map((id) => id === "C-001"
      ? { id, ok: false, issues: [{ field: "나이", kind: "다른 항목과 모순", severity: "높음", problem: "어머니 하람보다 나이가 많게 적혀 있다", evidence: "열일곱 살 견습 등대지기", suggestion: "생년을 고친다", related: ["C-010"] }, { field: "", kind: "빈 핵심 정보", severity: "낮음", problem: "외모가 비어 있다", evidence: "", suggestion: "외모를 채운다", related: [] }] }
      : id === "F-002" ? { id, ok: false, issues: [{ field: "관계", kind: "세계 규칙 위반", severity: "중간", problem: "교단이 불을 섬기는데 등명 계약과 어긋난다", evidence: "등대의 불을 섬기는 교단", suggestion: "교리를 정한다", related: ["K-001"] }] }
      : { id, ok: true, issues: [] });
    return { verdicts };
  }
  if (sys.includes("항목별 점검 결과를 모아")) return { summary: "인물 연표에 어긋남이 있습니다.", patterns: [{ problem: "서리 가족의 생년이 서로 맞지 않는다", refs: ["C-001", "C-010"], suggestion: "가족 생년표를 만든다" }] };
  if (sys.includes("원고 기록 담당자")) return { summary: "장면 요약", when: "320년", where: "등대", cast: ["서리"], events: ["불이 꺼진다"], learned: [{ who: "서리", what: "표식" }], items: [], changes: [], opened: ["누가 껐나"], closed: [] };
  if (sys.includes("원고 검토 편집자다. 작품 전체")) {
    const ids = [...user.matchAll(/### (ms-[a-z0-9]+)/g)].map((m) => m[1]);
    return { summary: "중반의 인과가 약합니다.", issues: [{ refs: [ids[1], "ms-없음"], kind: "연속성", severity: "높음", problem: "노을이 죽은 뒤 다시 나온다", evidence: "노을이 웃었다", suggestion: "다른 인물로 바꾼다" }, { refs: [ids[0]], kind: "회수 안 된 복선", severity: "낮음", problem: "등명부의 빈칸이 회수되지 않는다", evidence: "", suggestion: "마지막 장에서 회수" }] };
  }
  if (sys.includes("지적된 문제가 장면 원문에")) return { verdict: "맞음", reason: "2장면에서 노을이 말한다" };
  return {};
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("400")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message + " @ " + (e.stack || "").split("\n").slice(1, 3).join(" ")));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData());
    if (req.url().includes("count_tokens")) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ input_tokens: body.messages[0].content.includes("### ms-") ? mock.tokens : 1000 }) });
    quickReqs.push({ body });
    if (mock.failAt === quickReqs.length) return route.fulfill({ status: 400, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "테스트 오류" } }) });
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ id: "q", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(answer(body)) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 } }) });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const closeSheet = async () => { if (await page.isVisible("#sheet")) { await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } }); await page.waitForTimeout(80); } };
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await closeSheet(); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const idbGet = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); }; }), key);
  const idbSet = (key, val) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; }; }), [key, val]);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const sheetText = () => page.textContent("#sheetBody");
  const audits = async () => (await idbGet("audits:" + wid0)) || [];
  const waitDone = async (n, st = null) => { const t0 = Date.now(); while (true) { const l = await audits(); if (l.length >= n && (st ? l[n - 1].status === st : l[n - 1].status !== "running")) return; if (Date.now() - t0 > 20000) throw new Error("waitDone timeout " + n); await page.waitForTimeout(100); } };
  const openHub = async () => { await tab("codex"); await page.click('#codex [data-ctab="entries"]').catch(() => {}); await page.click('#codex [data-act="checks"]'); await page.waitForSelector("#sheetBody .audit-hub"); };

  await page.goto("http://localhost:8792/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  const wid0 = await wid();
  // 작품 하나와 장면 셋
  const ws0 = await idbGet("worlds");
  const w0 = ws0.find((w) => w.id === wid0);
  w0.works = [{ id: "wk-t1", title: "등대지기의 딸", chapters: [{ id: "ch-a", title: "1장" }, { id: "ch-b", title: "2장" }], createdAt: Date.now(), plan: { paragraph: "시작\n위기1\n위기2\n위기3\n결말" } }];
  await idbSet("worlds", ws0);
  const now = Date.now();
  const sc = (id, title, ch, order, body) => ({ id, title, kind: "장면", body, refs: ["C-001"], workId: "wk-t1", chapterId: ch, order, status: "초고", createdAt: now, updatedAt: now, by: "user" });
  await idbSet("ms:" + wid0, [sc("ms-aaa111", "꺼진 등대", "ch-a", 0, "서리는 꺼진 화로 앞에 섰다."), sc("ms-bbb222", "노을의 목소리", "ch-a", 1, "노을이 웃었다. 서리는 놀랐다."), sc("ms-ccc333", "항구", "ch-b", 0, "항구에는 안개가 가득했다.")]);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 점검 센터 ----
  await openHub();
  const groups = await page.$$eval(".check-group h3", (hs) => hs.map((h) => h.textContent.trim()));
  check("점검 센터: 전수점검·스토리 점검·작품 계획 바로가기", (await sheetText()).includes("점검 센터") && !!(await page.$('[data-act="hub-entries"]')) && !!(await page.$('[data-act="hub-story"]')) && !!(await page.$('[data-hub-work="wk-t1"]')));
  check("앱 점검 결과는 그대로(점검 센터는 그 위에 따로)", groups.length > 0 && groups[0].startsWith("관계 없는 항목") && !groups.some((g) => g.includes("점검 센터")), groups.join("|"));
  check("대화로 묻기는 남음", !!(await page.$('[data-act="deep-check"]')));
  await page.screenshot({ path: path.join(SHOTS, "180-hub.png") });

  // ---- 2. 카테고리 전수점검 ----
  await page.click('[data-act="hub-entries"]');
  await page.waitForSelector("#auditForm");
  const live = (await idbGet("entries:" + wid0)).filter((e) => !e.deleted && e.status !== "discarded");
  check("분류 선택: 개수 표시", (await page.$$("[data-at]")).length >= 4 && (await sheetText()).includes("인물"));
  await page.click('[data-act="au-est"]');
  await page.waitForFunction(() => document.querySelector("#au-est").textContent.includes("예상"));
  const est = await page.textContent("#au-est");
  check("예상 비용: 항목·묶음·캐시·금액", est.includes(`항목 ${live.length}개`) && est.includes("묶음") && est.includes("캐시") && est.includes("$"), est);
  const q0 = quickReqs.length;
  await page.click('#auditForm [type="submit"]');
  await waitDone(1);
  await page.waitForTimeout(300);
  let reps = await audits();
  let rep = reps[0];
  const sent = quickReqs.slice(q0);
  const first = sent[0].body;
  check("공통 맥락은 캐시(둘째 system 블록)", first.system.length === 2 && first.system[1].cache_control?.type === "ephemeral" && first.system[1].text.includes("설정집 색인") && first.system[1].text.includes("공통 작성 규칙"));
  check("형식 출력·판정 스키마", first.output_config.format.schema.required.includes("verdicts"));
  check("모든 항목 판정(빠진 F-001은 다시 보냄)", live.every((e) => rep.verdicts[e.id]) && rep.chunks.some((c) => c.retry && c.ids.includes("F-001")) && rep.verdicts["F-001"].ok === true, JSON.stringify(Object.keys(rep.verdicts)));
  check("묶음 요청 수 = 묶음 수", mock.entryReqs === rep.chunks.length, `${mock.entryReqs}/${rep.chunks.length}`);
  check("문제 저장: 관련 항목·근거", rep.issues.length === 3 && rep.issues.find((x) => x.ref === "C-001" && x.severity === "높음").related.join() === "C-010" && rep.issues.find((x) => x.ref === "F-002").evidence.includes("교단"));
  check("종합: 요약·여러 항목 문제", rep.summary.includes("연표") && rep.patterns[0].refs.join() === "C-001,C-010" && rep.status === "done");
  check("비용 누적(캐시 읽기 포함)", rep.cost > 0);
  let t = await sheetText();
  check("보고서 화면: 판정·이상 없음·문제·종합", t.includes(`판정 ${live.length}개`) && t.includes("이상 없음") && t.includes("여러 항목에 걸친 문제") && t.includes("어머니 하람보다"));
  await page.screenshot({ path: path.join(SHOTS, "181-report.png") });
  // 거르기·해결·되돌리기
  await page.check('[name="af-sev"][value="높음"]');
  await page.waitForTimeout(150);
  check("거르기: 높음만", (await page.$$(".audit-issue")).length === 1);
  await page.check('[name="af-sev"][value="all"]');
  await page.waitForTimeout(100);
  const fid = rep.issues.find((x) => x.ref === "F-002").id;
  await page.click(`[data-ai-st="${fid}|fixed"]`);
  await page.waitForTimeout(150);
  check("해결 → 열린 것에서 빠짐", (await page.$$(".audit-issue")).length === 2 && (await audits())[0].issues.find((x) => x.id === fid).state === "fixed");
  await page.check('[name="af-st"][value="all"]');
  await page.waitForTimeout(100);
  await page.click(`[data-ai-st="${fid}|open"]`);
  await page.waitForTimeout(100);
  check("되돌리기", (await audits())[0].issues.find((x) => x.id === fid).state === "open");
  // Claude와 고치기
  const cid = rep.issues.find((x) => x.ref === "C-001" && x.severity === "높음").id;
  await page.click(`[data-ai-fix="${cid}"]`);
  await page.waitForTimeout(250);
  const inp = await page.inputValue("#input");
  check("Claude와 고치기: 새 대화에 문제·근거·관련 항목", inp.includes("카테고리 전수점검") && inp.includes("C-001") && inp.includes("어머니 하람보다") && inp.includes("C-010"));

  // ---- 3. 바뀐 것만 다시 점검 ----
  const ents = await idbGet("entries:" + wid0);
  ents.find((e) => e.id === "C-012").updatedAt = Date.now() + 1000;
  ents.find((e) => e.id === "C-012").summary = "서리의 여동생, 바다를 무서워한다";
  await idbSet("entries:" + wid0, ents);
  await page.reload(); await page.waitForSelector("#app");
  await openHub();
  check("보고서 목록", (await page.$$("[data-hub-rep]")).length === 1);
  await page.click('[data-act="hub-entries"]');
  await page.waitForSelector("#auditForm");
  check("바뀐 것만 선택지", await page.isChecked("#au-changed"));
  const before = mock.entryReqs;
  const q1 = quickReqs.length;
  await page.click('#auditForm [type="submit"]');
  await waitDone(2);
  reps = await audits();
  const sentIds = quickReqs.slice(q1).map((r) => (r.body.messages[0].content.match(/점검할 항목 id: ([^\n]+)/) || [])[1]).filter(Boolean).join(", ").split(", ");
  check("바뀐 항목과 이어진 항목만 보냄", sentIds.includes("C-012") && sentIds.includes("C-010") && !sentIds.includes("K-001") && sentIds.length < live.length, sentIds.join());
  check("안 바뀐 항목의 판정·문제는 이어받음", live.every((e) => reps[1].verdicts[e.id]) && reps[1].issues.some((x) => x.ref === "F-002"));
  check("요청 수 줄어듦", mock.entryReqs - before < rep.chunks.length);

  // ---- 4. 오류로 멈춤 → 이어서 하기 ----
  await closeSheet();
  await openHub();
  await page.click('[data-act="hub-entries"]');
  await page.waitForSelector("#auditForm");
  await page.uncheck("#au-changed");
  mock.failAt = quickReqs.length + 2;
  await page.click('#auditForm [type="submit"]');
  await waitDone(3);
  await page.waitForTimeout(200);
  reps = await audits();
  check("오류로 멈춤: 상태·오류·진행 저장", reps[2].status === "stopped" && reps[2].error && reps[2].chunks.filter((c) => c.done).length === 1, JSON.stringify([reps[2].status, reps[2].error]));
  check("멈춤 표시와 이어서 하기", (await sheetText()).includes("멈춤") && !!(await page.$('[data-act="au-resume"]')));
  const doneBefore = Object.keys(reps[2].verdicts).length;
  await page.click('[data-act="au-resume"]');
  await waitDone(3, "done");
  reps = await audits();
  check("이어서 하기: 남은 묶음만 보내 끝냄", reps[2].status === "done" && live.every((e) => reps[2].verdicts[e.id]) && doneBefore > 0);

  // ---- 5. 스토리 전체 점검: 원고 전문 ----
  await closeSheet();
  await openHub();
  await page.click('[data-act="hub-story"]');
  await page.waitForSelector("#storyAuditForm");
  await page.click('[data-act="sa-est"]');
  await page.waitForFunction(() => document.querySelector("#sa-est").textContent.includes("예상"));
  check("스토리 예상: 장면·원고 전문", (await page.textContent("#sa-est")).includes("장면 3개") && (await page.textContent("#sa-est")).includes("원고 전문을 한 번에"));
  const q2 = quickReqs.length;
  await page.click('#storyAuditForm [type="submit"]');
  await waitDone(4);
  await page.waitForTimeout(250);
  reps = await audits();
  let srep = reps[3];
  const sreq = quickReqs.slice(q2);
  check("원고 전문: 요청 하나(기록 없음)", sreq.length === 1 && sreq[0].body.messages[0].content.includes("원고 전문") && sreq[0].body.messages[0].content.includes("노을이 웃었다") && sreq[0].body.messages[0].content.includes("계획:"));
  check("스토리 결과: 없는 장면 id는 뺌", srep.status === "done" && srep.full && srep.issues.length === 2 && srep.issues[0].refs.join() === "ms-bbb222");
  t = await sheetText();
  check("스토리 보고서: 장면 단추·본문으로 다시 확인", t.includes("노을이 죽은 뒤") && !!(await page.$('[data-ms-open="ms-bbb222"]')) && !!(await page.$("[data-ai-verify]")));
  await page.click(`[data-ai-verify="${srep.issues[0].id}"]`);
  await page.waitForFunction(() => document.querySelector("#sheetBody").textContent.includes("본문 확인: 맞음"), null, { timeout: 15000 });
  check("본문으로 다시 확인: 원문을 보내고 판정 표시", quickReqs.at(-1).body.messages[0].content.includes("노을이 웃었다") && (await audits())[3].issues[0].verify.verdict === "맞음");
  await page.screenshot({ path: path.join(SHOTS, "182-story.png") });

  // ---- 6. 스토리 점검: 분량이 크면 장면 기록 → 전체, 기록 재사용 ----
  mock.tokens = 200000;
  await closeSheet();
  await openHub();
  await page.click('[data-act="hub-story"]');
  await page.waitForSelector("#storyAuditForm");
  const q3 = quickReqs.length;
  await page.click('#storyAuditForm [type="submit"]');
  await waitDone(5);
  reps = await audits();
  let s3 = quickReqs.slice(q3);
  check("장면 기록 3개(Haiku) → 전체(장면 기록)", s3.length === 4 && s3.slice(0, 3).every((r) => r.body.model === "claude-haiku-5-5" && r.body.system[0].text.includes("원고 기록 담당자")) && s3[3].body.messages[0].content.includes("장면 기록(원문 대신") && s3[3].body.messages[0].content.includes("알게 된 것: 서리: 표식") && !reps[4].full, s3.length);
  check("기록 저장", Object.keys((await idbGet("scenerec:" + wid0)) || {}).length === 3);
  // 한 장면만 고치고 다시
  const ms = await idbGet("ms:" + wid0);
  ms[2].body += " 등불제가 열렸다.";
  await idbSet("ms:" + wid0, ms);
  await page.reload(); await page.waitForSelector("#app");
  await openHub();
  await page.click('[data-act="hub-story"]');
  await page.waitForSelector("#storyAuditForm");
  await page.click('[data-act="sa-est"]');
  await page.waitForFunction(() => document.querySelector("#sa-est").textContent.includes("예상"));
  check("예상: 새로 만들 기록 1개", (await page.textContent("#sa-est")).includes("새로 만들 기록 1개"));
  const q4 = quickReqs.length;
  await page.click('#storyAuditForm [type="submit"]');
  await waitDone(6);
  s3 = quickReqs.slice(q4);
  check("바뀐 장면만 기록을 다시 만듦", s3.length === 2 && s3[0].body.messages[0].content.includes("등불제가 열렸다"));
  reps = await audits();
  check("보고서는 최근 6개까지", reps.length === 6);

  // ---- 7. 화면 폭 ----
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(150);
  check("360px: 보고서 넘침 없음", (await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth])).every((v, i) => (i ? v <= 1 : v <= 360)));
  await closeSheet();
  await openHub();
  check("360px: 점검 센터 넘침 없음", (await page.evaluate(() => document.querySelector("#sheetBody").scrollWidth - document.querySelector("#sheetBody").clientWidth)) <= 1);
  await page.screenshot({ path: path.join(SHOTS, "183-hub-360.png") });

  check("콘솔 오류 없음", !errors.length, errors.join(" | ").slice(0, 500));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " :: " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
