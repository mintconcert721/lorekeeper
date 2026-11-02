// 배포된 지침·도구가 바뀌지 않았는지 확인한다.
//   node tests/check-prompts.cjs           : 기준본(fixtures/prompts.json)의 모든 버전이 지금 index.html과 같은지
//   node tests/check-prompts.cjs --update  : 새 버전을 배포한 뒤 기준본에 지금 PROMPT_SETS를 저장(이미 있는 버전은 바꾸지 않음)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const L = require("./lib.cjs");

const html = fs.readFileSync(L.INDEX, "utf8");
const start = html.indexOf("const TYPES = {");
const end = html.indexOf("\nconst TOOL_STATUS");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(start, end) + "\n;globalThis.__out = { sets: PROMPT_SETS, current: PROMPT_CURRENT };", ctx);
const now = JSON.parse(JSON.stringify(ctx.__out.sets));
const file = path.join(L.TESTS, "fixtures", "prompts.json");
const base = JSON.parse(fs.readFileSync(file, "utf8"));

let bad = 0;
for (const n of Object.keys(base.sets)) {
  const same = JSON.stringify(base.sets[n]) === JSON.stringify(now[n]);
  if (!same) bad++;
  console.log(`v${n}: ${same ? "그대로" : "바뀜!"}`);
}
const fresh = Object.keys(now).filter((n) => !(n in base.sets));
if (fresh.length) console.log(`기준본에 없는 새 버전: ${fresh.map((n) => "v" + n).join(", ")} (현재 ${ctx.__out.current})`);
if (process.argv.includes("--update")) {
  if (bad) { console.log("이미 배포된 버전이 바뀌어 기준본을 갱신하지 않습니다."); process.exit(1); }
  for (const n of fresh) base.sets[n] = now[n];
  fs.writeFileSync(file, JSON.stringify(base));
  console.log(`기준본 갱신: ${fresh.length ? fresh.map((n) => "v" + n).join(", ") : "추가 없음"}`);
}
process.exit(bad ? 1 : 0);
