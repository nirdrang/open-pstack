#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release
from release import Facts, anchor, has_unreleased, notes, refusals, version_section

# Anchors GitHub rendered for these CHANGES.md headings at v1.6.0.
GITHUB_ANCHORS = [
    ("CHANGES — applied substitutions", "changes--applied-substitutions"),
    ("1.6.0 syncs to Cursor pstack 0.15.17", "160-syncs-to-cursor-pstack-01517"),
    ("Config-home port correction (#120)", "config-home-port-correction-120"),
    ("1.2.0 adds verified multi-PR plans, earlier runtime diagnostics, and shared review-bot triage",
     "120-adds-verified-multi-pr-plans-earlier-runtime-diagnostics-and-shared-review-bot-triage"),
    ("1.0.0 — establish open-pstack", "100--establish-open-pstack"),
    ("0.9.12 — restore the upstream frontier panel across Claude Code and Codex",
     "0912--restore-the-upstream-frontier-panel-across-claude-code-and-codex"),
    ("0.9.8 — command-paired skills drop `disable-model-invocation`",
     "098--command-paired-skills-drop-disable-model-invocation"),
    ("0.9.6 — hook hardening and duplication trims (thermo-nuclear review)",
     "096--hook-hardening-and-duplication-trims-thermo-nuclear-review"),
    ("Upstream review through `0452e08` (v0.10.0), 2026-07-01", "upstream-review-through-0452e08-v0100-2026-07-01"),
    ("0.9.5 — poteto-mode auto-fires via SessionStart hook", "095--poteto-mode-auto-fires-via-sessionstart-hook"),
    ("0.9.2 sync (against upstream `e46364b`)", "092-sync-against-upstream-e46364b"),
    ("New / imported files", "new--imported-files"),
]

CHANGES = """# CHANGES

Preamble.

## Unreleased

- Pending entry.

## 1.6.0 syncs to Cursor pstack 0.15.17

First paragraph.

Second paragraph.

## Config-home port correction (#120)

Not part of the 1.6.0 notes.

## 1.5.0 syncs to Cursor pstack 0.15.5

Older entry.
"""

RELEASED = CHANGES.replace("## Unreleased\n\n- Pending entry.\n\n", "")

GOOD = Facts(version="1.6.0", changes=RELEASED, clean=True, head="a" * 40, origin_main="a" * 40, unreleased=False,
             section_error=None, tag_exists=False, pr_head="b" * 40, live_gate="success", same_tree=True)


class ReleaseNotes(unittest.TestCase):
    def test_anchor_matches_github(self):
        for heading, expected in GITHUB_ANCHORS:
            self.assertEqual(anchor(heading), expected, heading)

    def test_notes_hold_only_the_version_section_and_link_to_it(self):
        self.assertEqual(
            notes(CHANGES, "1.6.0"),
            "First paragraph.\n\nSecond paragraph.\n\n"
            "Full entry: [CHANGES.md, 1.6.0](https://github.com/ericlitman/open-pstack/blob/v1.6.0/CHANGES.md"
            "#160-syncs-to-cursor-pstack-01517).\n",
        )

    def test_version_must_match_a_whole_heading_word(self):
        with self.assertRaisesRegex(ValueError, "0 sections for 1.6"):
            version_section(CHANGES, "1.6")
        with self.assertRaisesRegex(ValueError, "0 sections for 1.6.0"):
            version_section("## 1.6.0.1 later\n\nText.\n", "1.6.0")

    def test_missing_duplicate_and_empty_sections_fail(self):
        with self.assertRaisesRegex(ValueError, "0 sections for 2.0.0"):
            version_section(CHANGES, "2.0.0")
        with self.assertRaisesRegex(ValueError, "2 sections for 1.6.0"):
            version_section("## 1.6.0 a\n\nOne.\n\n## 1.6.0 b\n\nTwo.\n", "1.6.0")
        with self.assertRaisesRegex(ValueError, "is empty"):
            version_section("## 1.6.0 a\n\n## 1.5.0 b\n\nText.\n", "1.6.0")

    def test_unreleased_section_is_detected(self):
        self.assertTrue(has_unreleased(CHANGES))
        self.assertFalse(has_unreleased(CHANGES.replace("## Unreleased", "## 1.6.1 next")))


