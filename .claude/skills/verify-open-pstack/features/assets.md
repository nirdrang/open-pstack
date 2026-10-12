# Installed assets

## Sub-features

Manifest declaration, packaged presence, installed resolution, and the user-visible resource on every actual consuming harness. Determine consumers from the immutable candidate plugin manifests; do not assume all harnesses consume every asset.

## How to get to it (user POV)

Install the candidate plugin through each manifest that references the changed asset, then open or inspect the native installed surface that renders or exposes that resource. The current `plugins/pstack/assets/logo.png` is referenced by `plugins/pstack/.codex-plugin/plugin.json` at `interface.logo`; no Claude manifest references it.

## Driving it with verify-open-pstack

Inspect the pinned manifests and retain the exact asset-reference evidence. Confirm the referenced path resolves inside the pinned installed plugin, the installed bytes match candidate Git provenance, and the consuming native surface loads the resource. Retain a transcript plus a concrete UI capture or native inspection artifact. Record each actual consumer and why non-consumers were not selected.

A logo-only change currently requires Codex installed-surface evidence only. If a manifest adds another consumer, exercise that consumer too. If a changed asset has no manifest reference, escapes the plugin, has ambiguous ownership, or cannot be observed on its declared native surface, fail closed rather than substituting unrelated skill, setup, runner, or tool exercises.

## Gotchas

Repository file existence alone is not installed behavior. Do not select every skill merely because an asset lives under `plugins/pstack`. Do not claim Claude coverage for the current logo when its manifest does not consume it. Direct image inspection may supplement, but cannot replace, the actual installed consumer observation.

## Headless

No recipe exists yet; `assets:codex` fails as `unsupported-native-consumer` before any session starts.
