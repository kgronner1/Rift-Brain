# Player feedback -> the Player Feedback sheet (RJ 488, RJ 489)

Players send feedback from the game (`POST /v1/feedback`). The brain stores every entry in its `feedback` table, the
source of truth, and its forwarder (`src/feedback/forwarder.js`) copies new rows to the **Player Feedback** tab of the
Dev To-Do spreadsheet every 30 s, through a small Apps Script web app (`apps_script.gs`, this directory). A brain
without the two settings below forwards nothing; its rows wait in the database and go out once it has them.

Why a web app and not the Sheets API: the box faces the internet, and a service account on it could edit the whole
spreadsheet. The script can only append feedback rows and rewrite their Player cell, and only for a caller holding
the secret.

**This repo is public. Never commit the secrets or the web app URL** (the URL plus a leaked secret is write access to
the sheet).

## Deploy the script (Alex, about 5 minutes, once)

1. **Make one secret per environment**, in any terminal (the box has `openssl`; so does the Mac):

   ```
   openssl rand -hex 32
   openssl rand -hex 32
   ```

   The first is dev's, the second alpha's. Keep them in the terminal for the next steps; don't save them in a file.
2. **Create the script.** Open https://script.new while signed in as the sheet's owner. Name the project
   `RJ player feedback`. Replace everything in `Code.gs` with the whole of `ops/feedback/apps_script.gs`. Save.
3. **Script Properties.** Project Settings (the gear) > Script Properties > Add:
   - `RJ_SHEET_ID`: the Dev To-Do spreadsheet's id, the long part of its URL between `/d/` and `/edit` (the URL is in
     Wobble Planet's `CLAUDE.md`). It is kept out of this public repo.
   - `RJ_FEEDBACK_SECRET`: both secrets, comma-separated: `<dev secret>,<alpha secret>`.
4. **Check it.** Back in the editor, choose `checkSetup` in the function menu and Run. Authorise the Sheets scope when
   asked (Advanced > Go to RJ player feedback). The log should say 2 secrets, RJ_SHEET_ID set, the tab found, and
   `Missing headers: none`. It writes nothing.
5. **Deploy.** Deploy > New deployment > type **Web app**: Execute as **Me**, Who has access **Anyone**. Deploy and
   copy the Web app URL (`https://script.google.com/macros/s/.../exec`).

"Anyone" is needed because the brain has no Google account; the secret is what guards it. A request without it gets
`{"ok":false,"error":"denied"}` and touches nothing.

## Put the URL and secret on the box

The brain reads them from its `.env` at boot: `/opt/rj/<env>/brain/.env`. `provision_box.sh` writes that file only
when it is absent, so a later provision never overwrites what you add. Do dev first, check it, then alpha.

```
source ~/.config/rift-jumpers/deploy.env; ssh -i "$RJ_DEPLOY_PEM" "$RJ_DEPLOY_HOST"
```

Then on the box (the env, the URL and that env's secret filled in):

```
E=dev
URL='https://script.google.com/macros/s/.../exec'
SECRET='<dev secret>'
sed -i '/^FEEDBACK_SHEET_/d' /opt/rj/$E/brain/.env
printf 'FEEDBACK_SHEET_URL=%s\nFEEDBACK_SHEET_SECRET=%s\n' "$URL" "$SECRET" >> /opt/rj/$E/brain/.env
pm2 restart rift-brain-$E --update-env
grep '\[feedback\]' /opt/rj/$E/logs/brain.out.log | tail -n 3
```

- The restart is the brain alone: its game servers keep running and are adopted again (README, "A brain restart").
- The last line should read `[feedback] forwarding to the sheet every 30 s`. A `[feedback] ... feedback is not
  forwarded` line names what is wrong (half a pair, a URL that is not https, a secret that is not 64 hex characters);
  the brain still runs and keeps every entry, it just doesn't forward.
- The brain never logs the secret or the request body.

**Check it end to end** (from the Mac; dev's floor is 0, so build 1 passes):

```
curl -s https://api-dev.riftjumpers.space/v1/feedback -H 'Content-Type: application/json' -H 'X-RJ-Env: dev' -H 'X-RJ-Api: 1' -H 'X-RJ-Build: 1' -d "{\"id\":\"$(uuidgen | tr A-Z a-z)\",\"message\":\"=1+1 runbook check\",\"tags\":[\"bug\"]}"
```

It answers `{"result":"ok","data":{"id":...,"received_at":...}}`. Within 30 s a row appears in Player Feedback with
Feedback `=1+1 runbook check` shown as text (not `2`), Player `anonymous`, Env `dev`.

## Changing the script

Edit `apps_script.gs` here first (its tests are `test/feedback_apps_script.test.js`), merge, then paste it into the
project and **Deploy > Manage deployments > (the deployment) > Edit (pencil) > Version: New version > Deploy**. That
keeps the same URL, so the box needs nothing. "New deployment" would make a new URL.

## Rotating a secret

Make a new one, put it in `RJ_FEEDBACK_SECRET` in place of the old one (Script Properties take effect at once, no
redeploy), then update that env's `.env` as above. Rows that fail in between are kept and retried.

## What the forwarder does, and when it stops

- Every 30 s: up to 20 rows, oldest first. The sheet answers with the ids it holds; those rows are done. Anything else
  (no answer in 20 s, an HTTP error, Google's HTML error page, a wrong secret) backs off: 30 s, doubling, at most an
  hour, with one `[feedback] ... failed (...)` log line per batch. The `/v1` route never waits on any of it.
- `server.feedback_sheet_per_day` (remote config, default 1000) caps rows sent per environment per UTC day; past it,
  rows wait for the next day, and the log says so once. 0 sends nothing.
- An account deletion (RJ 473, `storage.anonymizeFeedbackForUser`) keeps the feedback and removes who sent it; rows
  already in the sheet get Player `deleted account`.
- Rows waiting: `SELECT sheet_state, COUNT(*) FROM feedback GROUP BY sheet_state;` (`sudo mysql rift_brain_<env>`).
