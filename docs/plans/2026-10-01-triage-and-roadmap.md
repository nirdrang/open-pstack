# Triage and roadmap, 2026-10-01

Snapshot: `main` at `1c91e65` (Open Pstack 1.5.0, Cursor pstack 0.15.5). Cursor `main` at `2eb7ed4` has no pstack commits after the sync point. Of 23 open issues, 22 are still open on `main` and #33 is partly addressed by 1.5.0. All 24 recent PRs were reviewed: 23 closed without merging, #101 open.

## 1. Buckets

### A. Factory and merge plumbing (prerequisites)

| Item | Disposition |
|---|---|
| #100 / PR #101 Mergify queue | Add a required `live-gate` status first (section 6). The draft convention alone can't hold the queue, because Unfret reviews only ready PRs. Then land it, record the first queue-merged PR on #100, and close MASTRA-455, which duplicates it. |
| factory-run GitHub sources (MASTRA-737) | `begin` requires a Linear issue (`factory-ops.mjs` around line 1463), and `closeout` throws `Delivery item has no Linear issue source`. open-pstack cards have been GitHub-sourced since MASTRA-450. Add a GitHub issue source to `begin` (post prior findings as an issue comment) and to `closeout` (confirm the merged PR closed the issue, or close it with the evidence link). |
| Live-gate skill (#90, reopened) | #90 was closed as completed, but there's no project verification skill on `main` or in the main checkout. Factory sandboxes have no `bun`, `claude`, `codex`, or `grok` (see the factory triage comments), so the AGENTS.md installed-candidate gate has to run on the Mac. The skill should install a PR head into Claude Code and Codex, run the changed behavior, then post one evidence comment and the exact-SHA `live-gate` status, changing nothing else on the PR (see section 7). |
| Factory reachability | Resolved: `FACTORY_API_URL=https://studio2.tail062eee.ts.net:8444` reaches the API. The open-pstack project is `9af4ac1d-64a8-49d7-9d84-aa8d0e43c347`. |
| MASTRA-453 | #34's Build session is parked on an unresolved `request_access`. Cancel that run when #34 is planned again. |

### B. Runner reliability bugs (first; same files, so sequential)

| Issue | On `main` | Prior art | PR |
|---|---|---|---|
| #25 runner loads project `.env` (high) | `pstack-runner:1` is a plain `#!/usr/bin/env bun`. | PR #26, with two blocking review findings still open: a PATH-searched `dirname` and a late deadline start. | 1 |
| #34 Grok writer edits are cancelled | `commands.ts:58-60` uses `acceptEdits`. | #48, #81, #84, #92. smashru's branch `fix/grok-lanes-headless` at `88dd41d` has live proof. | 2 |
| #78 Grok reader shell access and cancellation evidence (high) | `commands.ts:54`, `parse-output.ts:102-104`, `run.ts:23,51-53`. | #79, #40. | 2 |
| #58 Claude event arrays and Grok `XAI_API_KEY` auth | `parse-output.ts:64-72`, `run.ts:371-372`. | #59, #75. | 3 |
| #94 Bun stdin `EPERM` | `run.ts:230,260-264`. | none | 3 (stdin part only; the Cursor status-pipe part moves to #71) |
| #56 Grok on Claude Code cloud (no Landlock or bwrap) | No detection. The failure is reported as `child-failed`. | #82 (docs). | 4, after D2 |

PR 2 must settle a conflict: #81 says the tool ID is `run_terminal_cmd`, and #92 says Grok 1.0.41 needs `run_terminal_command`. Probe the installed Grok CLI to decide.

### C. Models (one tracking issue)

| Item | Disposition |
|---|---|
| GPT-6.1 Sol (#102) | Codex 0.159.3 lists `gpt-6.1-sol` with efforts `low` through `max`, plus `ultra`. Decided: it becomes the Sol default, and `ultra` is offered for each model whose CLI entry lists it. |
| #85 GPT-6 Sol and Luna, exact Opus 5.5 pin | Keep. It also takes the Sol half of PR #83, which was dropped. |
| #54 Sonnet, GPT-5.6 Luna and Terra | Keep as a sub-issue. PR #55 was approved on 09-08 and then closed by the policy comment, so reuse it. |
| #33 explicit family subsets | Close as superseded. 1.5.0 probes only the families that roles use. The remaining GLM case needs an OpenCode provider (#68). |
| #46 setup rerun fast path | Keep. It edits the same setup flow, so it lands after the model registry. |
| #80 Codex writer full-access opt-in | Waits on D3. |

### D. External providers (after the adapter registry)

| Issue | Prior art |
|---|---|
| #71 Cursor CLI | PR #74 |
| #69 Devin | PR #70 |
| #37 agy (Gemini) | PR #31 |
| #68 OpenCode | No PR. simonbloom's GLM branch is described on #33. |

All four CLIs are installed on this Mac, so live probes can run here. D5 sets OpenCode's scope.

### E. Skill content

| Issue | Disposition |
|---|---|
| #49 preload poteto-mode in poteto-agent | This is a port-specific change (Claude `skills:` frontmatter). Take PR #50: it was approved on 09-08, and the contributor has waited four weeks. It's the smallest item on the board. |
| #41 why, #42 how, #45 pause-safely, #47 architect | These are general improvements to upstream skill bodies. Propose them at `cursor/plugins` first, and carry them here only as ledgered patches (D6). |

### F. Distribution

| Issue | Disposition |
|---|---|
| #13 OpenAI plugin directory | Blocked until a publisher identity is chosen. The prep work is on the unpushed branch `codex/issue-13-marketplace-prep` (`a5a9fa6`) in the main checkout. |
| #14 triage-ticket skill | Close as not planned. Its own private-dependency condition still blocks it, and Factory triage now covers this repository. |

## 2. Obligations from closed PRs

The 10-01 close comment asks contributors to open an issue and promises "I'll take it from there." Many of those issues already exist, so contributors may file duplicates unless someone tells them. On each PR below, reply with the issue link, and name the PR as prior art in that issue:

| Closed PR | Existing issue |
|---|---|
| #26 | #25 |
| #48, #81, #84, #92 | #34 |
| #31 | #37 |
| #50 | #49 |
| #55 | #54 |
| #82 | #56 |
| #59, #75 | #58 |
| #70 | #69 |
| #74 | #71 |
| #79 | #78 |
| #83 | #85 |

Direct replies are owed on these:

- **#50 (RomiSinghio):** asked for a merge on 09-04. The PR was approved on 09-08 and never got a reply.
- **#55:** arjitj2 asked on 09-15, "What's stopping us from merging this?", and got no answer.
- **#59 (AojdevStudio):** asked for a re-review and a workflow approval at 02:22 and 02:26 on 10-01. The PR was closed 11 hours later.
- **#83 (rasmushjulskov):** offered a Sol-only rebase. Point them to #85.
- **#101:** Greptile's P1 is unanswered.

No action on #93, #91, #76, #52, #40, or #29. #87 was withdrawn, but the stale Graphite cache bug it targeted may still be real (#86 was closed as not planned). #73 landed in 1.5.0 and is credited.

## 3. Making upstream syncs cheap

Of the 124 upstream-mapped files, 79 differ from Cursor 0.15.5 and 45 are identical. Port-only code never conflicts with upstream. That covers the runner, `provider-dispatch.md`, `codex-tools.md`, the native agents, the hooks, and the seven extra skills. The friction comes from upstream files that the port edits:

- **Default model slugs are copied into 11 upstream-derived files.** They are arena, architect, how, interrogate, setup-pstack, swarm, and the bug-fix, feature, hillclimb, perf-issue, and refactoring playbooks. `tests/skill-collision-repro.sh` requires them to match. Changing one default edits about 15 files, and each edit becomes a conflict on the next sync.
- **`setup-pstack/SKILL.md` holds the probe table.** It already has 136 changed lines, and every model or provider addition edits it.
- **A new provider touches about 12 files.** They include the `types.ts` union, the switches in `commands.ts` and `parse-output.ts`, five functions in `run.ts`, the tests, the route table, the setup probe table, and the docs.
- **Intentional exclusions live in `UPSTREAM.md` prose.** The merge probe can't check them.

Changes, in order:

1. **Model registry (#103).** One port-owned table lists the families, efforts, optional entries, native agent stems, and the first-run role defaults (role to model). Users' sheets still override roles. It lives in `provider-dispatch.md`, with a machine-readable copy that the tests read. Upstream-derived files name roles ("`arena runners`; defaults in provider-dispatch.md") instead of slugs, and the tests derive counts from the registry. After this change, GPT-6.1 Sol is one row and a default change touches one file.
2. **Provider adapter registry (#103).** Each provider gets a `runner/providers/<name>.ts` that implements one interface:
   - preflight and auth classification
   - argv for each access mode
   - the output parser
   - model proof
   - environment stripping

   `PROVIDERS`, the route table, and the setup probe rows are derived from this registry, and the tests are table-driven. After this change, Devin needs one adapter, one fixture, and one registry row.
3. **Port-patch ledger (#105).** A checked-in file lists every intentional divergence with its file, anchor, reason, and issue. Examples: the `disable-model-invocation` flag removed from four skills, the dispatch-contract preface, the sheet-path substitution, and the excluded upstream hunks. `upstream-merge-probe.py` checks that each entry still holds after a merge, and the exclusion list in `UPSTREAM.md` is generated from the ledger.
4. **Upstream first for general content.** Skill-body improvements that aren't harness adaptations go to `cursor/plugins`. Local divergence is only for harness adaptation.
5. **Sync runbook (#106).** Turn the "Incorporate a change" section of `UPSTREAM.md` into a runbook that the factory planner can follow:
   1. Audit.
   2. Merge.
   3. Probe.
   4. Check the ledger.
   5. Update `CHANGES.md`, `NOTICE.md`, and `UPSTREAM.md`.
   6. Run the CI-equivalent checks locally: Bun tests, strict typecheck, static invariants, plugin validation.
   7. Run the live gate.
   8. Merge the reviewed PR before tagging the release.

   A sync then becomes an ordinary factory ticket.

## 4. Factory execution loop

Each issue goes through these steps:

1. Its card already exists from auto-intake (MASTRA-450).
2. Claude moves the card to Planning with `factory-run`.
3. The planner posts a plan.
4. `factory-adjudicate` judges the plan with a different model.
5. Build runs on the Factory branch. Before opening the PR, the builder runs the checks AGENTS.md requires: Bun tests, strict typecheck, static invariants, and plugin validation. Then it opens the PR, ready for review. If the build host lacks Bun, as the triage sandbox did, fix the host before the first run. Don't skip the checks.
6. Unfret reviews the PR. The builder fixes the findings until Unfret passes.
7. Claude runs the live gate (A3) on that final head. The verifier posts one evidence comment and the `live-gate` status on that exact head, and changes nothing else on the PR. Any later head, including a queue-created head, needs a fresh run.
8. Mergify queues the PR once `verify`, `Unfret`, and `live-gate` pass on the same head.
9. The builder verifies the merged result and moves the card to Done.
10. `closeout` closes the GitHub issue (A2) and records findings.

Waves:

- **Wave 0:** #101, the contributor replies, factory-run GitHub sources (A2), and the live-gate skill (A3).
- **Wave 1, sequential:** #25, then #34 with #78, then #58 with #94, then #56.
- **Wave 2:** the model registry and provider adapter registry (#103), then the port-patch ledger (#105) and the sync runbook (#106).
- **Wave 3, parallel after Wave 2:** the models tracking issue (GPT-6.1 Sol, #85, #54), the providers (#71, #69, #37, #68), and #49, #46, and #80.
- **Wave 4:** upstream proposals for #41, #42, #45, and #47.
- **Parked:** #13.

## 5. Decisions (resolved 2026-10-01)

- **D1.** Approved. The closed PRs now link to their issues, and the five owed replies are posted. #33 and #14 are closed, #90 is reopened, and the factory-run GitHub-source work is MASTRA-737.
- **D2.** Option (c): document the limit and name the cause inside the existing `child-failed`. Recorded on #56.
- **D3.** The Codex writer full-access opt-in is approved: off by default, Codex `isolated-write` only, set in the sheet. Recorded on #80.
- **D4.** `gpt-6.1-sol` becomes the Sol default, and `ultra` is offered wherever the CLI lists it (#102).
- **D5.** OpenCode is supported as an external helper provider only. Recorded on #68.
- **D6.** #41, #42, #45, and #47 go upstream first. Recorded on each issue.
- The model and provider registry gets a design pass before anything is built (#103). #85, #54, #46, #80, #71, #69, #37, and #68 wait on it.

## 6. Factory readiness findings (2026-10-01, later)

- The installed `factory-ops.mjs`, factory-adjudicate, and babysit-pr match mastra-pilot `main`. factory-run's `SKILL.md` is one paragraph behind MASTRA-735 (the merge notice now comes from the deployment's `pullRequestMerged` override). Reinstall it from `main`.
- `begin` and `closeout` accept only Linear sources (MASTRA-737). This blocks every open-pstack run.
- #101 gap: Unfret doesn't review drafts, so a PR has to be non-draft to get `Unfret`. Once it's non-draft, #101 queues it when `verify` and `Unfret` pass, which can happen before the live test. Fix requirement: the commit that merges must be the commit the installed-harness test ran on, and the queue must never wait on a check that nothing can post. The likely shape, to be confirmed in the #101 session against Mergify's docs: in-place queue checks (empty `merge_conditions`, `batch_size: 1`, so Mergify creates no draft batch PR), and `queue_conditions` that require `-draft`, `verify`, `Unfret`, `live-gate` (a commit status that the #90 skill posts on the exact head), and the branch being up to date with `main`. With the merge-commit method and an up-to-date branch, the merged tree is the tested tree. Any `main` change forces a rebase, which creates a new head that needs fresh `verify`, `Unfret`, and `live-gate`. Corrections are posted on the #101 Greptile thread.
- Order: MASTRA-737, then the live-gate check in #101 and its merge, then #90. After that, Wave 1. Until #90 exists, the operator posts `live-gate` by hand on each PR head, after running the installed-harness test, with a link to the evidence. #101 is merged that way as well.

## 7. Gate change (2026-10-03)

AGENTS.md now treats the exact-head `live-gate` status and its linked evidence comment as the live-evidence record, in place of the PR template and the draft rule. Mergify's required `live-gate` check enforces it. The change came out of the #111 step-back: every way the verifier changed draft, ready, or body state produced new review findings, and draft state was no longer a merge control. The verifier (#90) posts only the comment and the status. #106's runbook follows this order: review first, then the live gate on the final head.
