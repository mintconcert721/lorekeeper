// 테스트 공용: 경로, Anthropic SDK(브라우저용 묶음), 고정된 지침·도구 기준본, 예전 버전 index.html
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const TESTS = __dirname;
const ROOT = path.join(TESTS, "..");
const INDEX = path.join(ROOT, "index.html");
const SHOTS = process.env.LK_SHOTS || path.join(os.tmpdir(), "lorekeeper-shots");
fs.mkdirSync(SHOTS, { recursive: true });

// 앱은 SDK를 CDN에서 받는다. 테스트는 같은 버전을 esbuild로 묶어 CDN 주소에 대신 돌려준다.
function sdk() {
  const out = path.join(TESTS, ".cache", "sdk-esm.js");
  if (!fs.existsSync(out)) {
    const dir = path.join(TESTS, "sdk");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execSync("npm install --no-audit --no-fund --silent", { cwd: dir, stdio: "inherit" });
    execSync(`npx esbuild entry.mjs --bundle --format=esm --platform=browser --outfile="${out}" --log-level=warning`, { cwd: dir, stdio: "inherit" });
  }
  return fs.readFileSync(out, "utf8");
}

// 배포된 지침·도구 기준본. sets[n]은 PROMPT_SETS[n], legacy[n]은 PROMPT_SETS 이전(v1~v4)의 SYSTEM_PROMPT·TOOLS
let prompts = null;
const loadPrompts = () => (prompts ||= JSON.parse(fs.readFileSync(path.join(TESTS, "fixtures", "prompts.json"), "utf8")));
const PROMPT_SET = (n) => loadPrompts().sets[n];
const LEGACY = (n) => loadPrompts().legacy[n];

// 예전 배포본(업그레이드 테스트용)은 git 기록에서 꺼낸다
const oldHtml = (commit) => execSync(`git -C "${ROOT}" show ${commit}:index.html`, { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");

module.exports = { TESTS, ROOT, INDEX, SHOTS, sdk, PROMPT_SET, LEGACY, oldHtml };
