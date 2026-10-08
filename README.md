# rift-brain

This is a node server endpoint that will control game lobbies and placement of players who connect to the server.

Players will ping this api, a receive either a port to connect to for the game or a wait code.

Game lobbies will contact the api for health checks and to update game status and player counts.

This api will create and destroy game instances as needed.

AUTOMATIC START UP:

Rift-Brain should automatically start on server bootup using pm2

To list and check active instances type "pm2 list".

ON NEW SERVER:

"pm2 stop rift-brain"
will stop an instance
"pm2 start rift-brain" 
will start it
"ps -ef" 
will show a full list of processes
"mysql -u USER -p"
type password then you're into db.
"use rift_brain"
tables are user and user_stats

allow scp uploads
chmod u+w /home/ec2-user

TO MANUALLY START SERVER:

node ./src/app.js

Must be done in Rift-Brain folder for .env reasons

## Layout (RJ 462)

```
src/app.js              bootstrap: env, database, lobby registry, listeners
src/config/env.js       every setting, from .env, validated at boot (see .env.example)
src/db.js               the MySQL pool
src/match/lobbies.js    game instances and the join queue (in process memory)
src/match/ports.js      which game port is free
src/match/process.js    spawning and killing game server processes
src/storage/            today's storage.js, split by table
src/routes/legacy/      today's routes, unchanged in path and shape; they go at cutover
src/migrate.js          schema migrations (see "Migrations")
src/config/remoteSchema.js  the remote config document's rules (RJ 463)
src/config/remote.js    the brain's copy of its remote config document, read every 30 s (RJ 465)
src/contract/           the /v1 envelope and the error code registry (RJ 465)
src/middleware/         /v1's request id, client-header gates, session auth, rate limits, errors (RJ 465)
src/auth/               tokens (sign/verify, the lobby key) and device credentials (RJ 465)
src/routes/v1/          API v1, every route but /v1/match/join (M4) and /v1/queue (M6) (RJ 465)
src/log.js              every log line, with tokens, credentials and passwords redacted (RJ 465)
fixtures/               join_token_v1.txt and its builder: the client's cross-language token test (RJ 465)
test/                   npm test (node --test); pure tests need no database
config/                 the remote config documents, one per environment (RJ 463)
ops/config/             validate.mjs, publish.sh, rollback.sh (RJ 463)
infra/                  CloudFormation, the box's provisioning, and their tests (RJ 463): infra/README.md
```

With `ENV` unset the brain behaves exactly as before RJ 462 (port 3000 on every interface, UDP 8080-8085,
the single server binary in /home/ec2-user), so the legacy box keeps its `.env` as it is. A new environment
(`ENV=dev|alpha|prod`) must spell out `PUBLIC_PORT`, `GAME_PORTS` and `SERVER_BINARY`, and binds 127.0.0.1.

`npm test` runs every test. Database tests run only when `RJ_TEST_DB` is set.

## Migrations

The schema is `migrations/NNNN_name.sql`, applied in order by `src/migrate.js` and recorded (with each file's
SHA-256) in `schema_migrations`. No new dependencies: it uses mysql2.

```
npm run migrate                  # apply what is pending
npm run migrate -- --baseline    # on a copy of rift_brain: mark 0001 applied without running it
npm run migrate -- --status      # list applied and pending, change nothing
```

- It reads `MYSQL_*` from `.env` and runs only with `ENV=dev|alpha|prod`. It refuses the legacy `rift_brain`
  database outright: the legacy brain still reads `users.access_token` until cutover.
- A fresh database is built from 0001. A database that already has tables needs `--baseline` first, and
  0001 is refused on it, so the baseline can never be replayed over real data.
- An applied migration's file must never change (the run stops); fix forward with a new number.
- `GET_LOCK` keeps two runs from overlapping. DDL is not transactional, so a migration that fails part way is
  not recorded; write each step to check before it acts (0002 does), so it can simply be run again.

| File | What |
|---|---|
| `0001_baseline.sql` | today's `rift_brain` schema, dumped from the box (not yet in git, see below) |
| `0002_hardening.sql` | `UNIQUE` on `users.username` and `users.email`; `user_credentials`; drops `users.access_token` |

**Making `0001_baseline.sql`** (once, by hand, on the box). Over SSH:

```
mysqldump -u <db user> -p --no-data --skip-comments --skip-add-drop-table --routines --triggers rift_brain \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' > ~/0001_baseline.sql
```

