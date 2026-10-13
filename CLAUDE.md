# Rift-Brain

The Node/Express + MariaDB backend for Rift Jumpers. It handles login and sessions, stats, accolades, leaderboards,
matchmaking, the admission queue, and the internal API that game servers report to.

- **Owners:** Kyler (this repo) and Alex. The Godot client and the dedicated game server live in Wobble Planet, beside
  this checkout at `../Wobble Planet`.
- **This repo is public.** Never commit secrets, `.env` files, keys, or player data (dumps included).

## Read first

- **`../Wobble Planet/.claude/skills/online-backend/SKILL.md`**: the map of the live stack, day-to-day commands, the
  workflow that works, and the rules that cost real time to learn. Read it before any change here.
- **`README.md`** covers the layout, migrations, API v1, matchmaking, the admission queue, the player-data rule and
  the drills.
- **`infra/README.md`** covers the box, provisioning, AWS stacks, the cutover, and every undo.
- **The contract** is spec section 4, in `~/.claude/projects/-Users-alex-Documents-GitHub-Wobble-Planet/spec-alpha-readiness-2026-10-02.md`.
  - It is **additive only**: never rename, retype or remove a field, code or route.
  - Changing it needs both Alex and Kyler.
  - The client must agree with it: `src/contract/codes.js` matches Wobble Planet's `Scripts/Net/HandshakeCodes.gd`, and
    `fixtures/join_token_v1.txt` is checked by both repos.

## Layout

- `src/app.js` is the startup. `src/config/env.js` loads settings from `.env`.
  - With `ENV` unset, the brain runs in legacy mode: no `/v1`, and today's defaults apply.
  - `src/config/remote.js` + `remoteSchema.js` read the published config document.
- `src/contract/` holds the response envelope and the error codes. `src/middleware/` holds the request id, client
  headers, auth, rate limit and errors.
- `src/routes/v1/` is the public API. `src/routes/internal/` is what game servers call; it runs on a second,
  127.0.0.1-only listener. `src/routes/legacy/` holds the old routes.
- `src/auth/` holds tokens and credentials. `src/admission/` is the login queue. `src/match/` holds lobbies, the
  registry, spawning, the per-protocol manifest and adoption. `src/storage/` has one file per table.
- `migrations/` (`npm run migrate`; it refuses `rift_brain`). `config/` holds the remote config sources.
  `ops/config/` publishes them. `ops/drills/` holds the release drills, the swarm and capacity. `ops/db/` holds the
  dev scrub. `infra/` holds CloudFormation, provisioning and Caddy.

## Verify before handing back

- **Tests:** `npm test`. The database tests run only when `RJ_TEST_DB` is set. Use a throwaway Docker
  `mariadb:10.11` container and remove it afterwards:
  `RJ_TEST_DB=mysql://root:<pw>@127.0.0.1:<port>/<name containing test>`.
- **Node version:** runtime code must run on the box's Node, currently **20**. Check a new dependency's `engines`
  field. Test with `docker run node:20` on a `git archive` copy, not the mounted checkout, whose `node_modules` that
  would replace.
- **Shell scripts:** run `shellcheck` on any you touch (the Docker image `koalaman/shellcheck:stable` works).
- **Cross-repo changes:** run Wobble Planet's `Tools/harness/stack_loop.sh` with `BRAIN_DIR` set to this checkout.
  It runs the whole stack end to end (Docker MariaDB, this brain, real game servers, clients).
- **Live changes:** use each script's plan or dry-run mode first. Never edit or run on the box by hand what a script
  does.

## Workflow

- **One branch per task** in a worktree: `git worktree add ../Rift-Brain-<ID> -b RJ-<ID> origin/main`. Never work in
  the main checkout.
- **Merge commits only, never squash.** Each milestone must be revertible on its own (spec 7a, tag
  `pre-alpha-infra`). Remove a worktree or branch only after its PR shows MERGED.
- **Deploy after merging,** from `main`: `bash infra/provision_box.sh --env dev|alpha --apply`. It restarts only that
  environment's brain, and running matches are re-adopted. Then check it live.
- **Tasks** live on the Rift Jumpers Dev To-Do sheet; refer to them by their ID (`RJ <id>`).
