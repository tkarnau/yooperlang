#!/usr/bin/env bash
# Exercise every route of todo_api, including the failure paths.
#
# Start the server first, in another terminal:
#
#   yoopiler examples/playground/todo_api/main.yoop -o todo_api && ./todo_api
#
# then run this. It prints one line per request: the status, then the body.

set -u
BASE="${1:-http://127.0.0.1:18086}"

call() {
  local label="$1"; shift
  printf '%-28s ' "$label"
  curl -s -o /tmp/todo_api_body -w '%{http_code}  ' "$@"
  head -c 200 /tmp/todo_api_body
  echo
}

echo "== reads =="
call "GET /healthz"            "$BASE/healthz"
call "GET /todos"              "$BASE/todos"
call "GET /todos?limit=2"      "$BASE/todos?limit=2"
call "GET /todos/1"            "$BASE/todos/1"

echo
echo "== writes =="
call "POST /todos"             -X POST -d 'title=fix the dock&priority=3' "$BASE/todos"
call "PUT /todos/1"            -X PUT  -d 'title=walked the dog&done=true' "$BASE/todos/1"
call "GET /todos?done=true"    "$BASE/todos?done=true"
call "DELETE /todos/3"         -X DELETE "$BASE/todos/3"

echo
echo "== bulk import in one transaction =="
call "POST /todos/import ok"   -X POST -d 'title=stack wood&title=patch the canoe' "$BASE/todos/import"
# The middle title is empty, so the whole import is refused and the rows that
# were already inserted are rolled back by the `transaction` binding's disposer.
call "POST /todos/import bad"  -X POST -d 'title=one&title=&title=three' "$BASE/todos/import"
call "GET /healthz (unchanged)" "$BASE/healthz"

echo
echo "== failure paths =="
call "GET /todos/9999"         "$BASE/todos/9999"
call "GET /todos/abc"          "$BASE/todos/abc"
call "DELETE /todos (405)"     -X DELETE "$BASE/todos"
call "POST json body (415)"    -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/todos"
call "POST empty body (400)"   -X POST -H 'Content-Type: application/x-www-form-urlencoded' "$BASE/todos"
call "GET /nope (404)"         "$BASE/nope"
call "HEAD /todos"             -I "$BASE/todos"

echo
echo "== keep-alive: two requests, one connection =="
curl -s -o /dev/null -w 'reused=%{num_connects} connections for 2 requests\n' \
  "$BASE/healthz" "$BASE/todos"
