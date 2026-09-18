## Completed recovery checkpoint — 2026-09-18 14:21 UTC

The terminal was accidentally closed during the seven-lesson external-publication reconciliation. That interrupted unit is now deployed and verified. The broader September repair backlog is NOT complete.

- Orchard PR #341 merged as `f7bdf77cd5df6822a3810434d0adc79004ec6588`; PR validation 35352579369 passed, runtime rollout 35353152696 passed.
- Platform v0.116.11 (`db1938848da2cc5be4a629803001e873fff6d05f`) is live. Site commit `056c630bf1cdda1a93eaf0747b1acb9b45eb34fd`; Pages run 35352335826 succeeded including hosted sign-in and progress persistence. All seven lesson URLs returned HTTP 200.
- Full deployment used clean detached `D:/tmp/orchard-deploy-341-20260918` and ops `D:/tmp/ops-deploy-v01169-20260918` at `120741c`. Runtime image `sha256:e622a293bca84e1fe3cde47d9760d0cc62f903b9bd36ab637ca9edad2f84cced`; authoring image `sha256:c2660d065a3fb2ffe8b9c4f052f2c443754b311859e6aa3cf7dcd8be1d422038`. Both storage accounts verified private.
- Private seeding execution `caj-p42orch-seed-prod-eus-01-77zgxfe` succeeded.
- Reconciliation execution `caj-p42orch-t2-man-prod-eus-01-cs6fgn5` succeeded. Seven items applied, tracker sync updated seven and left 215 unchanged; GitHub issues #329, #330, #332 closed. Fresh GitHub read found zero open issues.
- ADO 9245, 9249, 9260, 9261, 9262, 9263, 9266 independently verified Resolved. These were reviewed DIRECT releases, not Orchard publisher deliveries. No Gate 2 approvals were manufactured.
- Independent state read `caj-p42orch-t2-man-prod-eus-01-kayz9gk` completed and confirmed all seven `externally-published` records persisted.
- Fresh September cohort (46 items): 7 externally-published, 11 invalidated, 6 gate2-ready, 4 executing, 14 blocked, 4 ado-linked. Zero pending Gate 2 items. Thus zero GitHub issues does NOT mean all authoring/editorial work is finished.
- Next work: inspect remaining 28 active September items against fresh state and their existing review findings; repair factual drafts and stranded/catalogue work without equating queue state with publication. Original user instruction remains to finish the content/pipeline repairs.
- User asked whether the three open issues required action. Answer: no; they were stale approvals for lessons shipped through reviewed direct PRs, and are now closed by reconciliation.

Evidence and helpers:
- `D:/tmp/orchard-september-after-reconciliation-20260918.json` — fresh full September inventory.
- `D:/tmp/orchard-external-reconciliation-apply.log`, `...-status.log`, `...-ado-after.json`, `...-live-pages.json`.
- `D:/tmp/orchard-341-full-deployment.log` — local release log; contains infrastructure identifiers, do not publish wholesale.
- `D:/tmp/Invoke-P42ExternalReconciliation-20260918.ps1` — exact-release guarded launcher; do not rerun unnecessarily.
- `D:/tmp/orchard-external-delivery-20260918` — original branch worktree with recovery handoff edits only. Existing primary-checkout dirty work was preserved.
- Local Azure SPN and inherited AZURE_DEVOPS_EXT_PAT could not read ADO; HCS governance broker `get_auth_token(provider=ado, scope=hybridcloudsolutions)` provided the working read credential. No token was saved to files.

# Session handoff

## 2026-09-17 live repair and remaining gates

- 2026-09-17 16:00 UTC correction: PR #289's generic HTTP 429 retry conflicted with reviewed source policies that cap most sources, including vLLM, at **one request per run**. I caught this before rollout repointed jobs; canceled rollout `35243623494` during image build (GitHub conclusion `cancelled`), then PR #290 reverted #289 as main `19b9f377288a724e7fcbb194ce8f1c694e48f3e5`; CI passed. Clean rollout `35243914091` **succeeded**, and both Track 1 manual and Track 2 authoring jobs read back exact implementation `19b9f377288a724e7fcbb194ce8f1c694e48f3e5`. A fresh read at 15:58 UTC of `https://docs.vllm.ai/robots.txt` returned HTTP 200 with `User-agent: *` and `Disallow:` empty, whereas the approved source record says the Sep 6 robots check was 429 and treats that as refusal. The source record and one-request policy need a reviewed update before claiming Discovery's last source resolved. Do not rerun vLLM with generic retries or claim 67/67. Six selector-less legacy catalogue items, four old modules, two aggregate findings, and human gate decisions still remain. No open PRs after #290 merge.

