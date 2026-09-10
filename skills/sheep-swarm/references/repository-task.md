# Repository task manifest

Create this JSON outside or inside the target repository. Adjust exports, instructions, and fixed test names to the actual task before making calls.

```json
{
  "version": 1,
  "goal": "Clamp negative values to zero without changing nonnegative values",
  "files": [{
    "path": "src/value.mjs",
    "instructions": "Preserve existing exports. Negative input returns zero; nonnegative input is unchanged.",
    "checks": [{"argv": ["node", "--check", "src/value.mjs"]}]
  }],
  "context": ["README.md"],
  "protected": ["tests/value.test.mjs"],
  "checks": [{"argv": ["node", "--test", "tests/value.test.mjs"], "timeoutMs": 30000}]
}
```

`protected` files are mandatory, fixed host inputs; include all test/config/script paths that define acceptance and keep them out of `files`. They are not shown to workers unless explicitly also selected as `context`. Full snapshot bytes stay with host checks; only targets, selected context, goal and guidance enter model prompts. `dependsOn` lists other target paths, and must form an acyclic graph. Task instructions do not replace the destination's AGENTS.md: the coordinating agent reads it and selects relevant constraints first.

Checks are argv arrays executed without an implicit shell. For Python, e.g. `["python3","-B","-m","unittest","discover","-s","tests"]`. Timeouts default to 30000 ms, maximum 300000. No automatic dependency install. Commands may generate additional build files, but must not alter original candidate inputs; those extra outputs are not adopted. Credentials are not inherited by check subprocesses. These commands run on the host, so choose trusted commands appropriate to the repository.

Candidates contain no `.git`, and Git discovery stops before ancestor checkouts. Do not use `git diff --check` in the manifest as if it validates the copied candidate. Arrange checks that need Git history separately. On POSIX, each check's remaining process group is terminated even after a successful exit; checks cannot leave a background service running for later commands. Detached sessions and Windows process trees are outside this cleanup guarantee.

Failed local checks send up to 8192 characters of stdout/stderr to repair workers. Command spawn failures and candidate-storage I/O errors stop further worker and upper calls after already issued calls settle; they are recorded as `executionFailure`. Diagnose the host environment instead of spending semantic retries on it.

The final combined check is authoritative. Per-file checks may be omitted (structural validation only); a local commit then does not establish task success. Choose local checks when useful for worker repair feedback. A final-only failure stops the run and is preserved, rather than weakening the oracle or launching another run automatically.

Default execution leaves the source unchanged. `--apply` writes only selected accepted targets after known settled usage and HEAD/bytes/modes/tracked-set/new-target collision checks. It preserves dirty bytes captured at start and unrelated untracked work. This is not crash recovery or a concurrent filesystem transaction. Deletion/rename tasks require a different adapter; this manifest writes complete UTF-8 file contents.

For limits and CLI options inspect the verified checkout's `docs/repository-runner.md` and `node src/repo-cli.ts --help`.