`--skip-add-drop-table` matters: a default dump starts each table with `DROP TABLE IF EXISTS`. The `sed` drops
today's row counters, so a fresh database starts its ids at 1. Then, on the Mac, from this checkout:

```
scp -i <pem> ec2-user@<host>:~/0001_baseline.sql migrations/0001_baseline.sql
grep -c '^CREATE TABLE' migrations/0001_baseline.sql     # users, user_stats, user_accolades, ... (5 or more)
grep -nE 'DROP TABLE|INSERT INTO' migrations/0001_baseline.sql   # nothing
```

Commit it as it is: migrate records its checksum, and an edit after the first run stops every later run.

**Tests.** `npm test` runs the pure tests. The database tests (`test/migrate.db.test.js`) run when
`RJ_TEST_DB=mysql://user:pass@127.0.0.1:3306/rj_migrate_test` names a disposable database (the name must contain
`test`; every test drops and recreates it). They build from a miniature 0001, and from the real one once it exists.

## API v1 (RJ 465)

A new environment (`ENV=dev|alpha|prod`) serves `/v1` on its public listener beside today's routes; the legacy
brain (`ENV` unset) does not, and is otherwise unchanged. The contract is the alpha-readiness spec, section 4:
any change to it needs Alex and Kyler.

- **Every response is an envelope** (`src/contract/envelope.js`): `{result:"ok",data}`, `{result:"error",error}` or
  `{result:"queued",queued}`. A route raises `fail('VALIDATION', { message })`; `src/contract/codes.js` fills the
  retry, scope, action and status, and config `messages.<CODE>` overrides the text. Every response carries
  `X-RJ-Ref`, the same `ref` as the error body and the request's `[v1]` log line.
- **In order**, for every `/v1` request: the ref; the client-header gates of spec 4.9 (`ENV_MISMATCH`,
  `API_UNSUPPORTED`, `UPDATE_REQUIRED` app then multiplayer, `MAINTENANCE`), before the body is read; the body
  (64 KB); then the route, whose locked ones check `Authorization: Bearer <session>` (`AUTH_REQUIRED`,
  `AUTH_EXPIRED`) and their rate limits.
- **The gates and the limits come from the remote config document** at `CONFIG_URL` (`src/config/remote.js`):
  fetched at boot and every 30 s, read field by field (a bad field keeps its last value), refused whole for another
  `env`, an older `serial` or another `schema`. If CloudFront is unreachable the brain keeps its last copy; until the
  first fetch, the compiled defaults (open gates, spec 4.5's limits).
- **Sign-in.** `POST /v1/accounts` and a password login at `POST /v1/session` issue a device credential (32 random
  bytes; the database keeps only its SHA-256 in `user_credentials`) and a one-hour session token. A credential restore
  at `/v1/session` issues a session. Revoke a device with `UPDATE user_credentials SET revoked_at = NOW() WHERE id = ?`.
- **Tokens** (`src/auth/tokens.js`): `base64url(payload).base64url(HMAC-SHA256(key bytes, payload part))`, no
  padding, times in seconds. `SESSION_KEY` signs sessions; a dev token is invalid in alpha.
- **Rate limits** (`server.rate_limits` in config, per minute, in memory): password logins per IP and per account,
  account creation per IP and per username/email, credential restores per credential. Over a limit: `RATE_LIMITED`
  with `retry: after` and `Retry-After`.
- **Logs** go through `src/log.js`, which redacts any value under a key naming a password, token, credential,
  authorization, grant or session, and anything shaped like one of our tokens. Request bodies are never logged.
- **`fixtures/join_token_v1.txt`** is the client's cross-language test (Wobble Planet copies it to
  `Tools/harness/fixtures/`). `node fixtures/build_join_token_v1.js --write` rebuilds it; `npm test` fails if it drifts.

**Tests.** `npm test` runs the contract tests (`test/contract.test.js` pins the registry to spec 4.3 and the
envelope's shapes; `test/v1_http.test.js` the gates' order and the middleware's), tokens, log redaction and the SQL
key filters with no database. `test/v1.db.test.js` drives every route against a database built from `migrations/`
when `RJ_TEST_DB` is set, e.g. with a throwaway MariaDB 10.11:

```
docker run -d --name rb-test-db -e MARIADB_ROOT_PASSWORD=pw -p 127.0.0.1:33306:3306 mariadb:10.11
RJ_TEST_DB=mysql://root:pw@127.0.0.1:33306/rj_migrate_test npm test
docker rm -f rb-test-db
```

The box runs Node 16: runtime code uses no global `fetch` (the config fetcher is `https.get`). Tests may use newer
Node.