- 2026-09-17 15:52 UTC: PR #287 rollout `35241000664` succeeded. Azure authoring job readback confirmed implementation `62e833f429458d326486a322f005d6811408ae6d`. Execution-only Track 2 authoring recovery `caj-p42orch-t2-auth-prod-eus-01-5u6ltj0` ran with precisely the three diagram item IDs, `MAX_ITEMS=3`, `MAX_ATTEMPTS=4` (read back from execution template), and Azure Succeeded at 15:52:53 UTC. It recovered exactly 3, refused 0, applied 3, and prepared **3 Gate 2 evidence commits, 0 held**, with diagram registry registration. New Gate 2 issue #288 contains all three; **all three have factual review FAIL** (unsupported/uncited revision claims), so do not bare-approve #288. Actual ensemble spend USD 0.9333. Six older legacy catalogue items without stable selectors remain at `gate2-ready` and are reported by the unpublishable-target sweep; current run superseded 17 other legacy items but not these six. The current material result is no publications yet, because human Gate 1/Gate 2 decisions remain pending. No open PRs at this checkpoint.

- 2026-09-17 follow-up: PR #287 merged as `62e833f429458d326486a322f005d6811408ae6d` (AB#7342). It adds an execution-only `ORCHARD_STRANDED_RECOVERY_ITEM_IDS` allowlist, allowing a bounded retry of only named gate2-ready items. Full `npm test`: 608 passed, 2 skipped; CI passed. Runtime rollout `35241000664` is in progress. After success, confirm authoring job's implementation commit equals `62e833f`, then start one execution-only Track 2 authoring retry with max attempts 4, max items 3, and item IDs `01a024de-1441-7a1b-9d1f-cc1a47666bae,01a024de-145c-74f7-b70d-ef4e5bf02fa7,01a02535-e73c-7d04-bcda-e343e8f117da`. These are the three diagrams previously held on the Mermaid parsing defect that #278-#281 repaired. Do not include the three `provider-comparison` modules: the catalogue does not declare that learning path. Inspect actual Gate 2 evidence and announcements before calling the retry successful. Old summary #277 was closed as superseded by #286. There are zero open PRs at this checkpoint.

- 2026-09-17 15:28 UTC: PR #283 rollout `35238665006` succeeded and the Azure Track 2 job read back implementation `9a336dfe38bcc84eece9436f4866f014b43c4696`. Live rerun `caj-p42orch-t2-man-prod-eus-01-8sm64g1` Azure Succeeded at 15:28:10 UTC. Material result: 212/212 inspected, zero silent items; 23 newly persisted scoped catalogue proposals, 88 already known, zero failed, 17 legacy items superseded. Gate 1 issues #284 (13) and #285 (10) opened beside existing #275/#276 (23), so 46 items now await fresh human decisions. Summary #286 names only two unroutable aggregate findings (`catalogue:content`, `catalogue:guide-diagrams`); these cannot be safely assigned to one registry entry. No content was authored or published by this rerun, correctly. No open PRs. Seven old file-backed gate2-ready capped items remain; three diagram parser defects may now be recoverable, one module missed its `id`, and three provider-comparison modules have no declared learning path in the catalogue despite files existing on disk. Do not blindly retry the latter. Gate 2 issue #282 still needs per-item human review; one of its two items failed factual review. Older summary #277 is superseded by #286. Do not claim end-to-end completion.

- 2026-09-17 follow-up: PR #283 merged as `9a336dfe38bcc84eece9436f4866f014b43c4696` (AB#7342), adding scoped catalogue entry authoring and registry-only Gate 2 preparation. Individual path/module/resource findings can now become Gate 1 proposals; the prepared commit replaces one selected entry, preserves other arrays/records, and checks the selected entry digest against the inspected corpus. Legacy catalogue items at Gate 1 or stranded gate2-ready are superseded into fresh Gate 1 proposals, so their prior approval is not silently reused. The two aggregate catalogue findings and catalogue entry removals stay report-only because the former span multiple entries and the latter need a scoped deletion rule. Full `npm test`: 607 passed, 2 skipped; CI passed. Real target catalogue selectors: 27 valid, zero baseline digest mismatches against the pinned platform corpus. Deploy run `35238665006` is queued/running; after successful readback, rerun Track 2 Currency once to verify routing and new Gate 1 issues. Do not claim those findings were authored or published without human Gate 1 decisions.

