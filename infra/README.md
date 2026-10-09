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
config/<env>.client.v1.json the remote config sources (changes go through PRs)
ops/config/validate.mjs     checks a document: types, clamps, env (src/config/remoteSchema.js)
ops/config/publish.sh       validate, client parser, lock guard, serial, upload, invalidate, fetch back
ops/config/rollback.sh      republish an earlier S3 version under a new serial
ops/drills/                 release drills 1, 2 and 7 (plan by default); ops/drills/test/drills_local.sh runs them locally
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
2. **rj-box** (step 2). Detach the group first (a group still attached cannot be deleted); since RJ 476 the box's other
   group is `rj-legacy`, which replaced launch-wizard-2 (`sg-0c8cb7df1066de873`):
   ```
   aws --profile rj ec2 modify-instance-attribute --region us-west-1 --instance-id <id> --groups <rj-legacy's id>
   aws --profile rj cloudformation delete-stack --region us-west-1 --stack-name rj-box
   ```
1. **rj-edge** (steps 1 and 4): `aws --profile rj cloudformation delete-stack --region us-east-1 --stack-name rj-edge`.
   The bucket is kept (DeletionPolicy Retain); to remove it too, empty every version first
   (`aws s3api list-object-versions` + `delete-objects`, or the console's Empty), then `aws s3api delete-bucket`.
   A later re-deploy of rj-edge needs the bucket gone (its name is fixed).

A change set made by `--changeset` and never executed: `aws cloudformation delete-change-set`, or for a stack that
never existed (REVIEW_IN_PROGRESS) `delete-stack`.

The hosted zone and the domain stay: nothing here created them.

## The cutover, in order (spec 7; RJ 470 wrote it, nobody has run it)

The hard cut from the legacy stack (pm2 `rift-brain` on :3000, database `rift_brain`, the binary
`/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64`, UDP 8080-8085) to dev + alpha. Every step has its undo
beside it. Steps marked **box** run in an SSH session on the box, the rest on the Mac in Rift-Brain; both start with

```
source ~/.config/rift-jumpers/deploy.env
ssh -i "$RJ_DEPLOY_PEM" "$RJ_DEPLOY_HOST"                  # for the box steps
```

**POINT OF NO RETURN: step 4d (`rift_brain` dropped) together with step 5 (a build in external testers' hands).**
Before both have happened every step undoes as written. After them the way back is spec 7a's: restore the archive
(4d's and 4e's undo), re-add the rules (4f's undo), revert the client (`git revert -m 1` of each milestone's merge,
newest first, back to the tag `pre-alpha-infra`, in both repos) and ship a new build.

### 0. Preconditions (read-only)

- Alex's written go-ahead (spec 7a): given 2026-10-09.
- Kyler: the box size (t3.small) and the Elastic IP (4g, 4h). RJ 472: the iOS build path.
- Alpha is ready for testers:
  ```
  curl -s https://config.riftjumpers.space/alpha/client.v1.json      # floors 0, links.store.android/ios filled, maintenance off
  curl -s https://api.riftjumpers.space/v1/stats/columns -H 'X-RJ-Api: 1' -H 'X-RJ-Env: alpha' -H 'X-RJ-Build: 0'   # result ok
  ```
  **box**: `cat /opt/rj/alpha/servers/manifest.json` names the release's wire and fingerprint as `active`
  (else, in Wobble Planet on a clean `main`: `bash deploy_server.sh --env alpha`; undo `--withdraw <N>`).
- **box**: who runs the legacy brain: `pm2 ls` (ec2-user's) or `sudo pm2 ls` (root's). Below says `pm2`; use
  `sudo pm2` throughout step 4 if it is root's.

### 3. The first alpha build

| # | Command | Undo |
|---|---|---|
| 3a | Every drill in Wobble Planet's docs/release-drills.md against dev, recorded in its results table | -- (each drill puts back what it changed) |
| 3b | In Wobble Planet, on a clean `main`: `bash Tools/build_release.sh --platform android --env alpha`, then `--platform ios` | -- (local files) |
| 3c | Upload both to the Play closed testing track and TestFlight, **internal testers (the team) only** | stop the rollout / expire the build |

### 4. Retire the legacy stack

**4a. Record the legacy pm2 entry, then stop it** (**box**). Paths only: the env block holds the database password.
```
mkdir -p ~/legacy-archive && cd ~/legacy-archive
pm2 jlist | node -e 'const a = JSON.parse(require("fs").readFileSync(0)); const p = a.find((x) => x.name === "rift-brain");
  if (!p) { console.error("no rift-brain in this pm2 (try sudo pm2)"); process.exit(1); }
  console.log(JSON.stringify({ name: p.name, script: p.pm2_env.pm_exec_path, cwd: p.pm2_env.pm_cwd, args: p.pm2_env.args || [] }, null, 1));' > pm2-rift-brain.json
cat pm2-rift-brain.json
pm2 stop rift-brain
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/             # 000: nothing answers
```
Undo: `pm2 start rift-brain`.

**4b. Archive it** (**box**): the database after the brain stopped writing, the binary, the checkout (with its `.env`).
```
cd ~/legacy-archive
LEGACY_CWD="$(node -p 'require("./pm2-rift-brain.json").cwd')"
sudo mysqldump --defaults-extra-file=/root/.my.cnf --single-transaction --routines --triggers --events --databases rift_brain | gzip > rift_brain.sql.gz
gunzip -t rift_brain.sql.gz && zcat rift_brain.sql.gz | grep -c 'INSERT INTO `users`'      # > 0
cp /home/ec2-user/rift_jumper_multiplayer_server_test.x86_64 .
tar czf legacy-brain-checkout.tgz -C "$(dirname "$LEGACY_CWD")" "$(basename "$LEGACY_CWD")"
sha256sum pm2-rift-brain.json rift_brain.sql.gz rift_jumper_multiplayer_server_test.x86_64 legacy-brain-checkout.tgz > SHA256SUMS
```
Undo: `rm -rf ~/legacy-archive` (nothing else changed).

**4c. Put the archive in S3 for 90 days** (Mac). A bucket of its own, never the config bucket: CloudFront serves that
one. The archive holds real player data, so the Mac's copy is deleted as soon as S3 has it (README, "Player data
outside production"). If the `rj` profile may not create a bucket, make it in the console with the same settings.
```
ACCOUNT="$(aws --profile rj sts get-caller-identity --query Account --output text)"
BUCKET="rj-archive-$ACCOUNT"
aws --profile rj s3api create-bucket --region us-west-1 --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=us-west-1
aws --profile rj s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws --profile rj s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"legacy-90-days","Status":"Enabled","Filter":{"Prefix":"legacy/"},"Expiration":{"Days":90}}]}'
mkdir -p ~/rj-legacy-archive && scp -i "$RJ_DEPLOY_PEM" "$RJ_DEPLOY_HOST:legacy-archive/*" ~/rj-legacy-archive/
(cd ~/rj-legacy-archive && shasum -a 256 -c SHA256SUMS)
aws --profile rj s3 cp ~/rj-legacy-archive/ "s3://$BUCKET/legacy/$(date -u +%Y-%m-%d)/" --recursive
aws --profile rj s3 ls "s3://$BUCKET/legacy/" --recursive --human-readable            # five files
rm -rf ~/rj-legacy-archive
```
Undo: `aws --profile rj s3 rb "s3://$BUCKET" --force`.

**4d. Drop `rift_brain`** (**box**). Half of the point of no return. After it, `provision_box.sh --env dev
--recopy-db` has nothing to copy.
```
sudo mysql --defaults-extra-file=/root/.my.cnf -e 'SHOW DATABASES'                      # rift_brain, rift_brain_dev, rift_brain_alpha
sudo mysql --defaults-extra-file=/root/.my.cnf -e 'DROP DATABASE rift_brain'
```
Undo (the dump creates the database itself): on the Mac
`aws --profile rj s3 cp "s3://$BUCKET/legacy/<date>/rift_brain.sql.gz" . && scp -i "$RJ_DEPLOY_PEM" rift_brain.sql.gz "$RJ_DEPLOY_HOST:" && rm rift_brain.sql.gz`,
then on the box `zcat ~/rift_brain.sql.gz | sudo mysql --defaults-extra-file=/root/.my.cnf && rm ~/rift_brain.sql.gz`.

**4e. Delete the pm2 app and the binary** (**box**). The legacy checkout stays where it is (it is archived too).
```
pm2 delete rift-brain && pm2 save
rm /home/ec2-user/rift_jumper_multiplayer_server_test.x86_64
rm -rf ~/legacy-archive
```
Undo: copy `rift_jumper_multiplayer_server_test.x86_64` back from the archive to `/home/ec2-user/` (`chmod +x`), and
`pm2 start <script> --name rift-brain --cwd <cwd> && pm2 save` with the two paths from the archive's
`pm2-rift-brain.json` (4d's undo first: it needs its database).

**4f. Close TCP 3000 and UDP 8080-8085** (Mac). They are in the group `rj-legacy` (RJ 476), which also holds SSH:
revoke the two rules, not the group. Check the first command's output: if a rule's CIDR is not `0.0.0.0/0` (or it has
an IPv6 range), write the revoke to match it.
```
SG="$(aws --profile rj ec2 describe-security-groups --region us-west-1 --filters Name=group-name,Values=rj-legacy --query 'SecurityGroups[0].GroupId' --output text)"
aws --profile rj ec2 describe-security-groups --region us-west-1 --group-ids "$SG" --query 'SecurityGroups[0].IpPermissions'
aws --profile rj ec2 revoke-security-group-ingress --region us-west-1 --group-id "$SG" --ip-permissions \
  'IpProtocol=tcp,FromPort=3000,ToPort=3000,IpRanges=[{CidrIp=0.0.0.0/0}]' 'IpProtocol=udp,FromPort=8080,ToPort=8085,IpRanges=[{CidrIp=0.0.0.0/0}]'
```
Undo: the same `--ip-permissions` with `authorize-security-group-ingress`.

**4g. The Elastic IP** (Mac; Kyler's call). Changes the box's address once, now that no build hardcodes it: both
environments' running matches drop, and the hostnames follow within the A records' TTL (300 s). Do it before 4h, so the
resize keeps the address.
```
INSTANCE_ID="${RJ_INSTANCE_ID:-$(aws --profile rj ec2 describe-instances --region us-west-1 --filters "Name=ip-address,Values=${RJ_DEPLOY_HOST#*@}" --query 'Reservations[0].Instances[0].InstanceId' --output text)}"
ALLOC="$(aws --profile rj ec2 allocate-address --region us-west-1 --domain vpc --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=rj-box}]' --query AllocationId --output text)"
aws --profile rj ec2 associate-address --region us-west-1 --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC"
aws --profile rj ec2 describe-addresses --region us-west-1 --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text
```
Then set `RJ_DEPLOY_HOST=ec2-user@<that IP>` and `RJ_INSTANCE_ID=<the id>` in `deploy.env`, and
`bash infra/deploy_stacks.sh --apply --box-only` (the A records). Check: `dig +short api.riftjumpers.space` is the new IP,
and `curl -s https://api-dev.riftjumpers.space/v1/stats/columns -H 'X-RJ-Api: 1' -H 'X-RJ-Env: dev' -H 'X-RJ-Build: 0'` is ok.
Undo: `aws --profile rj ec2 disassociate-address --region us-west-1 --association-id "$(aws --profile rj ec2 describe-addresses --region us-west-1 --allocation-ids "$ALLOC" --query 'Addresses[0].AssociationId' --output text)"` and
`aws --profile rj ec2 release-address --region us-west-1 --allocation-id "$ALLOC"` (the box gets a new automatic
address), then deploy.env and `deploy_stacks.sh --apply --box-only` again.

**4h. Resize to t3.small** (Mac, or the console; Kyler's call). Both environments are down for the stop/start.
```
aws --profile rj ec2 stop-instances --region us-west-1 --instance-ids "$INSTANCE_ID"
aws --profile rj ec2 wait instance-stopped --region us-west-1 --instance-ids "$INSTANCE_ID"
aws --profile rj ec2 modify-instance-attribute --region us-west-1 --instance-id "$INSTANCE_ID" --instance-type Value=t3.small
aws --profile rj ec2 start-instances --region us-west-1 --instance-ids "$INSTANCE_ID"
```
Then **box**: `pm2 ls` shows `rift-brain-dev` and `rift-brain-alpha` online (if not, `pm2 resurrect`, and
`pm2 startup` so a reboot brings them back), `systemctl is-active caddy`, and the two `curl`s of 4g.
Undo: the same with `Value=t2.micro`.

### 5. Release to external testers

Promote the 3c builds to the closed testing track's testers and TestFlight's external group. **With 4d, this is the
point of no return.** Undo before it: don't. After it: spec 7a's way back, at the top of this section.

From the next release on, spec 7's "Every release after that" and the floor policy apply (Wobble Planet's
docs/backend-ops.md, "The floor policy").

## The box's address

The box's public IP (54.193.62.212 on 2026-10-07) is **not** an Elastic IP: a stop/start changes it. Today's
builds hardcode it, and associating an Elastic IP would also change it, so M1 leaves it alone. The A records take
the IP as a parameter: after any change, re-run `bash infra/deploy_stacks.sh --apply --box-only` (TTL 300).
An Elastic IP belongs at cutover (M7), when no build hardcodes the IP any more: "The cutover, in order", step 4g.

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
