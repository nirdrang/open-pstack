# This is a fork

Upstream is [ericlitman/open-pstack](https://github.com/ericlitman/open-pstack), which itself
tracks Cursor's pstack. This fork exists so that local changes survive a plugin update. The
installed plugin cache is a version-keyed directory, not a git repository, so an edit made there
is global to the machine and is overwritten the next time the plugin updates.

The marketplace is renamed to `open-pstack-nirdrang` so it can be registered beside the original.
Rolling back is one edit to the consuming project's `extraKnownMarketplaces` and `enabledPlugins`.

## What diverges from upstream

Nothing else is changed. Every other file is upstream's.

### A rejected result keeps its text and its stream

Six files under `plugins/pstack/skills/poteto-mode/`:

    references/provider-dispatch.md
    scripts/runner/types.ts
    scripts/runner/parse-output.ts
    scripts/runner/run.ts
    scripts/runner/run.test.ts
    scripts/runner/parse-output.test.ts

Measured on 2026-09-09: a grok lane ran sixteen minutes, committed real work, and emitted a
terminal event whose subtype was not the word `success`. The runner classified the run as
malformed, never wrote the output file, and kept the first four thousand characters of the stream
as evidence, which is the prompt. The subtype that caused the rejection was unrecoverable.

Now a parse failure that still holds the terminal text throws `MalformedOutputError` carrying
it, and the runner writes that text into the output path it reserved. The receipt stays
`malformed-output`, so the parent does not count the lane. The raw streams are kept whole beside
the receipt as `<receipt>.stdout` and `<receipt>.stderr`, named in `error.stdoutPath` and
`error.stderrPath`, and the inline evidence is the tail. The grok message names the subtype and
`is_error` value it refused. Which subtypes should count as success is a separate decision,
taken only once a real one has been captured.

### An opencode provider for the external-lane runner

Nine files under `plugins/pstack/skills/poteto-mode/`:

    references/provider-dispatch.md
    scripts/runner/types.ts
    scripts/runner/commands.ts
    scripts/runner/parse-output.ts
    scripts/runner/run.ts
    scripts/runner/cli.ts
    scripts/runner/commands.test.ts
    scripts/runner/parse-output.test.ts
    scripts/runner/run.test.ts

The runner gains `opencode` beside `claude`, `codex` and `grok`. A descriptor is written
`opencode:<provider>/<model>@<effort>`, for example
`opencode:opencode-go/muse-spark-1.3-contributor@xhigh`. The model keeps opencode's own two-part
id, and the effort must be a variant that `opencode models <provider> --verbose` registers for
that model.

Measured facts the implementation rests on, on opencode 1.18.16 and later:

- `opencode run --format json` never names the model in its events. `opencode export <sessionID>`
  does, under `info.model`. The runner runs export after the model and fails the lane if the
  variant differs from the effort that was requested.
- An unregistered `--variant` is dropped silently, so the runner refuses a missing model or
  variant in preflight rather than letting the lane run at the wrong effort.
- opencode has no sandbox flag. Access is bounded by an agent injected through
  `OPENCODE_CONFIG_CONTENT`, the highest standard config layer, so a project config cannot loosen
  it. Bash cannot be confined to read-only there, so a read-only lane denies it.
- A missing `--agent` falls back to the default agent at exit 0 with a warning on stderr. The
  runner fails the lane on that string, because the default agent can write.

Proven by live lanes rather than by the suite: `run.test.ts` cannot pass on Windows, because it
builds POSIX fake CLIs and a `:`-separated PATH. The `commands`, `parse-output` and `cli` tests
are meaningful there and pass.

## Keeping up with upstream

    git remote add upstream https://github.com/ericlitman/open-pstack.git   # once
    git fetch upstream
    git log --oneline HEAD..upstream/main                                   # what you are behind
    git merge upstream/main

Conflicts land in the nine files above and nowhere else.
