# 로어키퍼 테스트

앱(`index.html`)을 실제 브라우저(Playwright Chromium)에서 휴대폰 화면 크기로 띄워 기능을 확인합니다. Claude API와 GitHub는 가짜 응답으로 대신하므로 API 키나 토큰이 필요 없습니다.

## 준비
- Node.js 18 이상
- Playwright와 Chromium(`require("playwright")`가 되어야 합니다)
- 첫 실행 때 `tests/sdk`에서 앱과 같은 버전의 Anthropic SDK를 내려받아 브라우저용으로 묶습니다(`tests/.cache/sdk-esm.js`, 저장소에는 넣지 않음).

## 실행
```bash
bash tests/run-all.sh                 # 모든 테스트 + 지침 기준본 확인
bash tests/run-all.sh e2e-writing.cjs # 하나만
node tests/check-prompts.cjs          # 배포된 지침·도구(v1~)가 바뀌지 않았는지
```
화면 캡처는 `LK_SHOTS`(기본: 시스템 임시 폴더의 `lorekeeper-shots`)에 저장됩니다.

## 규칙
- 이미 배포된 프롬프트 버전(`PROMPT_SETS`의 지침과 도구)은 고치지 않습니다. 새 기능은 새 버전에 넣습니다.
- 새 버전을 배포한 뒤 `node tests/check-prompts.cjs --update`로 기준본(`fixtures/prompts.json`)에 추가합니다.
- `e2e-upgrade.cjs`는 예전 배포본을 git 기록에서 꺼내(`git show <커밋>:index.html`) 그때 저장한 데이터를 지금 버전이 그대로 읽는지 봅니다.
- `e2e-common.cjs`는 개인 템플릿 파일이 `tests/private/templates-user/`에 있을 때만 돕니다(저장소에는 넣지 않음).

## 파일
| 파일 | 내용 |
|---|---|
| `lib.cjs` | 경로, SDK 묶음, 지침 기준본, 예전 배포본 읽기 |
| `seed3.cjs` | 테스트용 세계관 데이터 |
| `files/`, `templates/` | 첨부·가져오기 테스트용 파일 |
| `e2e*.cjs` | 기능별 테스트 |
