# Session handoff

## 2026-08-13 production qualification checkpoint

- Worktree: `D:/git/project42dev/worktrees/orchard-two-track-lifecycle`.
- Branch: `feat/orchard-two-track-lifecycle`.
- Production content pin: `38178e39fb2a68fda7400bb6390c9c271621ef9d`.
- Deployed runtime commit: `d89fb68148e7b2070e8d9309d0ec6b9b874b543b`.
- Deployed image: `sha256:9863c0a61322c6ee02db9f77f823a9a22d5a427ae1feac8ae36c2218df725fbe`.
- Production Track 2 execution `caj-orch-t2-man-prod-eus-01-0npplji` succeeded from
	`2026-08-13T14:11:33Z` through `2026-08-13T14:16:25Z` with exact 183/183
	coverage, zero gaps, 183 distinct outcomes, and zero exceptions.
- Azure Monitor reported 2,145,026 input tokens and 50,450 output tokens for
	deployment `gpt-5-6-sol` over the execution window. At the deployed rates of
	USD 5 and USD 30 per million input and output tokens, configured-rate cost is
	USD 12.238630. This is deployment-and-window attribution, not per-response
	reconciliation.
- Private verifier execution `caj-orch-t2-man-prod-eus-01-hck60j9` succeeded.
	It independently verified manifest generation 1, fencing generation 10,
	matching state and backup SHA-256
	`d37f175f98efd445d4072e0c051d5e8cd939fd50871c744213baa5b0c96b66a7`,
	metadata, commit marker, SQLite integrity, zero foreign-key violations,
	schema version 5, and the completed 183-item run.
- A plaintext PAT discovered in ignored local configuration was revoked. Live
	verification found zero active PATs. No PAT rotation is claimed.

## Pending source remediation

- Non-dry controllers now fail closed unless an explicit output file is bound.
	The Azure runtime always supplies that file and emits only bounded aggregate
	Foundry usage telemetry.
- Aggregate token and configured-rate cost logic is order-independent, validates
	safe token counts, and has asymmetric-rate behavioral coverage.
- Full validation passed 160 Node tests with zero failures. Focused production
	contracts passed 28 tests. `git diff --check` passed, editor diagnostics are
	clear, and independent review reported no blockers.
- These source changes are not yet deployed. Do not claim that historical Log
	Analytics retention was removed or that production is already running the
	telemetry remediation.

## Governance state

- AB#7342 evidence was appended and live-verified at revision 5; it remains Active.
- Protected-main acknowledgement, owner acceptance, and ADO closure are not
	complete and must not be claimed.
- Commit and push only the intended telemetry remediation and handoff update.
