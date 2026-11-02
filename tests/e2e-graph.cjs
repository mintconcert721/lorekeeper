// 관계도 화면 E2E 테스트 (API 호출 없음)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
fs.mkdirSync(SHOTS, { recursive: true });
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8766);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());

  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const nodes = () => page.$$eval("#gNodes .g-node", (els) => els.map((e) => { const m = e.getAttribute("transform").match(/translate\(([-\d.]+),([-\d.]+)\)/); return { id: e.dataset.id, x: +m[1], y: +m[2] }; }));
  const posOf = async (id) => (await nodes()).find((n) => n.id === id);
  const scale = () => page.$eval("#gViewport", (g) => +g.getAttribute("transform").match(/scale\(([\d.]+)\)/)[1]);
  const tapNode = (id) => page.click(`#gNodes .g-node[data-id="${id}"] .dot`, { force: true });

  await page.goto("http://localhost:8766/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await page.click('.tabbar [data-view="graph"]');
  await page.waitForSelector("#gNodes .g-node");

  // 1. 그리기
  const ns = await nodes();
  check("항목 4개 노드", ns.length === 4, `n=${ns.length}`);
  check("관계 3개 선", (await page.$$eval("#gEdges .g-edge", (e) => e.length)) === 3);
  let minD = Infinity;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) minD = Math.min(minD, Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y));
  check("노드끼리 겹치지 않음", minD > 40, `min=${minD.toFixed(1)}`);
  const inside = await page.evaluate(() => { const st = document.querySelector("#graphStage").getBoundingClientRect(); return [...document.querySelectorAll("#gNodes .dot")].every((c) => { const r = c.getBoundingClientRect(); return r.left >= st.left && r.right <= st.right && r.top >= st.top && r.bottom <= st.bottom; }); });
  check("화면 맞춤으로 모두 보임", inside);
  check("관계 이름은 선택 전엔 숨김", (await page.$$eval(".g-elabel.show", (e) => e.length)) === 0);
  await page.screenshot({ path: `${SHOTS}/20-graph.png` });

  // 2. 선택
  await tapNode("C-001");
  await page.waitForSelector("#graphCard:not([hidden])");
  check("카드에 선택 항목", (await page.textContent("#graphCard")).includes("서리"));
  check("연결된 선 강조 2개", (await page.$$eval(".g-edge.hl", (e) => e.length)) === 2);
  const shownLabels = await page.$$eval(".g-elabel.show", (e) => e.map((t) => t.textContent));
  check("강조된 관계 이름 표시", shownLabels.includes("근무지") && shownLabels.some((t) => t.startsWith("아직 맺지")), shownLabels.join(","));
  check("나머지는 흐리게", (await page.$$eval(".g-node.dim", (e) => e.map((x) => x.dataset.id))).join() === "F-001");
  await page.screenshot({ path: `${SHOTS}/21-graph-selected.png` });

  // 3. 주변만 보기
  await page.click('#graphCard [data-g="focus"]');
  check("1단계 주변: 3개", (await nodes()).length === 3);
  check("주변 안내 표시", (await page.textContent("#graphHint")).includes("1단계"));
  await page.click('#graphHint [data-g="hops"]');
  check("2단계 주변: 4개", (await nodes()).length === 4);
  await page.click('#graphHint [data-g="unfocus"]');
  check("전체 보기로 복귀", (await nodes()).length === 4 && (await page.$eval("#graphHint", (e) => e.hidden)));

  // 4. 관계 잇기
  await page.click('#graphCard [data-g="link"]');
  check("잇기 안내 표시", (await page.textContent("#graphHint")).includes("이을 항목"));
  await tapNode("F-001");
  await page.waitForSelector("#linkForm");
  await page.click('#linkForm [data-fill="적대"]');
  check("자주 쓰는 관계 채우기", (await page.inputValue("#l-label")) === "적대");
  await page.fill("#l-reverse", "감시 대상");
  await page.click('#linkForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll("#gEdges .g-edge").length === 4);
  const labels2 = await page.$$eval(".g-elabel.show", (e) => e.map((t) => t.textContent));
  check("새 관계 선과 이름", labels2.includes("적대") && labels2.includes("감시 대상"), labels2.join(","));
  await page.click('#graphCard [data-g="open"]');
  await page.waitForSelector("#sheet:not([hidden]) .entry-name");
  const det = await page.textContent("#sheetBody");
  check("설정집에도 관계 저장", det.includes("적대") && det.includes("무등회") && det.includes("감시 대상"), det.slice(0, 160));
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });

  // 5. 끌어서 옮기기 + 기억
  const before = await posOf("P-001");
  const box = await page.$eval('#gNodes .g-node[data-id="P-001"] .dot', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + i * 10, box.y + i * 6);
  await page.mouse.up();
  const moved = await posOf("P-001");
  check("끌어서 옮기기", Math.hypot(moved.x - before.x, moved.y - before.y) > 30, `${JSON.stringify(before)} → ${JSON.stringify(moved)}`);
  await page.waitForTimeout(600);

  // 6. 필터
  await page.click('[data-gtype="place"]');
  check("장소 숨기기", (await nodes()).length === 3);
  await page.click('[data-gtype="place"]');
  check("장소 다시 보이기", (await nodes()).length === 4);

  // 7. 확대/축소
  const s0 = await scale();
  await page.click('[data-g="zoom-in"]');
  const s1 = await scale();
  check("+ 버튼 확대", s1 > s0, `${s0} → ${s1}`);
  const st = await page.$eval("#graphStage", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(st.x, st.y);
  await page.mouse.wheel(0, 400);
  check("휠 축소", (await scale()) < s1);

  // 8. 검색
  await page.fill("#graphSearch", "무등");
  await page.waitForFunction(() => document.querySelector("#graphCard .gc-name")?.textContent === "무등회", null, { timeout: 3000 });
  check("검색으로 찾아 선택", true);

  // 9. 새로고침 후 위치 유지
  await page.reload();
  await page.waitForSelector("#view-graph:not([hidden]) #gNodes .g-node");
  const afterReload = await posOf("P-001");
  check("새로고침 후 옮긴 위치 유지", Math.abs(afterReload.x - moved.x) < 1.5 && Math.abs(afterReload.y - moved.y) < 1.5, `${JSON.stringify(moved)} vs ${JSON.stringify(afterReload)}`);

  // 10. 설정집에서 새 항목 → 기존 자리 유지, 새 항목만 배치
  const prevAll = await nodes();
  await page.click('.tabbar [data-view="codex"]');
  await page.click('[data-act="new-entry"]');
  await page.selectOption("#f-type", "place");
  await page.fill("#f-name", "바람꼬리 섬");
  await page.fill("#f-summary", "잿빛 첨탑 등대가 서 있는 섬");
  await page.click('#f-rels + [data-add="rel"]').catch(() => page.click('[data-add="rel"]'));
  await page.fill("#f-rels .rl", "등대");
  await page.selectOption("#f-rels .rt", "P-001");
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  await page.click('.tabbar [data-view="graph"]');
  await page.waitForFunction(() => document.querySelectorAll("#gNodes .g-node").length === 5);
  const nowAll = await nodes();
  const stayed = prevAll.every((p) => { const q = nowAll.find((n) => n.id === p.id); return q && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5; });
  check("새 항목 추가 시 기존 자리 그대로", stayed);
  const newNode = nowAll.find((n) => n.id === "P-002");
  const p1 = nowAll.find((n) => n.id === "P-001");
  check("새 항목은 연결된 항목 근처", newNode && Math.hypot(newNode.x - p1.x, newNode.y - p1.y) < 260, newNode ? Math.hypot(newNode.x - p1.x, newNode.y - p1.y).toFixed(0) : "none");

  // 11. 상세 화면의 '관계도' 버튼
  await page.click('.tabbar [data-view="codex"]');
  await page.click('.entry-card[data-ref="K-001"]');
  await page.click('#sheetBody [data-act="graph"]');
  await page.waitForFunction(() => document.querySelector("#graphCard .gc-name")?.textContent === "등명 계약", null, { timeout: 3000 });
  check("상세에서 관계도로 이동해 선택", true);

  // 12. 다시 배치
  await page.click('[data-g="relayout"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForTimeout(200);
  const re = await nodes();
  let minD2 = Infinity;
  for (let i = 0; i < re.length; i++) for (let j = i + 1; j < re.length; j++) minD2 = Math.min(minD2, Math.hypot(re[i].x - re[j].x, re[i].y - re[j].y));
  check("다시 배치 후 5개, 겹침 없음", re.length === 5 && minD2 > 40, `min=${minD2.toFixed(1)}`);

  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await tapNode("C-001");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/22-graph-dark.png` });
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
