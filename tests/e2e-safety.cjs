// 데이터 안전: 이 기기 저장소가 비워져도 원격을 지우지 않는다 + 기록에서 되살리기 + 저장소 점검
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8791);

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
  if (method === "GET" && (m = p.match(/^\/git\/commits\/(\w+)$/))) { const c = git.commits.get(m[1]); return json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message, committer: { date: new Date(Date.now() - (git.commits.size - [...git.commits.keys()].indexOf(m[1])) * 60000).toISOString() } }); }
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
    await page.goto("http://localhost:8791/");
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
  const wipeIdb = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase("lorekeeper"); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  const remoteJson = (p) => { const sha = headFiles()[p]; return sha ? JSON.parse(git.blobs.get(sha).toString("utf8")) : null; };

  // ---- 1. A: 예시 세계관 + 항목 하나 + 동기화 ----
  const A = await device("A");
  await A.click("text=예시 세계관 둘러보기");
  await A.waitForSelector("#view-codex:not([hidden]) .entry-card");
  await connect(A, "good-token", "A폰");
  const idX = await newCharacter(A, "지켜야 할 인물");
  await syncNow(A);
  const wid = await worldId(A);
  check("원격에 데이터", remoteJson(`lorekeeper/w/${wid}.json`)?.entries?.length === 5 && remoteJson("lorekeeper/index.json").worlds.length === 1);
  const commitsBefore = git.log.length;

  // ---- 2. A의 IndexedDB만 비워짐(브라우저가 저장 공간을 정리한 경우), localStorage(동기화 설정)는 남음 ----
  await A.evaluate(() => localStorage.setItem("lk.syncKeep", "1"));
  await wipeIdb(A);
  await A.reload();
  await A.waitForSelector("#app");
  await A.waitForFunction(() => !document.querySelector("#syncBtn").classList.contains("running") && (JSON.parse(localStorage.getItem("lk.sync") || "{}").lastSyncAt || 0) > 0, null, { timeout: 20000 });
  await A.waitForTimeout(800);
  check("원격 데이터가 지워지지 않음", remoteJson(`lorekeeper/w/${wid}.json`)?.entries?.length === 5 && remoteJson("lorekeeper/index.json")?.worlds?.length === 1, JSON.stringify({ idx: remoteJson("lorekeeper/index.json")?.worlds?.length, w: remoteJson(`lorekeeper/w/${wid}.json`)?.entries?.length }));
  check("A가 원격에서 되찾음", (await entriesOf(A)).some((e) => e.id === idX) && (await A.textContent("#worldName")).includes("안개바다"));
  check("빈 상태를 올리는 커밋이 없음", git.log.slice(commitsBefore).every((m) => !/동기화/.test(m)) || remoteJson(`lorekeeper/w/${wid}.json`)?.entries?.length === 5);

  // ---- 3. 원격이 비워진 기록(예전 버그) → 새 기기에서 '기록에서 되살리기' ----
  const keepRoot = Object.fromEntries(Object.entries(headFiles()).filter(([p]) => !p.startsWith("lorekeeper/")));
  const emptyIndex = putBlob(Buffer.from(JSON.stringify({ app: "lorekeeper-sync", version: 1, worlds: [], tombstones: { worlds: {}, threads: {}, entries: {} } })));
  git.ref = putCommit(putTree({ ...keepRoot, "lorekeeper/index.json": emptyIndex }), [git.ref], "로어키퍼 동기화 · 예전 버그");
  git.log.push("로어키퍼 동기화 · 예전 버그");
  const C = await device("C");
  await connect(C, "good-token", "C패드");
  check("빈 원격만 받으면 세계관 없음", ((await idbGet(C, "worlds")) || []).length === 0);
  await tab(C, "settings");
  await C.click('[data-act="sync-history"]');
  await C.waitForSelector("#sheetBody .hist-item");
  const hist = await C.$$eval("#sheetBody .hist-item", (els) => els.map((x) => x.textContent));
  check("동기화 기록 목록(가장 최근이 빈 기록)", hist.length >= 3 && hist[0].includes("세계관 0") && hist[1].includes("세계관 1"), hist.slice(0, 3).join(" / "));
  await C.click("#sheetBody .hist-item[data-hist=\"1\"]");
  await C.waitForSelector("#histOut .hist-detail");
  check("기록 살펴보기", (await C.textContent("#histOut")).includes("안개바다") && (await C.textContent("#histOut")).includes("항목 5"));
  const [dl] = await Promise.all([C.waitForEvent("download"), C.click('[data-hact="download"]')]);
  const snap = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  check("기록을 백업 파일로", snap.app === "lorekeeper" && snap.worlds[0].entries.length === 5 && Object.values(snap.worlds[0].convs || {}).length >= 0);
  await C.click('[data-hact="restore"]');
  await C.click('#dialog [data-r="1"]');
  await C.waitForFunction(() => document.querySelector("#worldName")?.textContent.includes("안개바다"), null, { timeout: 15000 });
  await waitSynced(C, 0);
  await C.waitForTimeout(1500);
  check("되살리기 → 이 기기에", (await entriesOf(C)).length === 5);
  await syncNow(C);
  check("되살린 데이터가 원격에도", remoteJson("lorekeeper/index.json").worlds.length === 1 && remoteJson(`lorekeeper/w/${wid}.json`).entries.length === 5);

  // ---- 4. 세계관 목록에서 빠진 데이터 → 저장소 점검으로 되살리기 ----
  const D = await device("D");
  await D.click("text=예시 세계관 둘러보기");
  await D.waitForSelector("#view-codex:not([hidden]) .entry-card");
  const dWid = await worldId(D);
  await idbSet(D, "worlds", []);
  await D.reload();
  await D.waitForSelector("#app");
  await D.waitForSelector("#dataBanner:not([hidden])");
  check("목록에서 빠진 데이터 알림", (await D.textContent("#dataBanner")).includes("항목 4개"));
  await D.click('#dataBanner [data-banner="check"]');
  await D.waitForSelector("#sheetBody .orphan");
  check("저장소 점검: 남은 데이터 보임", (await D.textContent("#sheetBody .orphan")).includes("항목 4") && (await D.textContent("#sheetBody .orphan")).includes("서리"));
  await D.click('#sheetBody [data-sc="adopt"]');
  await D.waitForSelector("#view-codex:not([hidden]) .entry-card");
  const dw = (await idbGet(D, "worlds")) || [];
  check("되살린 세계관", dw.length === 1 && dw[0].id === dWid && dw[0].name.startsWith("되살린 세계관") && (await D.$$("#codex .entry-card")).length === 4 && (dw[0].counters.C || 0) >= 1);

  // ---- 5. 대화 기록이 망가져도 데이터는 보이고 알림 ----
  const tid = (await idbGet(D, "threads:" + dWid))?.[0]?.id;
  const convKey = tid ? "conv:" + tid : null;
  if (convKey) {
    await idbSet(D, convKey, { api: [], display: [{ role: "assistant", parts: null }] });
    await D.evaluate((t) => localStorage.setItem("lk.thread", JSON.stringify(t)), tid);
  } else {
    await idbSet(D, "threads:" + dWid, [{ id: "bad", title: "망가진 대화", createdAt: 1, updatedAt: 1, contextSent: true, syncedAt: 0, lastCtx: 0, promptVersion: 9 }]);
    await idbSet(D, "conv:bad", { api: [], display: [{ role: "assistant", parts: null }] });
    await D.evaluate(() => localStorage.setItem("lk.thread", JSON.stringify("bad")));
  }
  const errCount = errors.length;
  await D.reload();
  await D.waitForSelector("#app");
  await D.waitForTimeout(800);
  const bannerText = (await D.isVisible("#dataBanner")) ? await D.textContent("#dataBanner") : "";
  check("망가진 대화: 알림 + 설정집은 보임", bannerText.includes("화면을 여는 중 오류") && (await D.textContent("#worldName")).includes("되살린") && (await D.$$eval("#codex .entry-card", (els) => els.length)) === 4, bannerText);
  errors.splice(errCount); // 일부러 낸 오류는 빼고 센다

  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed · 커밋 ${git.log.length}개`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