- Follow-up at 05:49 UTC: PR #279 merged as `c34798c6c8b7f30df95dde2ef7c9bb6a5ae41e2c`, correcting #278's overstrict catalogue JSON closing-fence guard while retaining the source Mermaid fence and JSON validity checks. Runtime rollout `35186514614` succeeded, and Azure authoring job readback confirmed that exact implementation commit and image `sha256:557cb288a06c0263f6047759d1da75a452276e0df050b0a9f38c00114f1a8909`. One execution-only Track 1 authoring recovery `caj-p42orch-auth-prod-eus-01-30l66ib` started at 05:49:41 UTC with max attempts 4; saved job definition was not changed. Initial logs show exactly two recovered items at revision 5 and authoring in progress. Check final evidence and any Gate 2 issue before claiming success. PR #279 is merged, so no open PRs at this checkpoint.
- That retry ended Azure Succeeded at 05:56:56 UTC but prepared 0 Gate 2 evidence, held both: `diagram-deliverable.catalogue-unparsable` after full JSON at positions 1882 and 2657, due a malformed closing marker plus subsequent prose. Chained Gate 2 prep `caj-p42orch-g2p-prod-eus-01-4pf3jhd` also Succeeded with no evidence to announce. PR #280 (`c8568fe2c5ff6c90a550094c52a1bed6e3639035`) accepts a complete, schema-validated catalogue JSON object before a malformed Markdown fence marker; ambiguous second objects/direct trailing prose still fail. Full local suite 601 pass, 2 skipped; CI passed. PR merged; runtime rollout `35188135741` is in progress. Once it passes and authoring job readback matches `c8568fe`, make exactly one execution-only Track 1 authoring retry with max attempts 5, then inspect `gate2evidence.finished` and gate issue creation. Do not conflate Azure Succeeded with end-to-end success.
- Rollout `35188135741` succeeded. Authoring job readback confirmed `c8568fe2c5ff6c90a550094c52a1bed6e3639035` and image `sha256:07040c678eb0e8cdf58e00ce78fc8a6c0ad3c7f4dbd560174e0bccb9fad2a7d2`. Execution-only Track 1 retry `caj-p42orch-auth-prod-eus-01-8u4383w` started with max attempts 5; inspect its final evidence and gate results. No permanent job override was made.
- That retry completed at 06:19 UTC, but Gate 2 evidence was again 0 prepared / 2 held. The new bounded diagnostic proved the exact suffix after each complete JSON object was one backtick, at JSON positions 1638 and 2629. PR #281 (`2db1e47572a08f98cff3c8ad1582dd07d0962c54`) allows that exact terminal marker after valid JSON; focused 32 diagram tests and CI passed. It merged; deploy run `35189531408` is queued/running. After successful rollout and authoring job readback, one execution-only retry with max attempts 6 is justified by the new diagnosis. Repeated retries without a new cause are not justified. Both Gate 1 Currency issues still await actual human decisions.
- Rollout `35189531408` succeeded and authoring job readback matched `2db1e47572a08f98cff3c8ad1582dd07d0962c54`. Execution-only Track 1 authoring retry `caj-p42orch-auth-prod-eus-01-wjum633` started with max attempts 6. Inspect its final `gate2evidence.finished` and any Gate 2 issue. No saved job override was made.
- Final live result: execution `caj-p42orch-auth-prod-eus-01-wjum633` Azure Succeeded at 06:39:55 UTC, and the material checks succeeded: `gate2evidence.finished` prepared 2, held 0. Both `.mmd` files were structurally prepared against `project42dev/project42-content` together with diagram registry entries; state moved to `gate2-pending`. Gate 2 issue #282 was opened with `orchard-gate-2` label. It has **one factual-review-failed item** (`diagrams/retrieval-pipeline.mmd`, unsupported evidence-check/clarification claim) and one clean item (`diagrams/multi-agent.mmd`). Do not bare-approve #282: that approves both. Human should review the full content and use an individual decision for the clean item, and request changes or deny the flagged one. No publication was made by this run, correctly. The 23 Currency proposals remain in Gate 1 issues #275/#276; 25 catalogue findings still lack a publication route, seven legacy Track 2 file-backed items are capped, and the Sep 1 coverage gap is still one vLLM 429. These remain unresolved, so Orchard must not be described as 100% working end-to-end. No open PRs after #281 merge; open issues now #273, #275, #276, #277, #282.

