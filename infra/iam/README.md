# IAM policies (the source)

The inline policies we write, one file each. IAM itself is changed by hand in the console (the deploy user
`rj-deploy` holds no IAM rights, deliberately, so no script can apply or check these): change the file here first, in
a PR, then paste it into the console. Docs point here instead of copying a policy, so there is one copy to keep right.

| File | Inline policy on | Its name there |
|---|---|---|
| `rj-deploy-ec2.json` | user `rj-deploy` (and any other deployer) | `rj-deploy-ec2` |
| `rj-alerts.json` | user `rj-deploy` (and any other deployer) | `rj-alerts` (RJ 487) |
| `rj-box-metrics.json` | role `rj-box-metrics` (trusted by EC2; the box's instance profile) | any, e.g. `put-rj-metrics` (RJ 487) |

The account number is `*` in the resource ARNs: a policy acts only in its own account anyway, and this repository is
public. The console's copy may show the number instead; that is the same policy.

The managed policies on `rj-deploy` are not listed anywhere on purpose: for a new deployer, copy them from IAM ->
Users -> `rj-deploy` -> Permissions, which is the only list that cannot be out of date.
