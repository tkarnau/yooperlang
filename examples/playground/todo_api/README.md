# todo_api - a CRUD JSON API on sqlite

A working HTTP service in Yooperlang: routing with captured path segments,
form-encoded input, JSON output, and a sqlite database underneath, with a bulk
import that is all-or-nothing.

It lives under `playground/` rather than `pass/` because it links libsqlite3,
which ships with the macOS SDK and needs `libsqlite3-dev` (or equivalent) on
Linux.

## Run it

```
yoopiler_boot examples/playground/todo_api/main.yoop -o todo_api
./todo_api
```

Then, from another terminal:

```
./examples/playground/todo_api/smoke.sh
```

The server recreates `todos.db` on every start, so repeated runs report the
same numbers. It listens on `127.0.0.1:18086` and logs one line per request.

## The routes

```
GET    /healthz         service status plus the row count
GET    /todos           list; ?done=true|false and ?limit=N
POST   /todos           create      (form: title, priority)
POST   /todos/import    bulk create (form: repeated title=, priority)
GET    /todos/:id       one todo
PUT    /todos/:id       replace     (form: title, done, priority)
DELETE /todos/:id       remove, 204 on success
```

Input is `application/x-www-form-urlencoded`, which is what `curl -d` sends and
what `std/http/url.yoop` parses. Output is JSON, encoded by `json.yoop`. There
is no JSON parser in the tree, and this example does not pretend there is.

## What each file is for

| File | Role |
| --- | --- |
| `store.yoop` | Every line of SQL. Knows nothing about HTTP. |
| `json.yoop` | JSON encoding into a byte buffer. |
| `main.yoop` | Glue: read a request, call the store, write a response. |

## The parts worth reading

**The transaction kind does the rollback.** `store.importMany` opens a
transaction as a *binding*:

```js
transaction tx: Tx = dbTx(sqlite.begin(ref db), "starting the import")?;
for title in titles {
    let _v: usize = validateTitle(title)?;     // <- an early return
    ...
}
let _c: int32 = dbInt(sqlite.commit(ref tx), "committing the import")?;
```

There is no `rollback` call anywhere in that function. The `?` in the middle of
the loop returns straight out, and the kind's disposer runs on the way past and
undoes every insert that already happened. Try it:

```
curl -X POST -d 'title=one&title=&title=three' localhost:18086/todos/import
curl localhost:18086/healthz      # the count is unchanged
```

**Errors carry their own status.** `StoreError` implements `Into<HttpError>`
and `WithContext<HttpError>`, so a handler writes

```js
let t: Todo = store.find(ref db, id)? `GET /todos/${id}`;
```

and a missing row arrives at the client as a 404 with context attached, without
a single conversion switch in the handler. A validation failure is a 400 and a
broken query is a 500 by the same route. The layer that knows *why* something
failed is the layer that picks the status.

**Handlers borrow the connection.** `Db` declares `propagates<disposable>`, so
a struct holding one is claiming ownership, and the compiler makes it say so.
These handlers do not own the connection - `main` does - so they hold a
`sqlite.DbRef` and call `sqlite.borrow` to use it.

**Route order matters.** `/todos/import` is registered before `/todos/:id`,
because routes match in registration order and `:id` would otherwise capture
`import`.

**Every response is JSON, including the ones the router writes.** The router's
404 and 405 go through the installed fallback handler with `resp.status` (and
the `Allow` header) already set, so `NoRouteHandler` only has to change the
body format.

## What it does not do

- No JSON request bodies (no parser).
- No auth, no pagination cursors, no ETags.
- One connection at a time: the accept loop does not spawn a task per
  connection, so a slow client blocks the next one.
- Strings built while parsing a request are never freed, so memory grows with
  the number of distinct header values a long-lived process has seen.
