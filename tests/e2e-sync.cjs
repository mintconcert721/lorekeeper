// GitHub 동기화 E2E 테스트: 가짜 GitHub(Git 데이터 API) + 기기 두 대(브라우저 컨텍스트 두 개)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8770);

// ---- 가짜 GitHub ----
const git = { blobs: new Map(), trees: new Map(), commits: new Map(), ref: null, log: [] };
const ghCalls = [];
let raceNextPatch = false;
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
function putBlob(buf) { const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])); git.blobs.set(sha, buf); return sha; }
function putTree(map) { const sha = sha1(Buffer.from("tree" + JSON.stringify(Object.entries(map).sort()))); git.trees.set(sha, { ...map }); return sha; }
function putCommit(tree, parents, message) { const sha = sha1(Buffer.from(JSON.stringify({ tree, parents, message, n: git.commits.size }))); git.commits.set(sha, { tree, parents, message }); return sha; }
function headFiles() { return git.ref ? git.trees.get(git.commits.get(git.ref).tree) : {}; }
async function ghRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };
  if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (req.headers()["authorization"] !== "Bearer good-token") return json(401, { message: "Bad credentials" });
  const base = "/repos/me/lorekeeper-data";
  if (!url.pathname.startsWith(base)) return json(404, { message: "Not Found" });
  const p = url.pathname.slice(base.length);
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  ghCalls.push(`${method} ${p}`);
  let m;
  if (method === "GET" && p === "") return json(200, { full_name: "me/lorekeeper-data", private: true, default_branch: "main", permissions: { admin: true, push: true, pull: true } });
  if (method === "GET" && p === "/git/ref/heads/main") return git.ref ? json(200, { ref: "refs/heads/main", object: { sha: git.ref, type: "commit" } }) : json(409, { message: "Git Repository is empty." });
  if (method === "PUT" && p === "/contents/README.md") {
    if (git.ref) return json(422, { message: "sha wasn't supplied" });
    const t = putTree({ "README.md": putBlob(Buffer.from(body.content, "base64")) });
    git.ref = putCommit(t, [], body.message);
    git.log.push(body.message);
    return json(201, { commit: { sha: git.ref } });
  }
  if (method === "GET" && (m = p.match(/^\/git\/commits\/(\w+)$/))) { const c = git.commits.get(m[1]); return json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) }); }
  if (method === "GET" && (m = p.match(/^\/git\/trees\/(\w+)$/))) {
    const t = git.trees.get(m[1]);
    const dirs = new Set();
    for (const f of Object.keys(t)) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
    return json(200, { sha: m[1], truncated: false, tree: [...[...dirs].map((d) => ({ path: d, mode: "040000", type: "tree", sha: sha1(Buffer.from(d)) })), ...Object.entries(t).map(([fp, sha]) => ({ path: fp, mode: "100644", type: "blob", sha, size: git.blobs.get(sha).length }))] });
  }
  if (method === "GET" && (m = p.match(/^\/git\/blobs\/(\w+)$/))) { const b = git.blobs.get(m[1]); return json(200, { sha: m[1], encoding: "base64", size: b.length, content: b.toString("base64").replace(/.{60}/g, "$&\n") }); }
  if (method === "POST" && p === "/git/blobs") return json(201, { sha: putBlob(body.encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8")) });
  if (method === "POST" && p === "/git/trees") {
    const map = { ...(git.trees.get(body.base_tree) || {}) };
    for (const it of body.tree) { if (it.sha === null) delete map[it.path]; else map[it.path] = it.sha; }
    return json(201, { sha: putTree(map) });
  }
  if (method === "POST" && p === "/git/commits") return json(201, { sha: putCommit(body.tree, body.parents, body.message) });
  if (method === "PATCH" && p === "/git/refs/heads/main") {
    if (raceNextPatch) {
      // 그 사이 다른 곳에서 README만 바꾼 커밋이 먼저 들어온 상황
      raceNextPatch = false;
      const files = { ...headFiles(), "README.md": putBlob(Buffer.from("# 바뀐 README\n")) };
      git.ref = putCommit(putTree(files), [git.ref], "외부 커밋");
      git.log.push("외부 커밋");
    }
    const c = git.commits.get(body.sha);
    if (!c.parents.includes(git.ref) && !body.force) return json(422, { message: "Update is not a fast forward" });
    git.ref = body.sha;
    git.log.push(c.message);
    return json(200, { ref: "refs/heads/main", object: { sha: body.sha } });
  }
  return json(404, { message: `Not Found: ${method} ${p}` });
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const errors = [];
  async function device(label) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
    await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await ctx.route("https://fonts.gstatic.com/**", (r) => r.abort());
    await ctx.route("https://api.github.com/**", ghRoute);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/401|Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    await page.goto("http://localhost:8770/");
    await page.waitForSelector("#app");
    return page;
  }
  const idbGet = (page, key) => page.evaluate((k) => new Promise((res, rej) => {
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
    r.onerror = () => rej(r.error);
  }), key);
  const idbSet = (page, key, val) => page.evaluate(([k, v]) => new Promise((res, rej) => {
    const r = indexedDB.open("lorekeeper", 1);
    r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
  }), [key, val]);
  const lastSync = (page) => page.evaluate(() => (JSON.parse(localStorage.getItem("lk.sync") || "{}").lastSyncAt) || 0);
  const waitSynced = async (page, after) => page.waitForFunction((t) => (JSON.parse(localStorage.getItem("lk.sync") || "{}").lastSyncAt || 0) > t && !document.querySelector("#syncBtn").classList.contains("running"), after, { timeout: 20000 });
  const syncNow = async (page) => { const t = await lastSync(page); await page.click("#syncBtn"); await waitSynced(page, t); };
  const worldId = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("lk.world")));
  const closeSheet = (page) => page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });
  const tab = (page, v) => page.click(`.tabbar [data-view="${v}"]`);
  async function connect(page, token, dev) {
    await tab(page, "settings");
    await page.fill("#syncRepo", "me/lorekeeper-data");
    await page.fill("#syncToken", token);
    await page.fill("#syncDevice", dev);
    const t = await lastSync(page);
    await page.click('#syncForm button[type="submit"]');
    if (token === "good-token") {
      try { await waitSynced(page, t); }
      catch (e) {
        console.log("DEBUG calls:", ghCalls.join(" | "));
        console.log("DEBUG sync:", await page.evaluate(() => localStorage.getItem("lk.sync")));
        console.log("DEBUG toast:", await page.textContent("#toast"), "errors:", errors.join(" || "));
        throw e;
      }
      await page.waitForSelector("#syncAuto");
      await page.uncheck("#syncAuto"); // 테스트는 버튼으로만 동기화
    }
  }
  async function editSummary(page, id, text) {
    await tab(page, "codex");
    await page.click(`.entry-card[data-ref="${id}"]`);
    await page.click('#sheetBody [data-act="edit"]');
    await page.fill("#f-summary", text);
    await page.click('#entryForm button[type="submit"]');
    await page.waitForSelector("#sheetBody .entry-name");
    await closeSheet(page);
  }
  async function newCharacter(page, name) {
    await tab(page, "codex");
    await page.click('[data-act="new-entry"]');
    await page.selectOption("#f-type", "character");
    await page.fill("#f-name", name);
    await page.fill("#f-summary", `${name} 요약`);
    await page.click('#entryForm button[type="submit"]');
    await page.waitForSelector("#sheetBody .entry-name");
    const id = await page.textContent("#sheetBody .catno");
    await closeSheet(page);
    return id;
  }
  const entriesOf = async (page) => (await idbGet(page, "entries:" + (await worldId(page)))) || [];

  // ---- 1. 기기 A: 첫 연결 ----
  const A = await device("A");
  await A.click("text=예시 세계관 둘러보기");
  await A.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await connect(A, "good-token", "A폰");
  const files1 = Object.keys(headFiles());
  check("빈 저장소 초기화 + 데이터 올림", files1.includes("README.md") && files1.includes("lorekeeper/index.json") && files1.some((f) => f.startsWith("lorekeeper/w/")), files1.join(","));
  check("커밋 메시지에 기기 이름", git.log.some((l) => l.includes("A폰")));
  check("상단 동기화 버튼 표시", await A.isVisible("#syncBtn"));
  check("설정에 연결 상태", (await A.textContent("#syncStatus")).includes("마지막 동기화"));
  await A.screenshot({ path: `${SHOTS}/50-sync-settings.png` });

  // ---- 2. 기기 B: 잘못된 토큰, 그다음 연결 ----
  const B = await device("B");
  await connect(B, "bad-token", "B패드");
  await B.waitForSelector("#toast:not([hidden])");
  check("잘못된 토큰 안내", (await B.textContent("#toast")).includes("토큰이 올바르지 않거나"));
  check("잘못된 토큰이면 연결 안 됨", !(await B.isVisible("#syncBtn")));
  await connect(B, "good-token", "B패드");
  check("B가 A의 세계관을 받음", (await B.textContent("#worldName")).includes("안개바다") && (await entriesOf(B)).length === 4);

  // ---- 3. 두 기기에서 다른 항목 고치기 ----
  await editSummary(A, "C-001", "A가 고친 서리 요약");
  await editSummary(B, "P-001", "B가 고친 등대 요약");
  await syncNow(A);
  await syncNow(B);
  await syncNow(A);
  const ea = await entriesOf(A);
  const eb = await entriesOf(B);
  const sum = (list, id) => list.find((e) => e.id === id)?.summary;
  check("A에 두 수정 모두", sum(ea, "C-001") === "A가 고친 서리 요약" && sum(ea, "P-001") === "B가 고친 등대 요약");
  check("B에 두 수정 모두", sum(eb, "C-001") === "A가 고친 서리 요약" && sum(eb, "P-001") === "B가 고친 등대 요약");

  // ---- 4. 같은 번호로 서로 다른 항목 ----
  const idA = await newCharacter(A, "가람");
  const idB = await newCharacter(B, "나래");
  check("두 기기 모두 C-002를 씀", idA === "C-002" && idB === "C-002");
  // B: 서리 → 나래 관계
  await tab(B, "codex");
  await B.click('.entry-card[data-ref="C-001"]');
  await B.click('#sheetBody [data-act="edit"]');
  await B.click('[data-add="rel"]');
  await B.fill("#f-rels .kv-row:last-child .rl", "벗");
  await B.selectOption("#f-rels .kv-row:last-child .rt", "C-002");
  await B.click('#entryForm button[type="submit"]');
  await B.waitForSelector("#sheetBody .entry-name");
  await closeSheet(B);
  await syncNow(A);
  await syncNow(B);
  await syncNow(A);
  const ea2 = await entriesOf(A);
  const byName = (list, n) => list.find((e) => e.name === n);
  check("먼저 올린 A의 가람이 C-002 유지", byName(ea2, "가람")?.id === "C-002");
  check("B의 나래는 C-003으로", byName(ea2, "나래")?.id === "C-003");
  check("서리의 관계도 C-003으로", (byName(ea2, "서리")?.relations || []).some((r) => r.label === "벗" && r.to === "C-003"), JSON.stringify(byName(ea2, "서리")?.relations));
  check("B 화면도 갱신", (await B.$$eval(".entry-card", (els) => els.map((e) => e.dataset.ref))).includes("C-003"));

  // ---- 5. 동시에 올리기(fast-forward 실패 → 다시 받아 합치기) ----
  await editSummary(B, "F-001", "B가 고친 무등회 요약");
  const patchesBefore = ghCalls.filter((c) => c.startsWith("PATCH")).length;
  raceNextPatch = true;
  await syncNow(B);
  const patches = ghCalls.filter((c) => c.startsWith("PATCH")).length - patchesBefore;
  check("동시 올리기 충돌 후 재시도 성공", patches === 2 && git.log.includes("외부 커밋") && headFiles()["README.md"] && JSON.parse(git.blobs.get(headFiles()[`lorekeeper/w/${await worldId(B)}.json`]).toString()).entries.find((e) => e.id === "F-001").summary === "B가 고친 무등회 요약", `patches=${patches}`);

  // ---- 6. 대화: 이어받기, 갈라진 대화, 삭제 ----
  const wid = await worldId(A);
  const meta = (t) => ({ id: "tdiv", title: "등대 이야기", createdAt: t, updatedAt: t, contextSent: true, syncedAt: t, lastCtx: 0, promptVersion: 5 });
  const conv = (msgs) => ({ api: msgs.map((m, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: m }] })), display: msgs.map((m, i) => (i % 2 ? { role: "assistant", parts: [{ kind: "text", text: m }], at: i } : { role: "user", text: m, at: i })) });
  const t0 = Date.now();
  await idbSet(A, "threads:" + wid, [...((await idbGet(A, "threads:" + wid)) || []), meta(t0)]);
  await idbSet(A, "conv:tdiv", conv(["질문1", "답1"]));
  let ts = await lastSync(A);
  await A.reload(); await waitSynced(A, ts);
  await syncNow(B);
  check("B가 대화를 이어받음", ((await idbGet(B, "threads:" + wid)) || []).some((t) => t.id === "tdiv") && (await idbGet(B, "conv:tdiv"))?.api.length === 2);
  // 두 기기에서 각각 다르게 이어감
  await idbSet(A, "threads:" + wid, ((await idbGet(A, "threads:" + wid)) || []).map((t) => (t.id === "tdiv" ? { ...t, updatedAt: Date.now() } : t)));
  await idbSet(A, "conv:tdiv", conv(["질문1", "답1", "A의 질문2", "A의 답2"]));
  ts = await lastSync(A);
  await A.reload(); await waitSynced(A, ts);
  await idbSet(B, "threads:" + wid, ((await idbGet(B, "threads:" + wid)) || []).map((t) => (t.id === "tdiv" ? { ...t, updatedAt: Date.now() } : t)));
  await idbSet(B, "conv:tdiv", conv(["질문1", "답1", "B의 질문2", "B의 답2"]));
  ts = await lastSync(B);
  await B.reload(); await waitSynced(B, ts);
  await syncNow(A);
  const ta = (await idbGet(A, "threads:" + wid)) || [];
  const copy = ta.find((t) => t.title.includes("사본"));
  check("갈라진 대화는 둘 다 남김", ta.some((t) => t.id === "tdiv") && !!copy, ta.map((t) => t.title).join(" | "));
  check("원래 대화는 먼저 올린 A 쪽", (await idbGet(A, "conv:tdiv")).api[2].content[0].text === "A의 질문2");
  check("사본은 B 쪽 내용", copy && (await idbGet(A, "conv:" + copy.id)).api[2].content[0].text === "B의 질문2");
  // B에서 사본 대화 삭제 → A에서도 사라짐
  await tab(B, "chat");
  await B.click("#threadsBtn");
  await B.click(`[data-del-thread="${copy.id}"]`);
  await B.click('#dialog [data-r="1"]');
  await closeSheet(B);
  await syncNow(B);
  await syncNow(A);
  check("지운 대화가 다른 기기에서도 사라짐", !((await idbGet(A, "threads:" + wid)) || []).some((t) => t.id === copy.id) && !(await idbGet(A, "conv:" + copy.id)));

  // ---- 7. 세계관 추가·삭제 ----
  await B.click("#worldBtn");
  await B.click('#sheetBody [data-act="new-world"]');
  await B.fill("#w-name", "두 번째 세계");
  await B.click('#worldForm button[type="submit"]');
  await syncNow(B);
  await syncNow(A);
  const wa = (await idbGet(A, "worlds")) || [];
  check("새 세계관이 A로", wa.some((w) => w.name === "두 번째 세계"));
  // A에서 삭제
  const second = wa.find((w) => w.name === "두 번째 세계");
  await A.click("#worldBtn");
  await A.click(`[data-world="${second.id}"]`);
  await A.click("#worldBtn");
  await A.click('#sheetBody [data-act="edit-world"]');
  await A.click('[data-act="delete-world"]');
  await A.click('#dialog [data-r="1"]');
  await A.waitForSelector("#sheet[hidden]", { state: "attached" });
  await syncNow(A);
  await syncNow(B);
  const wb = (await idbGet(B, "worlds")) || [];
  check("지운 세계관이 B에서도 사라짐", !wb.some((w) => w.name === "두 번째 세계") && wb.length === 1, wb.map((w) => w.name).join(","));
  check("저장소에서도 그 세계관 파일 삭제", !Object.keys(headFiles()).some((f) => f.includes(second.id)));

  // ---- 8. 연결 끊기 ----
  await tab(B, "settings");
  await B.click('[data-act="sync-off"]');
  await B.click('#dialog [data-r="1"]');
  check("연결 끊기: 토큰 삭제, 데이터 유지", !(await B.isVisible("#syncBtn")) && (await B.evaluate(() => JSON.parse(localStorage.getItem("lk.sync")).token)) === "" && (await entriesOf(B)).length >= 6);
  check("가로 넘침 없음", !(await A.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed · GitHub 요청 ${ghCalls.length}회 · 커밋 ${git.log.length}개`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
