// 3차: 계보(가계도·조직도), 세력표, 지도, 생애 겹쳐 보기
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const MAP = path.join(SCRATCH, "files/map.png");
const seed = require(path.join(SCRATCH, "seed3.cjs"));
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8776);

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
    if (req.url().includes("count_tokens")) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ input_tokens: 1200 }) });
    requests.push({ body: JSON.parse(req.postData()) });
    const ev = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "r1", name: "respond", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ message: "네." }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const tab = async (v) => { await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(100); await page.click(`.tabbar [data-view="${v}"]`); };
  const gmode = (m) => page.click(`#graphModes [data-gmode="${m}"]`);
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const idbGet = (key) => page.evaluate((k) => new Promise((res, rej) => {
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
  }), key);
  const wid = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const nodeBox = (name) => page.evaluate((n) => { const g = [...document.querySelectorAll("#treeVp .t-node")].find((x) => x.querySelector(".t-name").textContent === n); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, name);
  const stageBox = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

  await page.goto("http://localhost:8776/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await seed(page);
  await page.reload();
  await page.waitForSelector("#app");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  const w = await wid();

  // ---- 1. 보기 모드 ----
  await tab("graph");
  check("보기 모드 5개", (await page.$$eval("#graphModes [data-gmode]", (els) => els.map((e) => e.textContent).join(","))) === "관계도,계보,관계표,호칭,지도");
  check("기본은 관계도", (await page.isVisible("#graphStage")) && (await page.isHidden("#treePane")));
  check("탭 이름 '관계·지도'", (await page.textContent('.tabbar [data-view="graph"]')).includes("관계·지도"));

  // ---- 2. 계보 ----
  await gmode("tree");
  await page.waitForSelector("#treeVp .t-node");
  check("계보 화면으로 전환", (await page.isHidden("#graphStage")) && (await page.isVisible("#treeStage")));
  const names = await page.$$eval("#treeVp .t-name", (els) => els.map((e) => e.textContent).sort().join(","));
  check("계보 노드 5개(스승 포함)", names === "나래,노을,도윤,서리,하람", names);
  const [no, dy, hr, sr, nr] = await Promise.all(["노을", "도윤", "하람", "서리", "나래"].map(nodeBox));
  check("세대: 노을 > 도윤 > 서리", no.y < dy.y - 10 && dy.y < sr.y - 10);
  check("같은 줄: 도윤·하람, 서리·나래", Math.abs(dy.y - hr.y) < 2 && Math.abs(sr.y - nr.y) < 2);
  check("부부·형제 점선 2개", (await page.$$("#treeVp .t-peer")).length === 2);
  check("두 부모 사이에서 자식 선이 내려옴", (await page.$$eval("#treeVp .t-edge", (els) => els.length)) === 3);
  check("생몰년 표시", (await page.textContent("#treeVp")).includes("276~330"));
  check("계보 화면 안에 다 보임(맞춤)", [no, dy, hr, sr, nr].every((b) => b.x >= 0 && b.x + b.w <= 390));
  await page.screenshot({ path: `${SHOTS}/85-tree.png` });
  await page.click(`#treeVp .t-node[data-id="C-011"]`, { force: true });
  await page.waitForSelector("#sheetBody .entry-name");
  check("노드 누르면 항목", (await page.textContent("#sheetBody .entry-name")) === "도윤");
  await closeSheet();
  // 관계 해석: 스승을 '쓰지 않음'으로
  await page.click('[data-tree="roles"]');
  await page.waitForSelector("#rolesForm");
  const roleLabels = await page.$$eval("#rolesForm select", (els) => els.map((e) => `${e.dataset.label}=${e.value}`));
  check("관계 해석: 자동 추정", ["어머니=up", "아버지=up", "남편=peer", "동생=peer", "스승=up", "숙적=none"].every((x) => roleLabels.includes(x)), roleLabels.join(" "));
  await page.selectOption('#rolesForm select[data-label="스승"]', "none");
  await page.click('#rolesForm button[type="submit"]');
  await page.waitForTimeout(400);
  check("스승을 빼면 노을이 계보에서 빠짐", (await page.$$("#treeVp .t-node")).length === 4);
  const worlds = await idbGet("worlds");
  check("관계 해석 저장(바꾼 것만)", JSON.stringify(worlds.find((x) => x.id === w).treeRoles) === JSON.stringify({ 스승: "none" }));
  await page.click('[data-tree="roles"]');
  await page.click('[data-act="roles-reset"]');
  await page.waitForTimeout(400);
  check("모두 자동으로 되돌리기", (await page.$$("#treeVp .t-node")).length === 5);
  await page.click('#treeStage [data-pz="in"]');
  check("확대 단추", (await page.$eval("#treeVp", (g) => g.getAttribute("transform"))).includes("scale"));

  // ---- 3. 세력표 ----
  await gmode("matrix");
  await page.waitForSelector("#matrix .mx");
  check("세력 3개 표", (await page.$$("#matrix .mx th.mx-row")).length === 3);
  const cellText = (a, b) => page.textContent(`#matrix [data-mx="${a}|${b}"]`);
  const cellClass = (a, b) => page.$eval(`#matrix [data-mx="${a}|${b}"]`, (el) => el.parentElement.className);
  check("등대 교단→무등회: 숙적(적대)", (await cellText("F-002", "F-001")) === "숙적" && (await cellClass("F-002", "F-001")).includes("tone-bad"));
  check("무등회→등대 교단: 상대 쪽 관계 표시", (await cellText("F-001", "F-002")) === "↩ 숙적" && (await cellClass("F-001", "F-002")).includes("weak"));
  check("등대 교단→해안 공화국: 동맹(우호)", (await cellClass("F-002", "F-003")).includes("tone-good"));
  check("정해지지 않은 쌍 1", (await page.textContent("#matrix")).includes("관계가 정해지지 않은 쌍 1 / 3"));
  await page.screenshot({ path: `${SHOTS}/86-matrix.png` });
  await page.click("[data-mx-ask]");
  check("빈 칸 Claude와 정하기 → 입력란", (await page.inputValue("#input")).includes("무등회(F-001)–해안 공화국(F-003)"));
  await page.fill("#input", "");
  await tab("graph");
  await page.click('#matrix [data-mx="F-001|F-003"]');
  await page.fill("#mx-ab .mx-rel-row:first-child .ml", "경계 대상");
  await page.fill("#mx-ba .mx-rel-row:first-child .ml", "무시");
  await page.click('#mxForm button[type="submit"]');
  await page.waitForTimeout(300);
  check("칸 편집 → 표 갱신", (await cellText("F-001", "F-003")) === "경계 대상" && (await cellText("F-003", "F-001")) === "무시");
  check("모든 쌍 정해짐", (await page.textContent("#matrix")).includes("모든 쌍의 관계가 정해져"));
  const ents = await idbGet("entries:" + w);
  const f1 = ents.find((e) => e.id === "F-001");
  check("관계 저장 + 이력", f1.relations.some((r) => r.to === "F-003" && r.label === "경계 대상") && f1.relations.some((r) => r.to === "P-001") && f1.history.length > 0);
  await page.click('#matrix [data-mx="F-002|F-003"]');
  await page.click('[data-act="mx-chat"]');
  check("대화로 정하기", (await page.inputValue("#input")).includes("등대 교단(F-002)와 해안 공화국(F-003)"));
  await page.fill("#input", "");
  await tab("graph");
  await page.click('#matrix [data-mtype="faction"]');
  await page.waitForTimeout(200);
  check("분류 끄면 빈 안내", (await page.textContent("#matrix")).includes("항목이 둘 이상 있어야"));
  await page.click('#matrix [data-mtype="faction"]');
  await page.waitForTimeout(200);
  check("분류 다시 켜기", (await page.$$("#matrix th.mx-row")).length === 3);

  // ---- 4. 지도 ----
  await gmode("map");
  await page.waitForSelector("#mapEmpty:not([hidden])");
  check("지도 없음 안내", (await page.textContent("#mapEmpty")).includes("지도가 없습니다"));
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click('#mapEmpty [data-map="upload"]')]);
  await fc.setFiles(MAP);
  await page.waitForSelector("#mapVp:not([hidden])");
  await page.waitForTimeout(300);
  let maps = await idbGet("maps:" + w);
  check("지도 저장(정보)", maps.length === 1 && maps[0].w === 1200 && maps[0].h === 800 && maps[0].name === "세계 지도");
  check("지도 그림 따로 저장", (await idbGet("mapimg:" + maps[0].img))?.startsWith("data:image/jpeg"));
  check("지도 화면에 맞춤", await page.evaluate(() => { const r = document.querySelector("#mapVp").getBoundingClientRect(); return r.width <= window.innerWidth && r.width > 300; }));
  // 핀 꽂기
  await page.click('[data-map="add"]');
  check("핀 추가 안내", (await page.textContent("#mapHint")).includes("자리를 누르세요"));
  const vpBox = await stageBox("#mapVp");
  await page.mouse.click(vpBox.x + vpBox.w * 0.8, vpBox.y + vpBox.h * 0.2);
  await page.waitForSelector("#pinList .entry-card");
  check("장소가 먼저", (await page.getAttribute("#pinList .entry-card", "data-ref")) === "P-001");
  check("방위 안내", (await page.textContent("#sheetBody")).includes("북동쪽"));
  await page.fill("#pinSearch", "등대 교단");
  await page.waitForTimeout(100);
  check("핀 고르기 검색", (await page.$$("#pinList .entry-card")).length === 1);
  await page.fill("#pinSearch", "");
  await page.click('#pinList [data-ref="P-001"]');
  await page.waitForSelector('.map-pin[data-pin="P-001"]');
  maps = await idbGet("maps:" + w);
  const pin = maps[0].pins[0];
  check("핀 위치 저장", pin.ref === "P-001" && Math.abs(pin.x - 0.8) < 0.03 && Math.abs(pin.y - 0.2) < 0.03, JSON.stringify(pin));
  check("핀 고른 뒤 카드", (await page.textContent("#mapCard")).includes("잿빛 첨탑 등대"));
  await page.screenshot({ path: `${SHOTS}/87-map.png` });
  // 옮기기
  await page.click('#mapCard [data-map="move"]');
  await page.mouse.click(vpBox.x + vpBox.w * 0.25, vpBox.y + vpBox.h * 0.75);
  await page.waitForTimeout(300);
  maps = await idbGet("maps:" + w);
  check("핀 옮기기", Math.abs(maps[0].pins[0].x - 0.25) < 0.03 && Math.abs(maps[0].pins[0].y - 0.75) < 0.03);
  // 두 번째 핀
  await page.click('[data-map="add"]');
  await page.mouse.click(vpBox.x + vpBox.w * 0.5, vpBox.y + vpBox.h * 0.5);
  await page.waitForSelector("#pinList .entry-card");
  await page.click('#pinList [data-ref="F-002"]');
  await page.waitForSelector('.map-pin[data-pin="F-002"]');
  // 빈 곳 누르면 선택 해제, 핀 누르면 선택
  await page.mouse.click(vpBox.x + vpBox.w * 0.9, vpBox.y + vpBox.h * 0.9);
  await page.waitForTimeout(150);
  check("빈 곳 누르면 카드 닫힘", await page.isHidden("#mapCard"));
  await page.click('.map-pin[data-pin="P-001"]');
  check("핀 누르면 카드", (await page.textContent("#mapCard")).includes("잿빛 첨탑 등대"));
  // 항목 화면 → 지도에서 보기
  await tab("codex");
  await page.click('.entry-card[data-ref="P-001"]');
  check("항목 화면에 지도 위치", (await page.textContent("#sheetBody")).includes("세계 지도 남서쪽"));
  await page.click('#sheetBody [data-act="map"]');
  await page.waitForSelector("#mapPane:not([hidden])");
  await page.waitForTimeout(300);
  check("지도에서 보기: 선택 + 가운데", (await page.$eval('.map-pin[data-pin="P-001"]', (el) => { const r = el.getBoundingClientRect(); return el.classList.contains("sel") && Math.abs(r.left - window.innerWidth / 2) < 40; })));
  // 관리: 이름 바꾸기
  await page.click('[data-map="manage"]');
  await page.fill("#map-name", "안개바다 전도");
  await page.click('#mapForm button[type="submit"]');
  await page.waitForTimeout(200);
  check("지도 이름 바꾸기", (await page.textContent("#mapTools")).includes("안개바다 전도"));
  // 그림 바꾸기: 핀 유지, 예전 그림 삭제
  const oldImg = (await idbGet("maps:" + w))[0].img;
  await page.click('[data-map="manage"]');
  const [fc2] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-mm="replace"]')]);
  await fc2.setFiles(MAP);
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("바꿨습니다"), null, { timeout: 10000 });
  maps = await idbGet("maps:" + w);
  check("그림 바꾸기: 핀 그대로, 새 그림", maps.length === 1 && maps[0].img !== oldImg && maps[0].pins.length === 2 && !(await idbGet("mapimg:" + oldImg)), JSON.stringify({ n: maps.length, same: maps[0].img === oldImg, pins: maps[0].pins.length, old: !!(await idbGet("mapimg:" + oldImg)), toast: await page.textContent("#toast") }));
  // 지도로 대화
  await page.click('[data-map="chat"]');
  await page.waitForSelector("#attachTray:not([hidden]) .att");
  check("지도로 대화: 첨부 + 핀 목록", (await page.inputValue("#input")).includes("안개바다 전도") && (await page.inputValue("#input")).includes("잿빛 첨탑 등대(P-001) 남서쪽"));
  await page.click("#attachTray .att-x");
  await page.waitForSelector("#attachTray", { state: "hidden" });
  await page.fill("#input", "");
  // 새 대화 첫 메시지에 지도 핀
  await page.click("#newThreadBtn");
  await page.fill("#input", "지도 얘기");
  const nReq = requests.length;
  await page.click("#sendBtn");
  for (let t = 0; requests.length <= nReq && t < 200; t++) await page.waitForTimeout(50);
  await page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기");
  const first = requests[requests.length - 1].body.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  check("대화 첫 메시지에 지도 핀", first.includes("지도(핀의 대략적인 위치)") && first.includes("안개바다 전도: 잿빛 첨탑 등대(P-001) 남서쪽, 등대 교단(F-002) 가운데"), first.split("\n").filter((l) => /지도|전도/.test(l)).join(" / "));
  // 다시 열어도 그대로
  await page.reload();
  await page.waitForSelector("#app");
  await tab("graph");
  await page.waitForSelector('.map-pin[data-pin="P-001"]');
  check("다시 열기: 지도·핀 유지", (await page.$$(".map-pin")).length === 2 && (await page.getAttribute("#mapImg", "src")).startsWith("data:image/jpeg"));
  // 두 번째 지도, 지우기
  await page.click('[data-map="manage"]');
  const [fc3] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-mm="new"]')]);
  await fc3.setFiles(MAP);
  await page.waitForSelector("#mapSelect");
  check("지도 2개: 고르기 표시", (await page.$$("#mapSelect option")).length === 2 && (await page.$$(".map-pin")).length === 0);
  const m2 = (await idbGet("maps:" + w))[1];
  await page.click('[data-map="manage"]');
  await page.click('[data-mm="delete"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForTimeout(300);
  maps = await idbGet("maps:" + w);
  const tomb = await idbGet("sync:tombstones");
  check("지도 지우기: 정보·그림·삭제 기록", maps.length === 1 && !(await idbGet("mapimg:" + m2.img)) && !!tomb.maps?.[`${w}:${m2.id}`]);
  // 핀 빼기
  await page.waitForSelector('.map-pin[data-pin="F-002"]');
  await page.click('.map-pin[data-pin="F-002"]');
  await page.click('#mapCard [data-map="unpin"]');
  await page.waitForTimeout(200);
  check("핀 빼기", (await idbGet("maps:" + w))[0].pins.length === 1);

  // ---- 5. 생애 겹쳐 보기 ----
  await tab("timeline");
  await page.click('[data-tlmode="life"]');
  await page.waitForSelector(".life-svg");
  check("생애 막대 5개", (await page.$$(".life-row")).length === 5);
  const panel = await page.textContent(".life-panel");
  check("기본 커서 = 지금(320년)", panel.includes("320년") && panel.includes("지금"));
  check("320년에 살아 있는 인물·나이", panel.includes("도윤 44세") && panel.includes("서리 15세") && panel.includes("나래 11세") && !panel.includes("하람") && !panel.includes("노을"), panel);
  check("이 해의 사건(기간)", panel.includes("안개 전쟁"));
  check("죽은 인물은 흐리게", (await page.$$(".life-row.dim")).length === 2);
  await page.screenshot({ path: `${SHOTS}/88-life.png` });
  await page.click('[data-life="next"]');
  check("한 해 뒤", (await page.textContent(".life-panel")).includes("321년"));
  const sv = await stageBox(".life-svg");
  const y0 = Number(await page.getAttribute(".life-svg", "data-y0"));
  const ppy = Number(await page.getAttribute(".life-svg", "data-ppy"));
  await page.mouse.click(sv.x + (300 - y0) * ppy, sv.y + sv.h - 20);
  await page.waitForTimeout(150);
  const p300 = await page.textContent(".life-panel");
  check("막대 위 누르기 → 그해(300년)", p300.includes("300년") && p300.includes("노을 60세") && p300.includes("하람 20세") && p300.includes("도윤 24세"), p300);
  await page.click('.life-panel [data-ref="C-013"]');
  check("이름 누르면 항목", (await page.textContent("#sheetBody .entry-name")) === "노을");
  await closeSheet();
  const w1 = (await stageBox(".life-svg")).w;
  await page.click('[data-life="in"]');
  check("확대하면 넓어짐", (await stageBox(".life-svg")).w > w1 * 1.4);
  await page.click('[data-life="out"]');
  await page.click('[data-life="all"]');
  check("세력·기간 항목도 켜기", (await page.getAttribute('[data-life="all"]', "aria-pressed")) === "true");
  check("보기 모드 기억", await page.evaluate(() => JSON.parse(localStorage.getItem("lk.tlmode")) === "life"));
  check("생애 화면 가로 넘침 없음", !(await overflow()));
  // 항목의 '연표에서 보기'는 목록으로 돌아간다
  await tab("codex");
  await page.click('.entry-card[data-ref="C-011"]');
  await page.click('#sheetBody [data-act="timeline"]');
  await page.waitForSelector("#tlSearch");
  check("연표에서 보기 → 목록 보기", (await page.getAttribute('[data-tlmode="list"]', "aria-selected")) === "true");

  // ---- 6. 백업·화면 ----
  await tab("settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-all"]')]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const bw = backup.worlds.find((x) => x.world.id === w);
  check("백업에 지도·그림", bw.maps.length === 1 && bw.mapImages[bw.maps[0].img]?.startsWith("data:image/jpeg"));
  await tab("graph");
  for (const m of ["graph", "tree", "matrix", "map"]) {
    await gmode(m);
    await page.waitForTimeout(150);
    if (await overflow()) check(`가로 넘침 없음 (${m})`, false);
  }
  await page.setViewportSize({ width: 320, height: 640 });
  for (const m of ["tree", "matrix", "map"]) {
    await gmode(m);
    await page.waitForTimeout(200);
    if (await overflow()) check(`320px 가로 넘침 없음 (${m})`, false);
  }
  check("320px 보기 모드 탭이 들어맞음", await page.$eval("#graphModes", (el) => el.scrollWidth <= el.clientWidth));
  await gmode("graph");
  await page.waitForTimeout(300);
  check("관계도로 돌아오면 그래프 그대로", (await page.$$("#gNodes .g-node")).length >= 8);
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