class PublishRefusals(unittest.TestCase):
    def test_verified_clean_release_has_no_refusals(self):
        self.assertEqual(refusals(GOOD), [])

    def test_each_unsafe_state_refuses(self):
        cases = {
            "uncommitted": GOOD._replace(clean=False),
            "is not origin/main": GOOD._replace(origin_main="c" * 40),
            "Unreleased section": GOOD._replace(unreleased=True),
            "0 sections for 1.6.0": GOOD._replace(section_error="CHANGES.md has 0 sections for 1.6.0; expected one"),
            "already exists": GOOD._replace(tag_exists=True),
            "not a merge commit": GOOD._replace(pr_head=None, live_gate=None, same_tree=False),
            "live-gate on PR head bbbbbbbbbbbb is failure": GOOD._replace(live_gate="failure"),
            "live-gate on PR head bbbbbbbbbbbb is missing": GOOD._replace(live_gate=None),
            "tree differs": GOOD._replace(same_tree=False),
        }
        for expected, facts in cases.items():
            found = refusals(facts)
            self.assertEqual(len(found), 1, (expected, found))
            self.assertIn(expected, found[0])


class Publish(unittest.TestCase):
    def publish(self, facts):
        with mock.patch.object(release, "gather", return_value=facts), \
                mock.patch.object(release, "run") as run, \
                mock.patch.object(release.subprocess, "run") as gh:
            code = release.publish()
        return code, run.call_args_list, gh.call_args_list

    def test_tags_the_live_gated_pr_head_not_head(self):
        code, git_calls, gh_calls = self.publish(GOOD)
        self.assertEqual(code, 0)
        self.assertEqual(git_calls[0].args, ("git", "tag", "-a", "v1.6.0", "-m", "Open Pstack 1.6.0", GOOD.pr_head))
        self.assertEqual(git_calls[1].args, ("git", "push", "--quiet", "origin", "refs/tags/v1.6.0"))
        self.assertIn("v1.6.0", gh_calls[0].args[0])

    def test_refusal_writes_nothing(self):
        code, git_calls, gh_calls = self.publish(GOOD._replace(live_gate="failure"))
        self.assertEqual((code, git_calls, gh_calls), (2, [], []))


class Gather(unittest.TestCase):
    def test_every_fact_comes_from_the_captured_commit(self):
        head, pr_head = "a" * 40, "b" * 40
        outputs = {
            ("git", "fetch", "--quiet", "--tags", "origin", "main"): "",
            ("git", "rev-parse", "HEAD"): head,
            ("git", "show", f"{head}:CHANGES.md"): RELEASED,
            ("git", "show", f"{head}:{release.MANIFEST}"): '{"version": "1.6.0"}',
            ("git", "rev-parse", f"{head}^2"): pr_head,
            ("gh", "api", f"repos/{release.REPO}/commits/{pr_head}/status",
             "--jq", '.statuses[] | select(.context == "live-gate") | .state'): "success",
            ("git", "status", "--porcelain", "--untracked-files=all"): "",
            ("git", "rev-parse", "origin/main"): head,
            ("git", "ls-remote", "--tags", "origin", "refs/tags/v1.6.0"): "",
            ("git", "rev-parse", f"{head}^{{tree}}"): "t" * 40,
            ("git", "rev-parse", f"{pr_head}^{{tree}}"): "t" * 40,
        }
        succeeds = {("git", "rev-parse", "--verify", "--quiet", f"{head}^2")}
        calls = []

        def run(*args):
            calls.append(args)
            return outputs[args]

        def ok(*args):
            calls.append(args)
            return args in succeeds

        with mock.patch.object(release, "run", side_effect=run), mock.patch.object(release, "ok", side_effect=ok):
            facts = release.gather()
        self.assertEqual(facts, GOOD._replace(head=head, origin_main=head, pr_head=pr_head))
        after_capture = calls[calls.index(("git", "rev-parse", "HEAD")) + 1:]
        self.assertFalse([call for call in after_capture if any("HEAD" in arg for arg in call)])


if __name__ == "__main__":
    unittest.main()
