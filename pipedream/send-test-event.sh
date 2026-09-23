#!/usr/bin/env bash
# Fire a simulated Sauce Labs RDC webhook at the deployed Pipedream endpoint.
#
#   ./send-test-event.sh                      # one real failure
#   ./send-test-event.sh rdc-infra.json       # an infra failure (should be skipped)
#   ./send-test-event.sh rdc-failed.json 3    # same failure 3x (dedupe check)
#
# If SAUCE_WEBHOOK_SECRET is exported, the request is signed the way Sauce Labs
# signs it, so the workflow's verification path gets exercised too.
set -euo pipefail

ENDPOINT="${PIPEDREAM_ENDPOINT:?set PIPEDREAM_ENDPOINT to the workflow trigger URL}"
FIXTURE="${1:-rdc-failed.json}"
TIMES="${2:-1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_FILE="$DIR/fixtures/$FIXTURE"

[[ -f "$PAYLOAD_FILE" ]] || { echo "No such fixture: $PAYLOAD_FILE" >&2; exit 1; }

for i in $(seq 1 "$TIMES"); do
  # Give each send a distinct job id and build, like separate real runs would have.
  PAYLOAD="$(node -e '
    const fs = require("fs");
    const job = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    job.id = require("crypto").randomBytes(16).toString("hex");
    job.build = `local-test-${process.argv[2]}`;
    job.modification_time = new Date().toISOString();
    process.stdout.write(JSON.stringify(job));
  ' "$PAYLOAD_FILE" "$i")"

  ARGS=(-s -S -X POST "$ENDPOINT" -H "Content-Type: application/json" -d "$PAYLOAD" -w $'\nHTTP %{http_code}\n')

  if [[ -n "${SAUCE_WEBHOOK_SECRET:-}" ]]; then
    SIG="$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SAUCE_WEBHOOK_SECRET" | sed 's/^.* //')"
    ARGS+=(-H "saucelabs-sign: $SIG")
    echo "→ send $i/$TIMES ($FIXTURE, signed)"
  else
    echo "→ send $i/$TIMES ($FIXTURE, unsigned — export SAUCE_WEBHOOK_SECRET to sign)"
  fi

  curl "${ARGS[@]}"
  sleep 2
done

echo
echo "Check the run in Pipedream, then your Linear team:"
echo "  https://pipedream.com/@saucelabs2/projects/proj_JPsgvpY/sauce-labs-failed-test-linear-issue-p_ZJCNgQv/inspect"
