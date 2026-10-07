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
with the brain stopped it answers 503 with the `NET_UNREACHABLE` envelope. Dev multiplayer starts with M4
(no server binary is deployed to `/opt/rj/dev/servers` yet).

## Undo

Until cutover (spec 7a) nothing here touches the legacy brain, `rift_brain`, its binary, TCP 3000 or
UDP 8080-8085, and today's builds never read any of it. Newest first:

3. **The box** (step 6), over SSH:
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
