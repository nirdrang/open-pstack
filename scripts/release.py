#!/usr/bin/env python3
"""Publish an Open Pstack release from its CHANGES.md section.

`notes` prints the release body for the version in the Claude plugin manifest: that
version's CHANGES.md section, then a link to the section at the tag. `publish` checks
every precondition before it writes anything, then tags the PR head whose live gate
passed, pushes the tag, and creates the GitHub release with that body.

    python3 scripts/release.py notes
    python3 scripts/release.py publish
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

REPO = "ericlitman/open-pstack"
MANIFEST = "plugins/pstack/.claude-plugin/plugin.json"
ROOT = Path(__file__).resolve().parents[1]


def sections(text):
    found, heading, body = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if heading is not None:
                found.append((heading, "\n".join(body).strip()))
            heading, body = line[3:].strip(), []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        found.append((heading, "\n".join(body).strip()))
    return found


def version_section(text, version):
    pattern = re.compile(re.escape(version) + r"(\s|$)")
    matches = [(heading, body) for heading, body in sections(text) if pattern.match(heading)]
    if len(matches) != 1:
        raise ValueError(f"CHANGES.md has {len(matches)} sections for {version}; expected one")
    heading, body = matches[0]
    if not body:
        raise ValueError(f"CHANGES.md section '{heading}' is empty")
    return heading, body


def has_unreleased(text):
    return any(heading.lower().startswith("unreleased") for heading, _ in sections(text))


def anchor(heading):
    return re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")


def notes(text, version):
    heading, body = version_section(text, version)
    link = f"https://github.com/{REPO}/blob/v{version}/CHANGES.md#{anchor(heading)}"
    return f"{body}\n\nFull entry: [CHANGES.md, {version}]({link}).\n"


class Facts(NamedTuple):
    version: str
    changes: str
    clean: bool
    head: str
    origin_main: str
    unreleased: bool
    section_error: str | None
    tag_exists: bool
    pr_head: str | None
    live_gate: str | None
    same_tree: bool


def refusals(facts):
    found = []
    if not facts.clean:
        found.append("the checkout has uncommitted or untracked changes")
    if facts.head != facts.origin_main:
        found.append(f"HEAD {facts.head[:12]} is not origin/main {facts.origin_main[:12]}")
    if facts.unreleased:
        found.append("CHANGES.md still has an Unreleased section; move its entries under the release")
    if facts.section_error:
        found.append(facts.section_error)
    if facts.tag_exists:
        found.append(f"tag v{facts.version} already exists")
    if facts.pr_head is None:
        found.append("HEAD is not a merge commit, so no live-gated PR head backs it")
    else:
        if facts.live_gate != "success":
            found.append(f"live-gate on PR head {facts.pr_head[:12]} is {facts.live_gate or 'missing'}")
        if not facts.same_tree:
            found.append(f"HEAD's tree differs from PR head {facts.pr_head[:12]}, so the live gate did not verify it")
    return found


def run(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def ok(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True).returncode == 0


def gather():
    run("git", "fetch", "--quiet", "--tags", "origin", "main")
    head = run("git", "rev-parse", "HEAD")
    text = run("git", "show", f"{head}:CHANGES.md")
    version = json.loads(run("git", "show", f"{head}:{MANIFEST}"))["version"]
    pr_head = run("git", "rev-parse", f"{head}^2") if ok("git", "rev-parse", "--verify", "--quiet", f"{head}^2") else None
    try:
        version_section(text, version)
        section_error = None
    except ValueError as error:
        section_error = str(error)
    live_gate = None
    if pr_head:
        states = run("gh", "api", f"repos/{REPO}/commits/{pr_head}/status",
                     "--jq", '.statuses[] | select(.context == "live-gate") | .state')
        live_gate = states.splitlines()[0] if states else None
    return Facts(
        version=version,
        changes=text,
        clean=run("git", "status", "--porcelain", "--untracked-files=all") == "",
        head=head,
        origin_main=run("git", "rev-parse", "origin/main"),
        unreleased=has_unreleased(text),
        section_error=section_error,
        tag_exists=ok("git", "rev-parse", "--verify", "--quiet", f"refs/tags/v{version}")
        or bool(run("git", "ls-remote", "--tags", "origin", f"refs/tags/v{version}")),
        pr_head=pr_head,
        live_gate=live_gate,
        same_tree=bool(pr_head) and run("git", "rev-parse", f"{head}^{{tree}}") == run("git", "rev-parse", f"{pr_head}^{{tree}}"),
    )


def publish():
    facts = gather()
    found = refusals(facts)
    if found:
        print("refusing to release:\n" + "\n".join(f"- {reason}" for reason in found), file=sys.stderr)
        return 2
    version = facts.version
    title = f"Open Pstack {version}"
    run("git", "tag", "-a", f"v{version}", "-m", title, facts.pr_head)
    run("git", "push", "--quiet", "origin", f"refs/tags/v{version}")
    subprocess.run(["gh", "release", "create", f"v{version}", "--repo", REPO, "--verify-tag",
                    "--title", title, "--notes-file", "-"], cwd=ROOT, input=notes(facts.changes, version), text=True, check=True)
    return 0


def main(argv):
    if argv not in (["notes"], ["publish"]):
        print(__doc__, file=sys.stderr)
        return 2
    if argv == ["publish"]:
        return publish()
    version = json.loads((ROOT / MANIFEST).read_text())["version"]
    try:
        sys.stdout.write(notes((ROOT / "CHANGES.md").read_text(), version))
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
