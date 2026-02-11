# Release Playbook

Use this when shipping a new `pi-librarian` version.

## Checklist

1. Ensure the working tree is clean (or only includes intended release changes).
2. Confirm release version (`X.Y.Z`).
3. Run required validation:
   - `npm run pack:check`
4. Bump package version (`package.json`).
5. Commit and push release changes.
6. Create and push tag `vX.Y.Z`.
7. Create a GitHub release for `vX.Y.Z`.
   - Before writing notes, review 2 recent releases and copy their structure/style.
   - Keep notes concise and factual (typically `Changes` + `Validation`).
8. Publish to npm.
   - Ask the user for OTP right before publish (OTP expires quickly).

## Verify publish

`npm view` may lag due cache. Verify with registry data:

```bash
curl -s https://registry.npmjs.org/pi-librarian \
  | jq -r '."dist-tags".latest, (.versions | keys | .[-1])'
```

Expected: both lines show `X.Y.Z`.

## If something fails

- OTP expired/invalid: request a fresh OTP and retry.
- Version already exists: bump version and repeat release steps.
- Auth errors (`gh`/`npm`): ask the user to authenticate, then retry.
