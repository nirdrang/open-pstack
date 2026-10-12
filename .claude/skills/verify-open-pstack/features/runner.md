# Runner and provider dispatch

## Sub-features

Strict argument validation, parent/provider routing, external child launch, prompt delivery, output and receipt persistence, and failure reporting; inspect the diff for which branches changed.

## How to get to it (user POV)

Invoke the installed parent workflow (`poteto-mode`, `arena`, or `swarm` as documented by the candidate) in the fresh native harness. Have that parent dispatch its documented external-provider lane.

## Driving it with verify-open-pstack

Read the candidate's `pstack-runner --help` and installed mapping through the native skill. Use a run-owned fixture and fresh output/receipt paths. Exercise all changed provider lanes without changing parent routing. Retain the native parent/child transcript, provider receipt, output, and concrete fixture effect. Confirm provider/model/effort/access mode match the requested route and output belongs to this invocation. Exercise changed invalid-input/failure branches as well. Keep direct runner tests in a separately labeled local-CLI artifact, never as the installed-harness result.

## Gotchas

Provider children retain real `HOME`, `USER`, and `LOGNAME` and the native-login arrangement in `isolation.md`: normal Claude config/login with session-only candidate plugin flags, and run-owned Codex config with auth symlinked to the daily login. Temporary and GitHub state remain run-owned; never pass publisher credentials. No credential reading/copying, source flags, or extra login is required. Missing file-based Codex auth fails closed. State separation is not an OS access-denial guarantee.

Do not add implicit timeouts or weaker-model fallbacks. A model assertion that a child ran is insufficient; inspect the actual receipt and output. Never reuse output from another SHA or run.

## Headless

The runner recipe in `recipes.ts` has the installed `poteto-mode` parent launch the candidate `pstack-runner` for one external lane: `codex:gpt-6.1-sol@max` from Claude and `claude:opus@max` from Codex. It asserts the launcher command ran from the installed plugin, the receipt reports `complete` with the requested parent, provider, model, effort, and mode, and this session wrote the output. `verify.sh run --runner-route PROVIDER:MODEL@EFFORT` replaces the route for each parent whose provider differs.
