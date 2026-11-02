// 분류·템플릿 + 예전 대화 버전 고정 E2E 테스트
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const V = (n) => L.LEGACY(n);
fs.mkdirSync(path.join(SCRATCH, "files"), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, "files/종교.md"), "# 종교\n\n- 신:\n- 성지:\n- 신도 수:\n\n## 교리\n> 핵심 믿음\n\n## 의식\n");
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8767);

function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function msg(id, blocks, stop) {
  const ev = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 }, input_transformations: [] } }];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } });
      ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
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
    const body = JSON.parse(req.postData());
    requests.push({ headers: req.headers(), body });
    const make = queue.shift() || (() => msg("x", [{ text: "네." }], "end_turn"));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: make() });
  });

  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#sendBtn").textContent === "보내기", null, { timeout: 15000 });
  const closeSheet = () => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const send = async (text, n) => {
    await page.fill("#input", text); await page.click("#sendBtn"); await until(() => requests.length >= n); await waitIdle();
    await page.evaluate(() => document.activeElement?.blur()); // 키보드 닫기(열려 있으면 하단 탭이 숨는다)
    await page.waitForTimeout(300);
  };
  const lastUser = (r) => r.body.messages[r.body.messages.length - 1];
  const clickType = async (label) => {
    const key = await page.$$eval("[data-type-edit]", (els, l) => els.find((e) => e.querySelector(".t").textContent.trim().replace(/\s+[A-Z0-9]{1,3}$/, "") === l)?.dataset.typeEdit, label);
    await page.click(`[data-type-edit="${key}"]`);
  };

  await page.goto("http://localhost:8767/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await page.click('.tabbar [data-view="settings"]');
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');

  // ---- 1. 예전 대화는 처음 버전 그대로 ----
  const worldId = await page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  await page.evaluate(async (wid) => {
    const mk = (id, iso) => ({ id, title: `옛 대화 ${id}`, createdAt: Date.parse(iso), updatedAt: Date.parse(iso), contextSent: true, syncedAt: Date.parse(iso), lastCtx: 0 });
    const threads = [mk("old1", "2026-11-01T15:00:00Z"), mk("old2", "2026-11-01T15:40:00Z"), mk("old3", "2026-11-01T15:50:00Z")];
    const conv = (t) => ({
      api: [
        { role: "user", content: [{ type: "text", text: "[설정집 현황 · 앱이 자동으로 첨부함]\n..." }, { type: "text", text: `처음 질문 ${t}` }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: `sig_${t}` }, { type: "text", text: "예전 답" }] },
      ],
      display: [{ role: "user", text: `처음 질문 ${t}`, at: 1 }, { role: "assistant", parts: [{ kind: "text", text: "예전 답" }], at: 2 }],
    });
    const db = await new Promise((res, rej) => { const r = indexedDB.open("lorekeeper", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      const st = tx.objectStore("kv");
      st.put(threads, "threads:" + wid);
      for (const t of threads) st.put(conv(t.id), "conv:" + t.id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }, worldId);
  await page.reload();
  await page.waitForSelector("#app");
  for (const [tid, v] of [["old1", 1], ["old2", 2], ["old3", 3]]) {
    await page.click('.tabbar [data-view="chat"]');
    await page.click("#threadsBtn");
    await page.click(`[data-thread="${tid}"]`);
    const n = requests.length + 1;
    await send(`이어서 ${tid}`, n);
    const r = requests[n - 1];
    const exp = V(v);
    check(`예전 대화 ${tid} → v${v} 프롬프트 그대로`, r.body.system[0].text === exp.system && JSON.stringify(r.body.tools) === JSON.stringify(exp.tools), `tools=${r.body.tools.map((t) => t.name).join(",")}`);
    check(`예전 대화 ${tid} 안전장치 포함`, r.body.thinking.block_binding?.prefix_mismatch_behavior === "drop_block");
    check(`예전 대화 ${tid} 기록 보존(서명)`, r.body.messages[1].content[0].signature === `sig_${tid}`);
  }

  // ---- 2. 예시 템플릿 가져오기 ----
  await page.click('.tabbar [data-view="settings"]');
  await page.click('#settings [data-act="types"]');
  await page.waitForSelector("[data-type-edit]");
  check("기본 분류 8개", (await page.$$eval("[data-type-edit]", (e) => e.length)) === 8);
  await page.click('[data-ts="sample"]');
  await page.waitForSelector("#importTplForm");
  const plan = await page.$$eval(".imp", (fs) => fs.map((f) => ({ label: f.querySelector(".imp-label").value, target: f.querySelector(".imp-target").value, code: f.querySelector(".imp-code").value })));
  check("예시: 캐릭터→인물, 아이템→사물에 연결", plan[0].target === "character" && plan[3].target === "item", JSON.stringify(plan));
  check("예시: 국가 N, 마법 M, 고유 명사 G 새 분류", plan[1].target === "__new" && plan[1].code === "N" && plan[2].code === "M" && plan[4].code === "G", JSON.stringify(plan));
  await page.screenshot({ path: `${SHOTS}/30-import.png` });
  await page.click('#importTplForm button[type="submit"]');
  await page.waitForSelector("[data-type-edit]");
  const typeRows = await page.$$eval("[data-type-edit] .t", (e) => e.map((x) => x.textContent.trim()));
  check("분류 11개(캐릭터·아이템 이름 변경 포함)", typeRows.length === 11 && typeRows.some((t) => t.startsWith("캐릭터")) && typeRows.some((t) => t.startsWith("아이템")) && typeRows.some((t) => t.startsWith("국가")), typeRows.join(" | "));
  await page.screenshot({ path: `${SHOTS}/31-types.png` });

  // 파일로 가져오기
  await page.setInputFiles("#tplFiles", { name: "종교.md", mimeType: "text/markdown", buffer: fs.readFileSync(path.join(SCRATCH, "files/종교.md")) });
  await page.waitForSelector("#importTplForm");
  check("파일 이름으로 분류 이름", (await page.inputValue(".imp-label")) === "종교");
  await page.click('#importTplForm button[type="submit"]');
  await page.waitForSelector("[data-type-edit]");
  check("종교 분류 추가", (await page.$$eval("[data-type-edit]", (e) => e.length)) === 12);

  // 분류 편집: 템플릿 수정
  await clickType("국가");
  await page.waitForSelector("#typeForm");
  const tpl = await page.inputValue("#t-template");
  await page.fill("#t-template", tpl.replace("- 화폐:", "- 화폐:\n- 국력:"));
  check("편집 중 칸 미리보기", (await page.textContent("#t-parsed")).includes("국력") || (await page.textContent("#t-parsed")).includes("속성 칸 9개"));
  await page.click('#typeForm button[type="submit"]');
  await page.waitForSelector("[data-type-edit]");
  await closeSheet();

  // ---- 3. 직접 만들 때 템플릿 칸 미리 채우기 ----
  await page.click('.tabbar [data-view="codex"]');
  await page.click('[data-act="new-entry"]');
  await page.selectOption("#f-type", { label: "국가" });
  const keys = await page.$$eval("#f-fields .fk", (e) => e.map((x) => x.value));
  check("템플릿 속성 칸 미리 채움", keys.includes("정식 국호") && keys.includes("국력") && keys.length === 9, keys.join(","));
  check("본문 소제목 미리 채움", (await page.inputValue("#f-body")).startsWith("## 지리와 기후"));
  await page.fill("#f-name", "솔트렌 왕국");
  await page.fill("#f-summary", "소금 사막 위의 왕국");
  await page.fill('#f-fields .kv-row:first-child .fv', "솔트렌 연합 왕국");
  await page.screenshot({ path: `${SHOTS}/32-editor.png` });
  await page.click('#entryForm button[type="submit"]');
  await page.waitForSelector("#sheetBody .entry-name");
  check("국가 항목은 N-001", (await page.textContent("#sheetBody .catno")) === "N-001");
  const status = await page.textContent("#sheetBody .tpl-status");
  check("템플릿 빈 칸 표시", status.includes("국가 템플릿") && status.includes("빈 칸"), status);
  await page.screenshot({ path: `${SHOTS}/33-entry-template.png` });
  await page.click('#sheetBody [data-act="tpl-ask"]');
  check("Claude에게 채우기 → 입력란", (await page.inputValue("#input")).includes("국가 템플릿에 맞게"));
  await page.fill("#input", "");

  // ---- 4. 새 대화에서 Claude가 템플릿 사용 ----
  await page.click("#newThreadBtn");
  queue.push(() => msg("t1", [{ tool: "list_types", id: "tu_a", input: {} }, { tool: "get_template", id: "tu_b", input: { type: "국가" } }], "tool_use"));
  queue.push(() => msg("t2", [{ tool: "create_entry", id: "tu_c", input: { type: "국가", name: "에델 공화국", summary: "북쪽 호수의 공화국", fields: { "정식 국호": "에델 호수 공화국", "수도": "(미정)" }, body: "## 지리와 기후\n호수 지대" } }], "tool_use"));
  queue.push(() => msg("t3", [{ text: "에델 공화국(N-002)을 만들었어요." }], "end_turn"));
  const base = requests.length;
  await send("북쪽에 공화국을 하나 만들어 줘", base + 3);
  const q1 = requests[base];
  const first = q1.body.messages[0].content[0].text;
  check("첫 메시지 분류 목록에 국가·템플릿 표시", first.includes("국가 (키 u_") && first.includes("ID 코드 N") && /국가[^\n]*템플릿 있음/.test(first), first.split("\n").filter((l) => l.includes("국가")).join(" / "));
  const tr = lastUser(requests[base + 1]).content;
  check("list_types 결과", tr[0].content.includes("국가") && tr[0].content.includes("고유 명사"));
  check("get_template 결과(칸·소제목·원문)", tr[1].content.includes("속성(fields) 키: 정식 국호") && tr[1].content.includes("국력") && tr[1].content.includes("본문 소제목: 지리와 기후"), tr[1].content.slice(0, 120));
  const tr2 = lastUser(requests[base + 2]).content[0].content;
  check("이름으로 분류 지정해 생성 → N-002 + 빈 칸 안내", tr2.includes("N-002") && tr2.includes("템플릿에서 아직 비어 있는 칸") && tr2.includes("수도"), tr2);
  check("답변 속 N-002 링크", await page.$('#chatLog .ref[data-ref="N-002"]'));

  // 대화 중 템플릿 변경 → 다음 메시지에 알림
  await page.click('.tabbar [data-view="settings"]');
  await page.click('#settings [data-act="types"]');
  await clickType("마법");
  await page.fill("#t-template", "- 계통:\n\n## 원리\n");
  await page.click('#typeForm button[type="submit"]');
  await page.waitForSelector("[data-type-edit]");
  await closeSheet();
  await page.click('.tabbar [data-view="chat"]');
  const b2 = requests.length;
  await send("마법도 정리해 줘", b2 + 1);
  const noteText = lastUser(requests[b2]).content.find((c) => c.type === "text" && c.text.startsWith("[앱 알림")).text;
  check("템플릿 변경 알림", noteText.includes("분류·템플릿 변경: 마법") && noteText.includes("get_template"), noteText);
  check("같은 대화 시스템·도구 유지", JSON.stringify(requests[b2].body.tools) === JSON.stringify(q1.body.tools) && requests[b2].body.system[0].text === q1.body.system[0].text);

  // ---- 5. 관계도 색, 분류 삭제(항목 옮기기) ----
  await page.click('.tabbar [data-view="graph"]');
  await page.waitForSelector('[data-gtype]');
  const dots = await page.$$eval("#graphTypes [data-gtype]", (els) => els.filter((e) => e.querySelector(".tdot")).map((e) => e.textContent.trim() + "|" + e.querySelector(".tdot").getAttribute("style")));
  check("관계도 범례에 국가(사용자 색)", dots.some((d) => d.startsWith("국가") && d.includes("--t-c")), dots.join(" ; "));
  await page.click('.tabbar [data-view="settings"]');
  await page.click('#settings [data-act="types"]');
  await clickType("고유 명사");
  await page.click('[data-te="delete"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForSelector("[data-type-edit]");
  check("항목 없는 분류 삭제", (await page.$$eval("[data-type-edit]", (e) => e.length)) === 11);
  await clickType("국가");
  await page.click('[data-te="delete"]');
  await page.waitForSelector("#t-delete-box:not([hidden])");
  await page.selectOption("#t-move", { label: "세력" });
  await page.click('[data-te="delete-confirm"]');
  await page.click('#dialog [data-r="1"]');
  await page.waitForSelector("[data-type-edit]");
  await closeSheet();
  await page.click('.tabbar [data-view="codex"]');
  await page.click('.entry-card[data-ref="N-001"]');
  check("항목이 세력으로 옮겨짐(번호 유지)", (await page.textContent("#sheetBody .entry-head")).includes("세력"));
  await closeSheet();

  // ---- 6. 새 세계관에 분류 복사 ----
  await page.click("#worldBtn");
  await page.click('#sheetBody [data-act="new-world"]');
  check("복사 선택지 기본 켜짐(템플릿 있을 때)", await page.isChecked("#w-copy-types"));
  await page.fill("#w-name", "두 번째 세계");
  await page.click('#worldForm button[type="submit"]');
  await page.click('.tabbar [data-view="settings"]');
  await page.click('#settings [data-act="types"]');
  const rows2 = await page.$$eval("[data-type-edit] .t", (e) => e.map((x) => x.textContent.trim()));
  check("새 세계관이 분류·템플릿을 물려받음", rows2.some((t) => t.startsWith("캐릭터")) && rows2.some((t) => t.startsWith("종교")) && rows2.length === 10, rows2.join(" | "));

  check("가로 넘침 없음", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