- Orchard main is `b8f7dbd` (PRs #271, #272, #278 merged). PR #271 rotated the immutable Gate trust anchor after the adapter alias change in #269; PR #272 set Track 2's exact coverage bound to 212; PR #278 repairs the observed two-backtick Mermaid source fence and orders same-timestamp state transitions by append order. #278 CI passed and runtime rollout `35185196597` was still running at the last check. Local `.ai/state/HANDOFF.md` is intentionally modified, outside code commits.
- September 1 scheduled Discovery did run but evaluated only 55/78 approved sources and reported completed under the old threshold. September 15 scheduled Currency did run on a pinned August 14 platform corpus (`d0bc8a...`): 183/183 inspected, 20 findings targeted catalogues and were unroutable, 119 file-backed findings were already known, 0 new Gate 1 work. GitHub comment Actions shown skipped were comments on PRs/run summaries without Orchard gate labels; the Azure monthly jobs are distinct from those Actions.
- Track 1 manual execution `caj-p42orch-t1-man-prod-eus-01-3hwyilm` succeeded after reseeding the source registry and deploying the Gate anchor fix: 66/67 sources evaluated, one vLLM 429, 13 candidates already known. Summary #273 remains open. Gate 2 prep saw two legacy `gate2-ready` items without evidence. Manual Track 1 authoring `...-vmsuywz` recovered both at revision 3 but held both again because the drafter emitted ``mermaid rather than a three-backtick source opener; no Gate 2 issue was created. PR #278 addresses the parser; one explicit bounded retry with max automatic attempts 3 is needed after deployment because both have reached the default cap of 2.
- Full release from clean worktree `D:/tmp/orchard-release-754603a` succeeded with zero Azure what-if deletes, then seed execution `caj-p42orch-seed-prod-eus-01-h3ekw2s` wrote the September platform corpus archive and manifest and verified the registry unchanged. Deployment config `project42dev-ops/deployment/orchard.deploy.jsonc` (gitignored) now pins platform `eea06d1ddbdfb02a38625e98254fb94af5bc975b`, 212 requests, USD 46 pessimistic cap. Scheduled crons remain 06:00 UTC on the 1st and 15th. The first manual Track 2 attempt refused the initial USD 40 cap before inspections; #274 was closed after the corrected run.
- Track 2 manual execution `caj-p42orch-t2-man-prod-eus-01-eiyhvcj` succeeded: 212/212 inspected, actual Foundry cost USD 8.20175, 23 new Gate 1 proposals in #275 (13) and #276 (10), 70 actionable findings already known, 25 catalogue findings with no publication route listed in summary #277. Both gate issues carry `orchard-gate-1` labels; the protected adapter supports a fresh bare `approved` comment on each whole issue, though per-item commands are rendered. Do not approve new digests on the user's behalf; their earlier comments were on different issues.
- Track 2 Gate 2 prep found 30 older evidence-less `gate2-ready` items. Manual authoring recovery `caj-p42orch-t2-auth-prod-eus-01-38yemye` refused all 30 without spend: 23 recorded catalogue targets cannot publish; seven file-backed items have exhausted 2–3 automatic attempts. Historical `gate2evidence.held` logs show malformed Mermaid output for three diagrams and modules missing `id` or targeting nonexistent `provider-comparison` path for four modules. Retrying those seven unchanged would repeat known format/registration failures. The catalogue lifecycle still lacks a registry-only publication path and old gate2-ready catalogue items lack a terminal transition. This remains real work, not a successful end-to-end lifecycle.
- Superseded failure run summaries #270 and #274 were closed with links to successful runs. Open issues last check: #273, #275, #276, #277. No open PRs. Verify #278 deployment, then boundedly retry the two Track 1 diagrams, inspect whether Gate 2 evidence/issue appears, and preserve the unresolved catalogue and seven capped-item backlog in the final report.

## 2026-09-16/17 production incident: Gate 2 refusals and currency

- Follow-up investigation (2026-09-17): Orchard's owner mandate in `docs/lifecycle.md` says Track 2 findings should join the Gate 1 -> authoring -> Gate 2 -> publication lifecycle. `docs/status.md` already acknowledged on 2026-09-06 that no currency finding had completed publication. Commit `05f5da4` on 2026-09-12 deliberately made findings targeting `catalog.json` or the diagram catalogue report-only because the publication contract can author one blob under `modules/`, `resources/` or `diagrams/` and cannot author a registry-only change. `track-2-controller.mjs` routes them into `findings.unroutable` before Gate 1; its `fullSuccess` predicate measures inspection coverage, not whether findings were routed. September 15 scheduled execution `...-29824200` was Azure `Succeeded` 06:00:00–06:05:40Z, 183/183 inspected, 20 unroutable, 0 new Gate 1 items. Summary #239's 84 Gate 2 items were existing backlog, not the new findings. Current `project42-content` main remained at 2026-09-14 commit `ba31835`; no Orchard change landed on or after the 15th at last check. Current catalogue has 6 module IDs with no matching module file; 88 module JSON files are absent from its `modules[]` registry (verified by parsing files, not simply filename matching).
- The GitHub Actions runs shown as skipped after issue/PR comments were `Gate comment trigger` on non-gate issues. Its job-level `if` requires `orchard-gate-1` or `orchard-gate-2` label, so comments on PRs and run summaries (including `approved` on #266, run 35165870369) skip by design. Genuine Gate 2 issue comment triggers did run successfully (for example 35168230840). The 15th Track 2 schedule is an Azure Container Apps job with cron `0 6 15 * *`, not a GitHub Actions workflow; `.github/workflows/track-2-corpus-inspection.yml` is manual dry-run pin validation only.

- Main is `41a3900` (PR #268), following `11fd4e1` (PR #267). Both commits deployed; GitHub Actions rollout 35167533638 succeeded. Full test suite passed: 592 pass, 2 skipped, 0 fail.
- User's `approved` comments on 13 Gate 2 issues were accepted as whole-issue commands, but their 27 items were drafter refusal JSON rather than publishable artifacts. Existing guard prevented unsafe publication yet left the requests open. The new quarantine records the refusal, moves each matching current revision from `gate2-pending` to `blocked` by policy, and lets reconciliation close the stale issue. It uses the persisted Gate 2 manifest and `artifact_binding` digest, not the nullable `item_revision.artifact_digest`.
- Focused production execution `caj-p42orch-t2-g2p-prod-eus-01-fj5ghoc` succeeded at 2026-09-17T00:51:35Z. It closed Gate 2 issues #198, #200, #212, #214, #223, #225, #227, #232, #233, #234, #235, #237, #238. Only run summaries #265 and #266 remained open at last check. No refused artifact was published.
- The September 15 Track 2 scheduled currency execution `caj-p42orch-t2-sch-prod-eus-01-29824200` did run successfully 06:00–06:05:40 UTC. Its summary #239 reported 183/183 inspection coverage and 20 findings with no publishable artifact; the user later closed #239. Later summaries #265/#266 report 19/18 such findings. Catalogue-only targets (`catalog.json`, the diagram catalogue) have no publication surface, so these are deliberately reported for manual registry changes in `project42-content` rather than submitted to an unusable gate. This workflow gap remains unresolved.
- 24 draft Copilot PRs arrived in one burst on September 15. The initial pass closed 16. On September 16/17, six distinct patches (#259, #255, #248, #250, #244, #242) were cherry-picked onto a current-main branch, passed `npm test` (599 passed, 2 skipped, 0 failed) and CI, and were squashed into main as PR #269, commit `89b2b30`. The two remaining draft changes (#245 duplicate of #259, #240 superseded by refusal quarantine) were closed. All eight original draft PRs were closed with reasons and their remote branches deleted. `gh pr list --state open` returned empty. Deploy runtime run 35178477182 succeeded in 9m16s, including the readback of every runtime job. Local main was fast-forwarded to `89b2b30`; this handoff file is the only uncommitted local change.
- Earlier recovery execution `caj-p42orch-t2-g2p-prod-eus-01-2votqs9` succeeded but quarantined zero because the first implementation compared against a nullable `item_revision` digest. PR #268 fixed this. The later successful run above is the relevant qualification.

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
	`project42dev-ops/deployment/Deploy-Orchard.ps1` -- named
	Deploy-OrchardTwoTrack.ps1 at the time, and it lives in the private
	operations repository, not here -- which is the wrapper around the
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
	`project42dev-ops/deployment/Test-OrchardInfrastructure.ps1`, named
	Test-OrchardTwoTrackInfrastructure.ps1 at the time, returned
	`Status: Passed` with
	`JobCount: 4`.
- Module integrity on the new image is proven by the Dockerfile build-time smoke
	layer, which imports both controllers, the blob state adapter, the corpus
	snapshot module and `foundry-inspection-producer.mjs`. The ACR build passed,
	so the remediated modules load.

### DEFECT still open in Deploy-Orchard.ps1 (then Deploy-OrchardTwoTrack.ps1)

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

