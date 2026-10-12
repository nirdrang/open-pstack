# Setup and model configuration

## Sub-features

Installed setup invocation, harness-to-provider mapping, generated routing/model preferences, unavailable-provider handling, and changed configuration references.

## How to get to it (user POV)

Invoke `/pstack:setup-pstack` in Claude or `$setup-pstack` in Codex. The installed instructions are the authority for setup inputs.

## Driving it with verify-open-pstack

For setup only, snapshot the operator's real `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` and `CLAUDE.md` before invocation, preserving exact bytes and whether each file existed. Exercise every changed setup branch with explicit model/provider inputs. Retain the native transcript and generated configuration privately, then invoke a consuming installed skill to observe the configured route.

Restore both files byte for byte afterwards, including restoring original absence, on success or failure. Verify restoration before any evidence comment or status publication. Restoration failure stops the run and publishes nothing. Retain snapshot and restoration results in the private mode-0700 evidence root through merge.

## Gotchas

Claude uses the operator's normal config/login; Codex uses a run-owned home with auth symlinked to the daily login. Do not redirect `HOME`, copy credentials, start login, or use a mock as setup proof. Generated configuration alone does not prove the consuming surface. Setup restoration is the only permitted temporary change to these daily Claude files.

## Headless

The setup recipe in `recipes.ts` serves `setup` and `skill-invocation:setup-pstack`. One session runs setup with explicit answers that move every model-family role to `claude:opus@high`, and asserts the written sheet holds only that descriptor. A second session has `poteto-mode` report the configured route for one role. The parent snapshots the daily files before the first session and restores and verifies them after the last, on success or failure.
