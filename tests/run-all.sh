#!/usr/bin/env bash
# 모든 E2E 테스트와 지침 기준본 확인을 차례로 돌린다. 사용: bash tests/run-all.sh [suite...]
cd "$(dirname "$0")"
node -e 'require("./lib.cjs").sdk()' >/dev/null || exit 1
suites=("$@")
if [ ${#suites[@]} -eq 0 ]; then suites=(e2e*.cjs); fi
fail=0
for s in "${suites[@]}"; do
  out=$(timeout 600 node "$s" 2>&1); code=$?
  last=$(printf '%s\n' "$out" | grep -E '^(통과|SKIP|PASS|FAIL|[0-9]+/[0-9]+)' | tail -1)
  [ -z "$last" ] && last=$(printf '%s\n' "$out" | tail -1)
  if [ $code -ne 0 ]; then fail=1; printf '✗ %-22s %s\n' "$s" "$last"; printf '%s\n' "$out" | grep -E '✗|FAIL|Error' | head -20; else printf '✓ %-22s %s\n' "$s" "$last"; fi
done
node check-prompts.cjs | tail -3 || fail=1
exit $fail
