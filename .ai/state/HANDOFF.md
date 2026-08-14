# Session handoff

## 2026-08-13 current transfer state

### Repositories and publication

- Orchard worktree: `D:/git/project42dev/worktrees/orchard-two-track-lifecycle`.
- Orchard branch: `feat/orchard-two-track-lifecycle`.
- Orchard implementation HEAD: `28b9f36040d9e40e28c53966ace9b1052ede5a10`
	(`fix(orchard): bound production result telemetry AB#7342`).
- Live remote verification confirmed
	`origin/feat/orchard-two-track-lifecycle` is at the same implementation
	commit. The only expected local Orchard change after this transfer is this
	handoff file.
- Operations repository: `D:/git/project42dev/project42dev-ops`.
- Operations branch: `feat/orchard-two-track-delivery`.
- Operations HEAD: `ec502772c65e33d96e49b17dc9ad6d35919f7547`
	(`feat(orchard): publish two-track delivery package AB#7342`).
- The operations branch is PUSHED as of 2026-08-13. Live `ls-remote` confirms
	`origin/feat/orchard-two-track-delivery` at
	`ec502772c65e33d96e49b17dc9ad6d35919f7547`. The commit was inspected first:
	no credential signature, and the 6 em-dashes it contains match pre-existing
	prose in that repository. `main` was not touched.

### Production qualification

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

### Source remediation and validation

- Non-dry controllers now fail closed unless an explicit output file is bound.
	The Azure runtime always supplies that file and emits only bounded aggregate
	Foundry usage telemetry.
- Aggregate token and configured-rate cost logic is order-independent, validates
	safe token counts, and has asymmetric-rate behavioral coverage.
- Full validation passed 160 Node tests with zero failures. Focused production
	contracts passed 28 tests. `git diff --check` passed, editor diagnostics are
	clear, and independent review reported no blockers.
- The operations infrastructure contract passed with four jobs. Target,
	network-foundation, budget, and Foundry-role Bicep templates compiled with
	zero diagnostics. Both Bicep parameter files also compiled with zero
	diagnostics. Every staged JSON document parsed, staged secret scanning found
	no credential signature, and the operations commit contains 70 intended
	Orchard package files.
- Sanitized production evidence is at
	`D:/git/project42dev/project42dev-ops/deployment/evidence/orchard-track2-production-qualification-2026-08-13.json`.
- The telemetry remediation is committed and pushed but is not deployed. Do not
	claim that historical Log Analytics content was deleted or that production is
	already running the remediation.

### Telemetry remediation deployed 2026-08-13

- The remediation is no longer undeployed. Commit
	`28b9f36040d9e40e28c53966ace9b1052ede5a10` was built and released through
	`deployment/Deploy-OrchardTwoTrack.ps1`, which is the wrapper around the
	Bicep templates `orchard-two-track-network-foundation.bicep` and
	`orchard-two-track-target.bicep`.
- Deployed image digest is now
	`sha256:e353a8451e9a39ec2a4f72e98b7eebb203deb41afe303557b4996a010068289f`.
	Both `caj-orch-t2-man-prod-eus-01` and `caj-orch-t2-sch-prod-eus-01` were
	confirmed on that digest by direct query, not by trusting script output.
- The build ran from a clean detached worktree at
	`D:/tmp/orchard-runtime-28b9f36040d9` because the script refuses to build
	from a dirty tree. The two uncommitted files in the branch worktree are this
	handoff and a CI workflow, neither of which is runtime code.
- Verified after release: state storage back to `publicNetworkAccess: Disabled`
	with `defaultAction: Deny` and no IP rules, zero Track 1 jobs, and
	`Test-OrchardTwoTrackInfrastructure.ps1` returned `Status: Passed` with
	`JobCount: 4`.
- Module integrity on the new image is proven by the Dockerfile build-time smoke
	layer, which imports both controllers, the blob state adapter, the corpus
	snapshot module and `foundry-inspection-producer.mjs`. The ACR build passed,
	so the remediated modules load.

### DEFECT still open in Deploy-OrchardTwoTrack.ps1

- The script grants the bootstrap principal `Storage Blob Data Contributor` in
	the bootstrap deployment and then uploads the corpus immediately at line 153
	with no wait or retry for Azure RBAC propagation. The first release attempt
	failed there with an authorization error.
- The consequence is worse than a failed run. The throw happens BEFORE the role
	removal at line 159 and before the private target deployment at line 166, so
	a failure at this point leaves state storage reachable with
	`publicNetworkAccess: Enabled` and `defaultAction: Allow`. That state was
	observed and was closed only by re-running the script.
- Fix by retrying the upload with backoff, or by wrapping the bootstrap window
	in `try/finally` so the private lockdown always runs. Until then, anyone
	whose release fails mid-script must immediately confirm storage lockdown.

### Track 2 execution on the new image is NOT proven

- Deployment is verified. An actual Track 2 run on
	`sha256:e353a845...` has not happened.
- `ORCHARD_RUN_MODE=dry-run` does NOT avoid Foundry spend. In `runAzure` the
	Track 2 branch always calls `produceInspectionResultFile` with the real
	producer; the mode only decides whether controller output goes to stdout or
	to a file. Do not treat a dry run as a free rehearsal.
- `caj-orch-t2-sch-prod-eus-01` is armed with cron `0 6 * * 6` and will perform
	a full unattended paid run on Saturday 2026-08-15 06:00 UTC against this
	image, capped at `ORCHARD_MAX_FOUNDRY_SPEND_USD=34.00` and 183 requests. It
	has never executed. Either accept that as the first scheduled-path test or
	suspend the trigger.

### Governance state and next actions

- AB#7342 evidence was appended and live-verified at revision 5; it remains Active.
- Protected-main acknowledgement, owner acceptance, PR merge, deployment of the
	telemetry remediation, and ADO closure are not complete and must not be
	claimed.
- Do not rerun the paid Track 2 qualification, expose private Blob Storage,
	delete historical telemetry, rotate credentials without authorization, merge
	to a protected branch, or close AB#7342.
- The previous next action, pushing `feat/orchard-two-track-delivery` and
	live-verifying the remote head, is DONE. Do not repeat it.
- Next action: decide the Saturday scheduled run, fix the bootstrap-window
	defect above, and open the pull requests. If commit hashes are added to
	AB#7342, use the Azure DevOps REST API with an Entra token (the CLI extension
	previously failed decoding output), add completion-quality evidence, and keep
	the work item Active.
- After publication, obtain the still-missing protected-main and owner gates
	through the real governance path. Never infer or fabricate those approvals.
