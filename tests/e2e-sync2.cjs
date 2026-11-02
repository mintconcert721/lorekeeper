// 동기화 2차: 원고함·그림
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const SHOTS = L.SHOTS;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8773);

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
    await page.goto("http://localhost:8773/");
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
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const ctab = (page, k) => page.click(`#codex [data-ctab="${k}"]`);
  async function newMs(page, title, body, refs = "") {
    await tab(page, "codex");
    await ctab(page, "ms");
    await page.click('[data-act="ms-new"]');
    await page.fill("#m-title", title);
    await page.fill("#m-body", body);
    await page.fill("#m-refs", refs);
    await page.click('#msForm button[type="submit"]');
    await page.waitForSelector("#sheetBody .ms-body");
    await closeSheet(page);
    await ctab(page, "entries");
  }
  async function setImage(page, id) {
    await tab(page, "codex");
    await page.click(`.entry-card[data-ref="${id}"]`);
    await page.click('#sheetBody [data-act="edit"]');
    await page.setInputFiles("#f-img", { name: "x.png", mimeType: "image/png", buffer: PNG });
    await page.waitForSelector("#f-img-prev:not([hidden])");
    await page.click('#entryForm button[type="submit"]');
    await page.waitForSelector("#sheetBody .entry-img");
    await closeSheet(page);
  }
  const msOf = async (page) => (await idbGet(page, "ms:" + (await worldId(page)))) || [];
  const imgsOf = async (page) => (await idbGet(page, "imgs:" + (await worldId(page)))) || {};
  const remoteJson = (p) => { const sha = headFiles()[p]; return sha ? JSON.parse(git.blobs.get(sha).toString("utf8")) : null; };

  // ---- 1. A: 원고·그림 만들고 연결 ----
  const A = await device("A");
  await A.click("text=예시 세계관 둘러보기");
  await A.waitForSelector("#view-codex:not([hidden]) .entry-card");
  const wid = await worldId(A);
  await connect(A, "good-token", "A폰");
  check("원고 없는 세계관 파일은 예전 형식", !("ms" in remoteJson(`lorekeeper/w/${wid}.json`)) && !headFiles()[`lorekeeper/i/${wid}.json`]);
  await newMs(A, "첫 원고", "본문 하나", "서리");
  await setImage(A, "P-001");
  await syncNow(A);
  const rw = remoteJson(`lorekeeper/w/${wid}.json`);
  const ri = remoteJson(`lorekeeper/i/${wid}.json`);
  check("원격 세계관 파일에 원고", rw.ms?.length === 1 && rw.ms[0].title === "첫 원고");
  check("원격 그림 파일", ri?.["P-001"]?.data?.startsWith("data:image/jpeg"));

  // ---- 2. B: 받기 ----
  const B = await device("B");
  await connect(B, "good-token", "B패드");
  check("B가 원고를 받음", (await msOf(B)).map((m) => m.title).join() === "첫 원고");
  check("B가 그림을 받음", (await imgsOf(B))["P-001"]?.data?.startsWith("data:image/jpeg"));
  await tab(B, "codex");
  check("B 설정집 카드에 그림", !!(await B.$('.entry-card[data-ref="P-001"] .ecard-img')));
  await ctab(B, "ms");
  check("B 원고함 화면에 원고", (await B.textContent("#ctabResults")).includes("첫 원고"));
  await ctab(B, "entries");

  // ---- 3. 양쪽에서 원고 고치기·추가 ----
  await tab(B, "codex");
  await ctab(B, "ms");
  await B.click('#ctabResults .ms-card:has-text("첫 원고")');
  await B.click('#sheetBody [data-act="ms-edit"]');
  await B.fill("#m-body", "B가 고친 본문");
  await B.click('#msForm button[type="submit"]');
  await B.waitForSelector("#sheetBody .ms-body");
  await closeSheet(B);
  await ctab(B, "entries");
  await newMs(A, "A의 두 번째 원고", "둘째");
  await syncNow(B);
  await syncNow(A);
  await syncNow(B);
  const ma = await msOf(A);
  const mb = await msOf(B);
  const bodyOf = (list, t) => list.find((m) => m.title === t)?.body;
  check("A: 원고 2편 + B의 수정", ma.length === 2 && bodyOf(ma, "첫 원고") === "B가 고친 본문", ma.map((m) => `${m.title}:${m.body}`).join(" | "));
  check("B: 원고 2편", mb.length === 2 && bodyOf(mb, "A의 두 번째 원고") === "둘째");

  // ---- 4. 원고 삭제 전파 ----
  await tab(A, "codex");
  await ctab(A, "ms");
  await A.click('#ctabResults .ms-card:has-text("A의 두 번째 원고")');
  await A.click('#sheetBody [data-act="ms-delete"]');
  await A.click('#dialog [data-r="1"]');
  await A.waitForTimeout(200);
  await ctab(A, "entries");
  await syncNow(A);
  await syncNow(B);
  check("원고 삭제가 B에도", (await msOf(B)).map((m) => m.title).join() === "첫 원고");

  // ---- 5. 그림 빼기 전파 ----
  await tab(B, "codex");
  await B.click('.entry-card[data-ref="P-001"]');
  await B.click('#sheetBody [data-act="edit"]');
  await B.click('[data-act="img-clear"]');
  await B.click('#entryForm button[type="submit"]');
  await B.waitForSelector("#sheetBody .entry-name");
  await closeSheet(B);
  await syncNow(B);
  await syncNow(A);
  check("그림 빼기가 A에도", (await imgsOf(A))["P-001"]?.data === "");
  await tab(A, "codex");
  check("A 카드에서 그림 사라짐", !(await A.$('.entry-card[data-ref="P-001"] .ecard-img')));

  // ---- 6. 같은 번호 충돌: 옮겨진 항목의 그림·원고 refs도 따라간다 ----
  const idB = await newCharacter(B, "나래");
  const idA = await newCharacter(A, "가람");
  await setImage(A, idA);
  await newMs(A, "가람 이야기", "가람의 첫 장면", idA);
  await syncNow(B);
  await syncNow(A);
  const ea = await entriesOf(A);
  const garam = ea.find((e) => e.name === "가람");
  const imA = await imgsOf(A);
  const msA = (await msOf(A)).find((m) => m.title === "가람 이야기");
  check("충돌: 가람이 새 번호로", idA === idB && garam.id !== idA, `${idA} ${idB} → ${garam?.id}`);
  check("충돌: 그림이 새 번호로 옮겨감", imA[garam.id]?.data?.startsWith("data:image/jpeg") && !imA[idA]?.data, JSON.stringify(Object.fromEntries(Object.entries(imA).map(([k, v]) => [k, !!v.data]))));
  check("충돌: 원고 refs도 새 번호", msA.refs.join() === garam.id, msA.refs.join());
  await syncNow(B);
  const imB = await imgsOf(B);
  check("B: 나래는 그림 없음, 가람은 그림", !imB[idB]?.data && imB[garam.id]?.data?.startsWith("data:"));

  // ---- 6-2. 지도 동기화 ----
  const MAPF = path.join(L.TESTS, "files/map.png");
  const mapsOf = async (page) => (await idbGet(page, "maps:" + (await worldId(page)))) || [];
  await tab(A, "graph");
  await A.click('#graphModes [data-gmode="map"]');
  const [fcA] = await Promise.all([A.waitForEvent("filechooser"), A.click('#mapEmpty [data-map="upload"]')]);
  await fcA.setFiles(MAPF);
  await A.waitForSelector("#mapVp:not([hidden])");
  await A.click('[data-map="add"]');
  const vb = await A.$eval("#mapVp", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await A.mouse.click(vb.x + vb.w * 0.3, vb.y + vb.h * 0.3);
  await A.waitForSelector('#pinList [data-ref="P-001"]');
  await A.click('#pinList [data-ref="P-001"]');
  await A.waitForSelector('.map-pin[data-pin="P-001"]');
  await syncNow(A);
  const mA = (await mapsOf(A))[0];
  check("원격: 지도 정보는 세계관 파일, 그림은 따로", remoteJson(`lorekeeper/w/${wid}.json`).maps?.[0]?.pins?.length === 1 && remoteJson(`lorekeeper/m/${mA.img}.json`)?.data?.startsWith("data:image/jpeg"));
  await syncNow(B);
  const mB = await mapsOf(B);
  check("B가 지도·핀·그림을 받음", mB.length === 1 && mB[0].pins[0].ref === "P-001" && (await idbGet(B, "mapimg:" + mA.img))?.startsWith("data:image/jpeg"));
  await tab(B, "graph");
  await B.click('#graphModes [data-gmode="map"]');
  await B.waitForSelector('.map-pin[data-pin="P-001"]');
  check("B 지도 화면에 핀", (await B.$$(".map-pin")).length === 1);
  // B가 핀을 옮긴다 → A
  await B.click('.map-pin[data-pin="P-001"]');
  await B.click('#mapCard [data-map="move"]');
  const vb2 = await B.$eval("#mapVp", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await B.mouse.click(vb2.x + vb2.w * 0.7, vb2.y + vb2.h * 0.6);
  await B.waitForTimeout(300);
  await syncNow(B);
  await syncNow(A);
  const pA = (await mapsOf(A))[0].pins[0];
  check("B가 옮긴 핀이 A에", Math.abs(pA.x - 0.7) < 0.03 && Math.abs(pA.y - 0.6) < 0.03, JSON.stringify(pA));
  const commitsBefore = git.log.length;
  const blobsBefore = git.blobs.size;
  await syncNow(A);
  check("바뀐 것 없으면 올리지 않음", git.log.length === commitsBefore && git.blobs.size === blobsBefore);
  // A가 지도를 지운다 → B
  await tab(A, "graph");
  await A.click('#graphModes [data-gmode="map"]');
  await A.click('[data-map="manage"]');
  await A.click('[data-mm="delete"]');
  await A.click('#dialog [data-r="1"]');
  await A.waitForTimeout(300);
  await syncNow(A);
  await syncNow(B);
  check("지도 삭제가 B에도(그림까지)", (await mapsOf(B)).length === 0 && !(await idbGet(B, "mapimg:" + mA.img)) && !headFiles()[`lorekeeper/m/${mA.img}.json`]);
  // ---- 6-3. 무드보드 그림 동기화 ----
  await tab(A, "codex");
  await A.click('.entry-card[data-ref="C-001"]');
  await A.click('#sheetBody [data-etab="looks"]');
  await A.setInputFiles("#galFile", MAPF);
  await A.waitForSelector("#sheetBody .gal-item img[src^='data:image/jpeg']");
  await closeSheet(A);
  await syncNow(A);
  const gimg = (await entriesOf(A)).find((e) => e.id === "C-001").gallery[0].img;
  check("원격: 무드보드 그림 파일", remoteJson(`lorekeeper/m/${gimg}.json`)?.data?.startsWith("data:image/jpeg"));
  await syncNow(B);
  check("B가 무드보드 그림을 받음", (await idbGet(B, "mapimg:" + gimg))?.startsWith("data:image/jpeg") && (await entriesOf(B)).find((e) => e.id === "C-001").gallery.length === 1);
  await tab(B, "codex");
  await B.click('.entry-card[data-ref="C-001"]');
  await B.click('#sheetBody [data-etab="looks"]');
  await B.waitForSelector("#sheetBody .gal-item img[src^='data:image/jpeg']");
  await B.click("#sheetBody .gal-item");
  await B.click('#sheetBody [data-act="gal-del"]');
  await B.waitForSelector("#sheetBody .gallery");
  await closeSheet(B);
  await syncNow(B);
  await syncNow(A);
  check("무드보드 빼기가 A에도(그림 파일까지 정리)", (await entriesOf(A)).find((e) => e.id === "C-001").gallery === undefined && !(await idbGet(A, "mapimg:" + gimg)) && !headFiles()[`lorekeeper/m/${gimg}.json`]);
  await tab(A, "codex");
  await tab(B, "codex");

  // ---- 7. 다시 열어도 그대로 ----
  await A.reload();
  await A.waitForSelector("#app");
  await tab(A, "codex");
  check("다시 열기: 가람 카드에 그림", !!(await A.$(`.entry-card[data-ref="${garam.id}"] .ecard-img`)));
  check("가로 넘침 없음", !(await A.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 400));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed · GitHub 요청 ${ghCalls.length}회 · 커밋 ${git.log.length}개`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
