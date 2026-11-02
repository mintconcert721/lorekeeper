// 짧은 요청을 Haiku 5.5로: 기본 켜짐, 규칙 판정은 대화 모델, Haiku 거절 시 대화 모델로 다시, 끄면 대화 모델
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const L = require("./lib.cjs");
const SCRATCH = L.TESTS;
const SDK = L.sdk();
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(L.INDEX)); }).listen(8792);
const quickReqs = [];
const replies = []; // { text, refusal }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: SDK }));
  await page.route("https://fonts.**", (r) => r.abort());
  await page.route("https://api.anthropic.com/**", (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData());
    quickReqs.push({ body, beta: req.headers()["anthropic-beta"] || "" });
    const r = replies.shift() || { text: "" };
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ id: "q", type: "message", role: "assistant", model: body.model, content: r.refusal ? [] : [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: r.text }], stop_reason: r.refusal ? "refusal" : "end_turn", stop_details: r.refusal ? { type: "refusal", category: "cyber" } : null, usage: { input_tokens: 1000000, output_tokens: 100000 } }) });
  });
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const tab = (v) => page.click(`.tabbar [data-view="${v}"]`);
  const cost = () => page.evaluate(() => JSON.parse(localStorage.getItem("lk.cost") || "{}").total || 0);

  await page.goto("http://localhost:8792/");
  await page.click("text=예시 세계관 둘러보기");
  await page.waitForSelector("#codex .entry-card");
  await tab("settings");
  await page.fill("#apiKey", "sk-ant-test");
  await page.click('#keyForm button[type="submit"]');
  await page.waitForSelector("#quickHaiku");
  check("설정: 기본 켜짐 + 안내", (await page.isChecked("#quickHaiku")) && (await page.textContent("#settings")).includes("판례로 남는 규칙 판정, 원고 부분 다듬기, 대화는 위에서 고른 모델"));

  // 1) 이름 규칙 만들고 이름 만들기 → Haiku
  await tab("codex");
  await page.click('#codex [data-ctab="naming"]');
  await page.click('[data-act="naming-new"]');
  await page.fill("#n-name", "섬사람");
  await page.fill("#n-rules", "두 음절");
  await page.click('#namingForm button[type="submit"]');
  await page.waitForTimeout(200);
  replies.push({ text: "나래 | 바람" });
  const c0 = await cost();
  await page.click("[data-naming-gen]");
  await page.click('#genForm button[type="submit"]');
  await page.waitForSelector("#genResults .gen-item");
  let q = quickReqs.at(-1);
  check("이름 만들기 → Haiku 5.5, 대체 모델 설정 없음", q.body.model === "claude-haiku-5-5" && q.body.fallbacks === undefined && !q.beta.includes("server-side-fallback") && q.body.output_config.effort === "low");
  const dc = (await cost()) - c0;
  check("비용: Haiku 단가(10만 토큰 넘는 요청은 높은 단가)", Math.abs(dc - (1e6 * 0.5 + 1e5 * 2.5) / 1e6) < 1e-9, String(dc));
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });

  // 2) Haiku가 거절 → 대화 모델(Opus)로 다시
  await page.click('#codex [data-ctab="questions"]');
  replies.push({ refusal: true }, { text: "음식 | 등대지기는 무엇을 먹나요?" });
  const n0 = quickReqs.length;
  await page.click('[data-act="q-custom"]');
  await page.waitForFunction(() => document.querySelector("#ctabResults")?.textContent.includes("등대지기는 무엇을"), null, { timeout: 10000 });
  const two = quickReqs.slice(n0);
  check("Haiku 거절 → Opus로 한 번 더", two.length === 2 && two[0].body.model === "claude-haiku-5-5" && two[1].body.model === "claude-opus-5-5" && two[1].body.fallbacks === "default" && two[1].beta.includes("server-side-fallback-2026-07-01"), two.map((x) => x.body.model).join(","));

  // 3) 규칙 판정은 대화 모델
  await tab("codex");
  await page.click('#codex [data-ctab="entries"]');
  await page.click('.entry-card[data-ref="K-001"]');
  await page.click('#sheetBody [data-act="magic-on"]');
  await page.waitForSelector('#sheetBody [data-etab="ruling"]');
  await page.click('#sheetBody [data-etab="ruling"]');
  await page.fill("#ruSituation", "기억 없이 불을 켤 수 있나?");
  replies.push({ text: JSON.stringify({ verdict: "불가능", reason: "대가가 필요", cost: "", conditions: "", consequence: "" }) });
  await page.click('#sheetBody [data-act="ruling-ask"]');
  await page.waitForSelector("#ruOut .ruling");
  check("규칙 판정 → 대화 모델(Opus)", quickReqs.at(-1).body.model === "claude-opus-5-5");
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });

  // 4) 끄면 짧은 요청도 대화 모델
  await tab("settings");
  await page.uncheck("#quickHaiku");
  await page.waitForTimeout(150);
  check("끄기 저장", (await page.evaluate(() => JSON.parse(localStorage.getItem("lk.settings")).quickHaiku)) === false);
  await tab("codex");
  await page.click('#codex [data-ctab="naming"]');
  replies.push({ text: "가람 | 강" });
  await page.click("[data-naming-gen]");
  await page.click('#genForm button[type="submit"]');
  await page.waitForSelector("#genResults .gen-item");
  check("끈 뒤 이름 만들기 → Opus", quickReqs.at(-1).body.model === "claude-opus-5-5");
  await page.click("[data-close-sheet]", { position: { x: 20, y: 20 } });

  // 5) 대화 모델이 Haiku면 그대로 Haiku
  await tab("settings");
  await page.check("#quickHaiku");
  await page.click('input[name="model"][value="claude-haiku-5-5"]', { force: true });
  await page.waitForTimeout(150);
  await tab("codex");
  await page.click('#codex [data-ctab="questions"]');
  replies.push({ refusal: true });
  const n1 = quickReqs.length;
  await page.click('[data-act="q-custom"]');
  await page.waitForTimeout(800);
  check("대화 모델도 Haiku면 거절 시 다시 묻지 않음", quickReqs.length - n1 === 1 && (await page.textContent("#toast")).includes("안전 정책"));
  check("콘솔 오류 없음", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
