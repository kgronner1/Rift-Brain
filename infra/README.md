# Infrastructure (RJ 463, alpha-readiness M1)

Everything outside the brain's code: the AWS edge for `config.riftjumpers.space`, the box's security group and
DNS records, the box's provisioning, and the remote config documents. The spec is
`spec-alpha-readiness-2026-10-02.md` (Alex's `~/.claude/projects/...`), sections 4.5, 5 and M1.

```
infra/stacks.env            fixed, public settings (domain, stack names, regions, AWS profile "rj")
infra/cfn/rj-edge.yaml      us-east-1: ACM certificate, S3 bucket (private, versioned), CloudFront + OAC, alias records
infra/cfn/rj-box.yaml       us-west-1: security group rj-public, A records api / api-dev / play
infra/deploy_stacks.sh      plan (default) | --changeset | --apply; then attaches rj-public to the box
infra/provision_box.sh      the Mac side: copies infra/box/ to the box and runs it over SSH
infra/box/provision.sh      the box side: Caddy, /opt/rj/<env>, .env, database, pm2 (plan by default)
infra/box/*.caddy*, caddy.service   Caddy's config and unit, as provision.sh installs them
infra/test/caddy_envelope.sh        Docker: the Caddy config validates; brain down -> 503 NET_UNREACHABLE envelope
infra/test/provision_db.sh          Docker: provision.sh's .env + database steps against MariaDB 10.11
infra/test/provision_node.sh        Docker: provision.sh's Node 20 steps on the box's own AL2023 release (RJ 477)
config/<env>.client.v1.json the remote config sources (changes go through PRs)
ops/config/validate.mjs     checks a document: types, clamps, env (src/config/remoteSchema.js)
ops/config/publish.sh       validate, client parser, lock guard, serial, upload, invalidate, fetch back
ops/config/rollback.sh      republish an earlier S3 version under a new serial
```

Machine-specific values live in `~/.config/rift-jumpers/deploy.env`, never in git (the repository is public):

```
RJ_DEPLOY_PEM=...            the box's SSH key
RJ_DEPLOY_HOST=ec2-user@...  the box
RJ_SSH_CIDRS="a.b.c.d/32"    1-3 CIDRs rj-public lets SSH in (required by deploy_stacks.sh)
# RJ_INSTANCE_ID=i-...       optional; otherwise found by RJ_DEPLOY_HOST's IP
```

The `rj` AWS profile (IAM user `rj-deploy`) is enough for all of it: CloudFormation, S3, CloudFront, ACM and
Route 53, plus `ec2:Describe*`, the security-group calls, `CreateTags` and `ModifyInstanceAttribute`.
CloudFormation runs as that user (no service role).

## The dev stand-up, in order

Each step is safe to re-run, and each has a mode that changes nothing; run that first.

| # | Command | Changes | Undo |
|---|---|---|---|
| 0 | `bash infra/deploy_stacks.sh` | nothing (plan: validates, looks every parameter up, prints what --apply does) | -- |
| 1 | `bash infra/deploy_stacks.sh --apply --edge-only` | us-east-1 stack `rj-edge`: certificate for config.riftjumpers.space (+ its validation CNAME), bucket `rj-config-<account>`, CloudFront distribution, OAC, cache policy, A/AAAA alias `config` | "Undo", step 1 |
| 2 | `bash infra/deploy_stacks.sh --apply --box-only` | us-west-1 stack `rj-box`: security group `rj-public`; A records `api`, `api-dev`, `play` -> the box's current IP; then adds rj-public to the instance beside launch-wizard-2 | "Undo", step 2 |
| 3 | `bash ops/config/publish.sh dev --skip-client-check --dry-run` | nothing (prints the document, serial and commands) | -- |
| 4 | `bash ops/config/publish.sh dev --skip-client-check` | uploads `dev/client.v1.json` (serial 1), invalidates it, fetches it back from https://config.riftjumpers.space/dev/client.v1.json | publish again, or "Undo", step 1 |
| 5 | `bash infra/provision_box.sh --env dev` | nothing on the box (plan: preflight checks, what --apply would do). Copies the script to `~/rj-provision/` | -- |
| 6 | `bash infra/provision_box.sh --env dev --apply` | the box: Caddy (binary, `caddy` user, unit, `/etc/caddy`), `/opt/rj/dev/`, its `.env` (fresh keys), database `rift_brain_dev` (a copy of `rift_brain`, baselined + 0002) and its user, pm2 app `rift-brain-dev`, `pm2 save` | "Undo", step 3 |

Steps 1 and 2 can run together (`--apply` alone does both). `--changeset` instead of `--apply` shows the change
sets without executing them. Step 1 takes 5-20 minutes (the certificate's DNS validation, then CloudFront).
`--skip-client-check` is needed until M2 lands Wobble Planet's `Tools/harness/check_remote_config.gd`; after
that, drop it. Step 6 needs the commit it runs pushed to GitHub (the box clones from there), and DNS from step 2
(Caddy fetches api-dev's certificate on first start).

After step 6: https://api-dev.riftjumpers.space/ is the dev brain (today's legacy routes, on the copy), and
with the brain stopped it answers 503 with the `NET_UNREACHABLE` envelope. Dev multiplayer starts with M4 (RJ 466):
the brain then matches through `/v1/match/join` and runs the binaries `/opt/rj/dev/servers/manifest.json` names, which
Wobble Planet's `deploy_server.sh --env dev` uploads (the root README, "Matchmaking"). A re-run of step 6 at an M4
commit appends to an older `.env` only the M4 settings it lacks, and reports what the manifest deploys.

## The alpha stand-up, in order (RJ 469, spec M7)

Alpha sits beside dev on the same box and Caddy: `api.riftjumpers.space` -> `127.0.0.1:3002` (internal 3102),
`/opt/rj/alpha/`, its own `.env` and keys, `rift_brain_alpha` **built fresh from migrations** (no player data, ever
copied in) with its own user, pm2 `rift-brain-alpha` (`treekill: false`), UDP 8090-8099. The edge stacks, the DNS
record `api` and the security group's 8090-8099 already exist from the dev stand-up. This is **not** the cutover
(spec 7): no build points at alpha until one is made to, and the legacy brain is untouched.

| # | Command | Changes | Undo |
|---|---|---|---|
| 0 | (recommended, Alex) resize the box to a t3.small | 2 GB instead of 949 MB (spec 5). A stop/start changes the public IP: re-run `bash infra/deploy_stacks.sh --apply --box-only` after | resize back |
| 1 | `bash ops/config/publish.sh alpha --dry-run` | nothing (every check, the client's parser, the document, the commands) | -- |
| 2 | `bash ops/config/publish.sh alpha` | uploads `alpha/client.v1.json` (serial 1); https://config.riftjumpers.space/alpha/client.v1.json | "Undo", step 4 |
| 3 | `bash infra/provision_box.sh --env alpha` | nothing on the box (plan: preflight, memory, what --apply would do) | -- |
| 4 | `bash infra/provision_box.sh --env alpha --apply` | the box: `/etc/caddy/sites/alpha.caddy` (+ reload), `/opt/rj/alpha/`, its `.env` (fresh keys), `rift_brain_alpha` (0001 + 0002, empty) and its user, pm2 `rift-brain-alpha`, `pm2 save` | "Undo", step 4 |
| 5 | in Wobble Planet, on a clean `main`: `bash deploy_server.sh --env alpha` | `/opt/rj/alpha/servers/wire-<N>-<fp>/` and `manifest.json` | `deploy_server.sh --env alpha --withdraw <N>`, or "Undo", step 4 |

Step 2 before step 4: the brain reads its document from boot (without one it runs on the compiled defaults, which
are open). Step 4 runs this checkout's HEAD, which must be on GitHub (`--ref <commit>` names another). The preflight
warns, and does not stop, when under 250 MB of memory is available: on a t2.micro beside dev and the legacy brain it
will. Until step 5 every `/v1/match/join` on alpha answers `SERVER_BEHIND`.

## Node 20 (RJ 477)

Dev and alpha run on `/usr/bin/node-20`, from AL2023's `nodejs20` (20.12.2 at the box's pinned release,
2023.5.20240819); the legacy `rift-brain` stays on the system Node 16, which is also what pm2 runs on. Each
environment's ecosystem file names `interpreter: '/usr/bin/node-20'`; its `npm ci` is `npm-20` run by `node-20`, and
its migrations run on `node-20`. The preflight judges only that runtime: a floor of 20, and the end-of-life warning
(Node 20's was 2026-04-30, so it warns). The system node is reported, never judged.

provision.sh's `node` step installs `nodejs20 nodejs20-npm` with dnf **with the packages' scriptlets off**. Their only
job is to register node-20 in the alternatives, and on this box that would repoint `/usr/bin/npm`, `/usr/bin/npx` and
`/etc/npmrc` at Node 20 under the legacy brain (`/usr/bin/node` itself survives only because it is a plain file).
The step refuses if the default node, npm or npx moved anyway. A later `dnf upgrade` of nodejs20 runs the scriptlets
again: upgrade it with `--setopt=tsflags=noscripts` too. The `node` step warns when it finds npm taken.

| # | Command | Changes | Undo |
|---|---|---|---|
| 1 | `bash infra/provision_box.sh --env dev` | nothing (plan: names the install and the one restart) | -- |
| 2 | `bash infra/provision_box.sh --env dev --apply` | installs nodejs20 (once per box); `npm ci` in `/opt/rj/dev/brain` on Node 20; restarts **`rift-brain-dev` alone** (pm2 delete + start, its interpreter changed); `pm2 save` | below |
| 3 | `bash infra/provision_box.sh --env alpha` | nothing (plan) | -- |
| 4 | `bash infra/provision_box.sh --env alpha --apply` | the same for alpha; restarts **`rift-brain-alpha` alone**; no install (already there) | below |

Neither touches `rift-brain` (legacy), Caddy, the `.env` files or the databases beyond what a re-run already does.
`infra/test/provision_node.sh` runs all of it in Docker on the box's release, with a Node 16 laid out as the box's.

**Undo**, per environment: from a checkout of the commit before RJ 477, `bash infra/provision_box.sh --env <env>
--apply --ref <that commit>`. Its ecosystem file has no interpreter, so it restarts that app alone on the system
node, after an `npm ci` by the system npm. When neither environment uses Node 20 any more:
`sudo dnf remove nodejs20 nodejs20-npm` (leaves the default node, npm and npx as they are; the test checks it).

## Undo

Until cutover (spec 7a) nothing here touches the legacy brain, `rift_brain`, its binary, TCP 3000 or
UDP 8080-8085, and today's builds never read any of it. Newest first:

4. **Alpha** (its steps 2, 4 and 5), over SSH. Leaves dev and Caddy running:
   ```
   pm2 delete rift-brain-alpha && pm2 save
   sudo rm -f /etc/caddy/sites/alpha.caddy && sudo systemctl reload caddy
   sudo mysql -e "DROP DATABASE rift_brain_alpha; DROP USER 'rift_brain_alpha'@'localhost'; DROP USER 'rift_brain_alpha'@'127.0.0.1';"
   sudo rm -rf /opt/rj/alpha
   ```
   and its document, from the Mac (nothing reads it until a build is pointed at alpha):
   ```
   aws --profile rj s3 rm s3://rj-config-<account>/alpha/client.v1.json
   aws --profile rj cloudfront create-invalidation --distribution-id <id> --paths /alpha/client.v1.json
   ```
3. **The box** (step 6), over SSH (with alpha still up, skip `disable --now caddy`: it serves both):
   ```
   pm2 delete rift-brain-dev && pm2 save
   sudo systemctl disable --now caddy
   sudo mysql -e "DROP DATABASE rift_brain_dev; DROP USER 'rift_brain_dev'@'localhost'; DROP USER 'rift_brain_dev'@'127.0.0.1';"
   sudo rm -rf /opt/rj/dev ~/rj-provision
   # Caddy itself, if wanted:
   sudo rm -rf /etc/caddy /etc/systemd/system/caddy.service /usr/local/bin/caddy /var/lib/caddy && sudo userdel caddy && sudo systemctl daemon-reload
   ```
2. **rj-box** (step 2). Detach the group first (a group still attached cannot be deleted):
   ```
   aws --profile rj ec2 modify-instance-attribute --region us-west-1 --instance-id <id> --groups sg-0c8cb7df1066de873
   aws --profile rj cloudformation delete-stack --region us-west-1 --stack-name rj-box
   ```
1. **rj-edge** (steps 1 and 4): `aws --profile rj cloudformation delete-stack --region us-east-1 --stack-name rj-edge`.
   The bucket is kept (DeletionPolicy Retain); to remove it too, empty every version first
   (`aws s3api list-object-versions` + `delete-objects`, or the console's Empty), then `aws s3api delete-bucket`.
   A later re-deploy of rj-edge needs the bucket gone (its name is fixed).

A change set made by `--changeset` and never executed: `aws cloudformation delete-change-set`, or for a stack that
never existed (REVIEW_IN_PROGRESS) `delete-stack`.

The hosted zone and the domain stay: nothing here created them.

## The box's address

The box's public IP (54.193.62.212 on 2026-10-07) is **not** an Elastic IP: a stop/start changes it. Today's
builds hardcode it, and associating an Elastic IP would also change it, so M1 leaves it alone. The A records take
the IP as a parameter: after any change, re-run `bash infra/deploy_stacks.sh --apply --box-only` (TTL 300).
An Elastic IP belongs at cutover (M7), when no build hardcodes the IP any more.

## Remote config

`config/<env>.client.v1.json` is the source; `ops/config/publish.sh <env>` publishes it to
`https://config.riftjumpers.space/<env>/client.v1.json`. `serial` and `published_at` in the source are
placeholders: publish sets them (live serial + 1, now).

```
bash ops/config/publish.sh dev --dry-run      every check, the diff, the commands; writes nothing
bash ops/config/publish.sh dev                publish config/dev.client.v1.json
bash ops/config/rollback.sh dev --list        the published versions, newest first
bash ops/config/rollback.sh dev               the previous version, under a new serial
node ops/config/validate.mjs <file> --env dev just the checks
```

- **Strict.** A published document has every field, of its type and inside the client's clamps (spec 4.5), and no
  field the schema does not know, so a typo cannot publish and then be silently ignored by every client.
  `endpoints.api` must be `https://` on a host ending in `.riftjumpers.space`. A string that looks like a key is
  refused: the document is public.
- **The lock guard.** A change that newly locks builds out -- a raised `min_build` or `min_build_multiplayer` (per
  platform: its own key, then `default`), a raised `min_wire`, or maintenance that becomes `app`-scoped -- is
  refused without `--confirm-lock`, and the refusal names the builds. A platform key overrides `default`, so raising
  `default` alone does not raise a platform written out explicitly; the guard's output shows which floors moved.
- **No lost update.** The upload is conditional on the live object being the one read (S3 `If-Match`); a publish
  that raced another refuses and changes nothing.
- An emergency publish from a working tree must be committed straight after; publish.sh warns when the source
  differs from HEAD, and rollback.sh prints how the source in git differs from what is now live.

`--local-root <dir>` stands a directory in for S3 and CloudFront (no AWS call): `npm test` drives both scripts
that way.
