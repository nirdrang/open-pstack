Closes #

## What changed


## Verification

- [ ] Bun tests, strict typecheck, static invariants, and plugin validation pass.
- [ ] The exact candidate is installed in every affected harness.
- [ ] The changed behavior passes from each real user surface.
- [ ] The `live-gate` status on the final head links the evidence comment (installed version, surface, action, observed result).

Mergify does not queue a pull request without `live-gate` on its exact head. Do not merge, tag, release, or roll out without it.
