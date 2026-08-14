import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertUsage,
  assertAccountingIntegrity,
  assertAccountingReady,
  checkBeforeDispatch,
  createDeliveryAccounting,
  deliveryScopeDigest,
  factualInventoryDigest,
  qualificationDigest,
  recordDispatchResult,
  requiredDeliveryRoles,
  validateDeliveryChain,
  validateDeliveryConfiguration,
} from '../scripts/lib/delivery-policy.mjs';
import { createAgentHandoff, prepareGate2Item, validateHandoffChain } from '../scripts/lib/handoffs.mjs';

const runId = '018f0d20-7b9a-7cc3-8a5d-112233445566';
const itemId = '018f0d20-7b9b-7cc3-8a5d-112233445566';
const eventId = '018f0d20-7b9c-7cc3-8a5d-112233445566';
const digest = (character) => `sha256:${character.repeat(64)}`;
const policy = JSON.parse(await readFile(new URL('../config/delivery-policy.example.json', import.meta.url), 'utf8'));
const binding = {
  run_id: runId, track: 'track-1', item_id: itemId, item_revision: 1, proposal_digest: digest('a'),
  gate1_decision_event_id: eventId, ado_external_key: `orchard:track-1:${itemId}:r1`, ado_work_item_id: 5001,
  target: { repository: 'project42dev/project42-platform', path: 'content/item.md' },
};
const criterion = (name) => ({ name, measured_value: 1, threshold: 1, passed: true, evidence_ref: `qualification/${name}` });
const providers = {
  'evidence-researcher': 'provider-a', writer: 'provider-a', editor: 'provider-b',
  'factual-verifier': 'provider-b', 'accessibility-reviewer': 'provider-a',
  'assessment-reviewer': 'provider-c', 'diagram-reviewer': 'provider-c', 'final-reviewer': 'provider-c',
};
const identity = (role) => `${role}-model`;
const baseScope = { assessments_changed: false, diagrams_changed: false, human_assistive_review_required: true };
const accessibilityNames = ['structure', 'keyboard', 'captions', 'transcripts', 'text-alternatives', 'color-independence', 'zoom', 'reduced-motion'];
const roleEvidence = {
  'factual-verifier': {
    inventory: { complete: true, volatile_claim_ids: ['claim-1'], inventory_digest: factualInventoryDigest(['claim-1']) },
    claims: [{ claim_id: 'claim-1', status: 'supported', source: { primary: true, current: true, verified_at: '2026-08-10T00:00:00Z', evidence_ref: 'sources/primary-1' } }],
  },
  'accessibility-reviewer': {
    checks: accessibilityNames.map((name) => ({ name, applicable: true, status: 'passed', evidence_ref: `a11y/${name}` })),
    human_review: { required: true, status: 'passed', evidence_ref: 'a11y/assistive-technology' },
  },
  'assessment-reviewer': { status: 'passed', evidence_ref: 'assessment/review', checks: [{ name: 'answer-validity', status: 'passed', evidence_ref: 'assessment/check' }] },
  'diagram-reviewer': { status: 'passed', evidence_ref: 'diagram/review', checks: [{ name: 'text-alternatives', status: 'passed', evidence_ref: 'diagram/check' }] },
};

function qualificationEntryFor(role) {
  const entry = {
    model_identity: identity(role), provider_family: providers[role], role,
    qualified_at: '2026-08-01T00:00:00Z', expires_at: '2026-10-30T00:00:00Z', status: 'qualified',
    prompt_version: '1.0.0', criteria: policy.qualification.required_criteria.map(criterion),
  };
  return { ...entry, qualification_digest: qualificationDigest(entry) };
}
function refreshQualificationDigest(entry) { entry.qualification_digest = qualificationDigest(entry); }
const operation = (id, role = 'writer', targetItemId = itemId) => ({ handoff_id: id, item_id: targetItemId, role });

function registryFor(handoffs) {
  return {
    schema_version: '1.0.0',
    entries: handoffs.map((handoff) => qualificationEntryFor(handoff.role)),
  };
}

async function chainFor({ scope = baseScope, roles = requiredDeliveryRoles(policy, scope), mutate = () => { } } = {}) {
  const handoffs = [];
  for (const [index, role] of roles.entries()) {
    const input = {
      binding, role,
      model: { identity: identity(role), provider_family: providers[role], qualification_digest: qualificationEntryFor(role).qualification_digest },
      promptVersion: '1.0.0', input: { role }, output: { role, index }, predecessor: handoffs.at(-1) ?? null,
      status: 'passed', findings: [], startedAt: `2026-08-11T00:0${index}:00Z`, completedAt: `2026-08-11T00:0${index}:30Z`,
    };
    mutate(input, index);
    handoffs.push(await createAgentHandoff(input));
  }
  return handoffs;
}

const usage = (overrides = {}) => {
  const result = { requests: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5, duration_ms: 4, retries: 1, source_fetches: 1, item_count: 1, concurrency: 1, usd_spend: 1.5, ...overrides };
  if ('input_tokens' in overrides || 'output_tokens' in overrides) result.total_tokens = result.input_tokens + result.output_tokens;
  return result;
};

function generousPolicy() {
  const copy = structuredClone(policy);
  for (const level of ['per_run', 'per_item']) {
    for (const field of Object.keys(copy.limits[level])) copy.limits[level][field] = field === 'usd_spend' ? 1e9 : Number.MAX_SAFE_INTEGER;
  }
  return copy;
}

async function completeAccounting(handoffs, activePolicy = policy, actual = usage({ duration_ms: 30000, retries: 0 })) {
  let accounting = createDeliveryAccounting(activePolicy);
  for (const [index, handoff] of handoffs.entries()) {
    const operationUsage = { ...actual, item_count: index === 0 ? 1 : 0, concurrency: 1 };
    const dispatch = checkBeforeDispatch({
      policy: activePolicy, accounting,
      operation: { handoff_id: handoff.handoff_id, item_id: handoff.item_id, role: handoff.role }, expectedUsage: operationUsage
    });
    assert.equal(dispatch.allowed, true);
    const result = recordDispatchResult({ policy: activePolicy, accounting: dispatch.accounting, dispatchId: dispatch.dispatch_id, actualUsage: operationUsage });
    assert.equal(result.accepted, true); accounting = result.accounting;
  }
  return accounting;
}

async function assertChainRejects(mutator, pattern, options = {}) {
  const handoffs = await chainFor(options);
  const registry = registryFor(handoffs);
  mutator({ handoffs, registry });
  await assert.rejects(validateHandoffChain({ binding, handoffs, policy, qualificationRegistry: registry, scope: options.scope ?? baseScope, roleEvidence, asOf: '2026-08-12T00:00:00Z' }), pattern);
}

test('safe policy and empty fail-closed registry satisfy strict configuration contracts without static model assignment', async () => {
  const emptyRegistry = JSON.parse(await readFile(new URL('../config/qualification-registry.example.json', import.meta.url), 'utf8'));
  await validateDeliveryConfiguration({ policy, qualificationRegistry: emptyRegistry });
  assert.deepEqual(emptyRegistry.entries, []);
  assert.equal(JSON.stringify(policy).includes('model_identity'), false);
});

test('exact role order rejects omission, duplication, and reordering', async () => {
  const complete = await chainFor();
  for (const roles of [
    complete.slice(1),
    [complete[0], complete[0], ...complete.slice(1)],
    [complete[1], complete[0], ...complete.slice(2)],
  ]) {
    const registry = registryFor(roles);
    await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs: roles, scope: baseScope, roleEvidence, asOf: '2026-08-12T00:00:00Z' }), /exact ordered role chain/i);
  }
});

test('conditional assessment and diagram specialists are required exactly before final review', async () => {
  const scope = { ...baseScope, assessments_changed: true, diagrams_changed: true };
  const roles = requiredDeliveryRoles(policy, scope);
  assert.deepEqual(roles.slice(-3), ['assessment-reviewer', 'diagram-reviewer', 'final-reviewer']);
  const handoffs = await chainFor({ scope });
  await validateDeliveryChain({ policy, qualificationRegistry: registryFor(handoffs), handoffs, scope, roleEvidence, asOf: '2026-08-12T00:00:00Z' });
  const omitted = handoffs.filter((handoff) => handoff.role !== 'diagram-reviewer');
  await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registryFor(omitted), handoffs: omitted, scope, roleEvidence, asOf: '2026-08-12T00:00:00Z' }), /exact ordered role chain/i);
  const missingEvidence = structuredClone(roleEvidence); delete missingEvidence['assessment-reviewer'];
  await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registryFor(handoffs), handoffs, scope, roleEvidence: missingEvidence, asOf: '2026-08-12T00:00:00Z' }), /specialist evidence/i);
});

test('qualification expiry, identity/provider/digest/role mismatch, prompt change, and failed criteria block delivery', async () => {
  await assertChainRejects(({ handoffs, registry }) => {
    registry.entries[0].expires_at = '2026-08-12T00:00:00Z'; refreshQualificationDigest(registry.entries[0]);
    handoffs[0].model.qualification_digest = registry.entries[0].qualification_digest;
  }, /expired/i);
  for (const field of ['model_identity', 'provider_family', 'qualification_digest', 'role', 'prompt_version']) {
    await assertChainRejects(({ registry }) => {
      registry.entries[0][field] = field === 'qualification_digest' ? digest('f')
        : field === 'role' ? 'writer'
          : field === 'prompt_version' ? '1.0.1' : `${registry.entries[0][field]}-changed`;
      if (field !== 'qualification_digest') refreshQualificationDigest(registry.entries[0]);
    }, /no exact qualification|duplicate qualification|digest does not match/i);
  }
  await assertChainRejects(({ registry }) => { registry.entries[0].expires_at = '2026-10-31T00:00:01Z'; refreshQualificationDigest(registry.entries[0]); }, /exceeds 90 days/i);
  await assertChainRejects(({ handoffs, registry }) => {
    registry.entries[0].criteria[0].passed = false; refreshQualificationDigest(registry.entries[0]);
    handoffs[0].model.qualification_digest = registry.entries[0].qualification_digest;
  }, /did not pass/i);
});

test('provider-family and identity independence is mandatory', async () => {
  await assertChainRejects(({ handoffs, registry }) => {
    const factual = handoffs.find((entry) => entry.role === 'factual-verifier');
    factual.model.provider_family = 'provider-a'; const entry = registry.entries.find((candidate) => candidate.role === 'factual-verifier');
    entry.provider_family = 'provider-a'; refreshQualificationDigest(entry); factual.model.qualification_digest = entry.qualification_digest;
  }, /writer and factual-verifier/i);
  for (const role of ['writer', 'editor']) {
    await assertChainRejects(({ handoffs, registry }) => {
      const implementation = handoffs.find((entry) => entry.role === role);
      const final = handoffs.find((entry) => entry.role === 'final-reviewer');
      final.model.identity = implementation.model.identity;
      const entry = registry.entries.find((candidate) => candidate.role === 'final-reviewer'); entry.model_identity = implementation.model.identity;
      refreshQualificationDigest(entry); final.model.qualification_digest = entry.qualification_digest;
    }, /final-reviewer identity/i);
    await assertChainRejects(({ handoffs, registry }) => {
      const implementation = handoffs.find((entry) => entry.role === role);
      const final = handoffs.find((entry) => entry.role === 'final-reviewer');
      final.model.provider_family = implementation.model.provider_family;
      const entry = registry.entries.find((candidate) => candidate.role === 'final-reviewer'); entry.provider_family = implementation.model.provider_family;
      refreshQualificationDigest(entry); final.model.qualification_digest = entry.qualification_digest;
    }, /final-reviewer provider family/i);
  }
});

test('failed role status and blocking findings stop the chain', async () => {
  await assertChainRejects(({ handoffs }) => { handoffs[2].status = 'failed'; }, /status must be passed/i);
  await assertChainRejects(({ handoffs }) => { handoffs[2].findings = [{ severity: 'blocking', summary: 'Unresolved defect' }]; }, /blocking finding/i);
});

test('factual evidence blocks missing, conflicting, stale, or non-primary claim mappings', async () => {
  const handoffs = await chainFor(); const registry = registryFor(handoffs);
  for (const mutate of [
    (evidence) => { evidence['factual-verifier'].claims[0].status = 'missing'; },
    (evidence) => { evidence['factual-verifier'].claims[0].status = 'conflicting'; },
    (evidence) => { evidence['factual-verifier'].claims[0].source.current = false; },
    (evidence) => { evidence['factual-verifier'].claims[0].source.primary = false; },
  ]) {
    const evidence = structuredClone(roleEvidence); mutate(evidence);
    await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs, scope: baseScope, roleEvidence: evidence, asOf: '2026-08-12T00:00:00Z' }), /factual claim/i);
  }
});

test('accessibility deterministic failures and unresolved or failed human review block readiness', async () => {
  const handoffs = await chainFor(); const registry = registryFor(handoffs);
  for (const mutate of [
    (evidence) => { evidence['accessibility-reviewer'].checks[0].status = 'failed'; },
    (evidence) => { evidence['accessibility-reviewer'].human_review.status = 'failed'; },
    (evidence) => { evidence['accessibility-reviewer'].human_review.status = 'pending'; },
  ]) {
    const evidence = structuredClone(roleEvidence); mutate(evidence);
    await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs, scope: baseScope, roleEvidence: evidence, asOf: '2026-08-12T00:00:00Z' }), /accessibility|assistive-technology/i);
  }
});

test('all cap boundaries are inclusive and the next unit stops before dispatch for run and item limits', () => {
  const sample = usage();
  for (const level of ['per_run', 'per_item']) {
    for (const field of Object.keys(sample)) {
      const boundaryPolicy = generousPolicy();
      boundaryPolicy.limits[level][field] = sample[field];
      let accounting = createDeliveryAccounting(boundaryPolicy);
      const boundary = checkBeforeDispatch({ policy: boundaryPolicy, accounting, operation: operation(`boundary-${level}-${field}`), expectedUsage: sample });
      assert.equal(boundary.allowed, true, `${level}.${field} boundary`);
      if (field === 'concurrency') {
        const second = checkBeforeDispatch({
          policy: boundaryPolicy, accounting: boundary.accounting,
          operation: operation(`second-${level}-${field}`, 'editor'), expectedUsage: { ...sample, item_count: 0, concurrency: 2 }
        });
        assert.equal(second.allowed, false, `${level}.${field} exceed`);
      } else {
        const exceededPolicy = structuredClone(boundaryPolicy);
        exceededPolicy.limits[level][field] = field === 'usd_spend' ? sample[field] - 0.01 : sample[field] - 1;
        accounting = createDeliveryAccounting(exceededPolicy);
        const exceeded = checkBeforeDispatch({ policy: exceededPolicy, accounting, operation: operation(`exceeded-${level}-${field}`), expectedUsage: sample });
        assert.equal(exceeded.allowed, false, `${level}.${field} exceed`);
        assert.match(exceeded.accounting.stop_reason, new RegExp(`${level === 'per_run' ? 'run' : 'item'}:${field}`));
      }
    }
  }
});

test('usage rejects every missing, negative, NaN, infinite, unsafe, token-inconsistent, and aggregate-overflow value', () => {
  for (const field of Object.keys(usage())) {
    const missing = usage(); delete missing[field];
    assert.throws(() => assertUsage(missing), /exactly/i, `missing ${field}`);
    const negative = usage({ [field]: -1 });
    assert.throws(() => assertUsage(negative), /non-negative|total_tokens/i, `negative ${field}`);
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => assertUsage(usage({ usd_spend: invalid })), /finite/i);
  assert.throws(() => assertUsage(usage({ requests: Number.MAX_SAFE_INTEGER + 1 })), /safe/i);
  assert.throws(() => assertUsage({ ...usage(), total_tokens: 999 }), /exactly equal/i);
  const overflowPolicy = generousPolicy();
  let accounting = createDeliveryAccounting(overflowPolicy);
  accounting.usage.requests = Number.MAX_SAFE_INTEGER;
  assert.throws(() => checkBeforeDispatch({ policy: overflowPolicy, accounting, operation: operation('overflow'), expectedUsage: usage() }), /inconsistent/i);
});

test('post-result aggregate excess persists exact partial truth and a deterministic stop reason', () => {
  const capped = generousPolicy(); capped.limits.per_run.output_tokens = 3;
  let accounting = createDeliveryAccounting(capped);
  const dispatch = checkBeforeDispatch({ policy: capped, accounting, operation: operation('post-cap'), expectedUsage: usage({ output_tokens: 2 }) });
  assert.equal(dispatch.allowed, true);
  const result = recordDispatchResult({ policy: capped, accounting: dispatch.accounting, dispatchId: dispatch.dispatch_id, actualUsage: usage({ output_tokens: 4 }) });
  assert.equal(result.accepted, false);
  assert.equal(result.accounting.usage.output_tokens, 4);
  assert.equal(result.accounting.stop_reason, 'post-result:run:output_tokens-cap-exceeded');
  assert.deepEqual(result.accounting.partial_truth.incomplete_items, [itemId]);
  assert.equal(result.accounting.partial_truth.results.length, 1);
});

test('complete qualified independent chain with evidence and accounting produces Gate 2 readiness', async () => {
  const handoffs = await chainFor();
  const qualificationRegistry = registryFor(handoffs);
  const accounting = await completeAccounting(handoffs);
  const artifact = {
    proposal_digest: binding.proposal_digest, target: binding.target, artifact_digest: handoffs.at(-1).output_digest,
    scope_digest: deliveryScopeDigest(baseScope),
    displayed_diff_digest: digest('d'), prepared_tree_digest: digest('e'), base_commit: 'a'.repeat(40),
    diff_ref: 'evidence/diff', artifact_ref: 'evidence/artifact',
    tests: [{ name: 'unit', status: 'passed', evidence_ref: 'evidence/test' }],
    factual_review: { status: 'passed', evidence_ref: 'evidence/factual' },
    accessibility_review: { status: 'passed', evidence_ref: 'evidence/a11y' }, cost: { currency: 'USD', amount: 9 },
  };
  const item = await prepareGate2Item({ binding, handoffs, artifact, policy, qualificationRegistry, scope: baseScope, roleEvidence, accounting, asOf: '2026-08-12T00:00:00Z' });
  assert.equal(item.decision_state, 'pending');
  assert.equal(item.artifact_digest, handoffs.at(-1).output_digest);

  const stoppedAccounting = { ...accounting, stopped: true, stop_reason: 'pre-dispatch:run:requests-cap-exceeded' };
  await assert.rejects(prepareGate2Item({ binding, handoffs, artifact, policy, qualificationRegistry, scope: baseScope, roleEvidence, accounting: stoppedAccounting, asOf: '2026-08-12T00:00:00Z' }), /inconsistent/i);
});

test('one dispatch cannot account for a six-handoff chain and exact successful accounting has one lifecycle item', async () => {
  const handoffs = await chainFor();
  const one = await completeAccounting([handoffs[0]]);
  assert.equal(one.usage.item_count, 1); assert.equal(one.by_item[itemId].item_count, 1);
  assert.throws(() => assertAccountingIntegrity({ policy, accounting: { ...one, usage: { ...one.usage, item_count: 6 } } }), /usage is inconsistent/i);
  const artifact = {
    proposal_digest: binding.proposal_digest, target: binding.target, artifact_digest: handoffs.at(-1).output_digest,
    scope_digest: deliveryScopeDigest(baseScope),
    displayed_diff_digest: digest('d'), prepared_tree_digest: digest('e'), base_commit: 'a'.repeat(40), diff_ref: 'diff', artifact_ref: 'artifact',
    tests: [{ name: 'unit', status: 'passed', evidence_ref: 'test' }], factual_review: { status: 'passed', evidence_ref: 'factual' },
    accessibility_review: { status: 'passed', evidence_ref: 'a11y' }, cost: { currency: 'USD', amount: 1.5 }
  };
  await assert.rejects(prepareGate2Item({
    binding, handoffs, artifact, policy, qualificationRegistry: registryFor(handoffs), scope: baseScope,
    roleEvidence, accounting: one, asOf: '2026-08-12T00:00:00Z'
  }), /one-for-one/i);
});

test('fabricated aggregates, result sets, duplicate, extra, and cross-item operations fail closed', async () => {
  const handoffs = await chainFor(); const accounting = await completeAccounting(handoffs);
  for (const mutate of [
    (copy) => { copy.usage.requests += 1; }, (copy) => { copy.by_item[itemId].requests += 1; },
    (copy) => { copy.partial_truth.completed_items = []; },
    (copy) => { copy.partial_truth.results[1].dispatch_id = copy.partial_truth.results[0].dispatch_id; },
    (copy) => { copy.partial_truth.results.push(structuredClone(copy.partial_truth.results[0])); },
    (copy) => { copy.partial_truth.results[0].item_id = runId; },
  ]) {
    const copy = structuredClone(accounting); mutate(copy);
    assert.throws(() => assertAccountingIntegrity({ policy, accounting: copy }), /inconsistent|duplicate|ordinals|derived|active_operation_ids/i);
  }
});

test('derived item_count and concurrency reject caller under-reporting and over-reporting', () => {
  let accounting = createDeliveryAccounting(policy);
  assert.throws(() => checkBeforeDispatch({ policy, accounting, operation: operation('under-item'), expectedUsage: usage({ item_count: 0 }) }), /policy-derived/i);
  const first = checkBeforeDispatch({ policy, accounting, operation: operation('active-one'), expectedUsage: usage() }); accounting = first.accounting;
  assert.throws(() => checkBeforeDispatch({
    policy, accounting, operation: operation('active-two', 'editor'),
    expectedUsage: usage({ item_count: 0, concurrency: 1 })
  }), /policy-derived/i);
});

test('USD accounting uses exact micro-dollar totals and rejects excess precision', () => {
  const decimalPolicy = generousPolicy();
  decimalPolicy.limits.per_run.usd_spend = 0.3;
  decimalPolicy.limits.per_item.usd_spend = 0.3;
  let accounting = createDeliveryAccounting(decimalPolicy);
  for (const [index, amount] of [0.1, 0.2].entries()) {
    const operationUsage = usage({ usd_spend: amount, item_count: index === 0 ? 1 : 0 });
    const dispatch = checkBeforeDispatch({
      policy: decimalPolicy, accounting,
      operation: operation(`decimal-${index}`, index === 0 ? 'writer' : 'editor'), expectedUsage: operationUsage
    });
    assert.equal(dispatch.allowed, true);
    accounting = recordDispatchResult({
      policy: decimalPolicy, accounting: dispatch.accounting,
      dispatchId: dispatch.dispatch_id, actualUsage: operationUsage
    }).accounting;
  }
  assert.equal(accounting.usage.usd_spend, 0.3);
  assert.throws(() => assertUsage(usage({ usd_spend: 0.0000001 })), /six decimal places/i);
});

test('Gate 2 requires the artifact to bind the exact reviewed scope', async () => {
  const handoffs = await chainFor();
  const accounting = await completeAccounting(handoffs);
  const artifact = {
    proposal_digest: binding.proposal_digest, scope_digest: deliveryScopeDigest({ ...baseScope, diagrams_changed: true }),
    target: binding.target, artifact_digest: handoffs.at(-1).output_digest, displayed_diff_digest: digest('d'),
    prepared_tree_digest: digest('e'), base_commit: 'a'.repeat(40), diff_ref: 'diff', artifact_ref: 'artifact',
    tests: [{ name: 'unit', status: 'passed', evidence_ref: 'test' }],
    factual_review: { status: 'passed', evidence_ref: 'factual' },
    accessibility_review: { status: 'passed', evidence_ref: 'a11y' }, cost: { currency: 'USD', amount: 9 },
  };
  await assert.rejects(prepareGate2Item({
    binding, handoffs, artifact, policy, qualificationRegistry: registryFor(handoffs),
    scope: baseScope, roleEvidence, accounting, asOf: '2026-08-12T00:00:00Z'
  }), /scope digest mismatch/i);
});

test('qualification digests, calendar dates, and unrelated revoked history are validated correctly', async () => {
  await assertChainRejects(({ registry }) => { registry.entries[0].qualification_digest = digest('f'); }, /digest does not match/i);
  await assertChainRejects(({ registry }) => { registry.entries[0].qualified_at = '2026-02-30T00:00:00Z'; }, /contract is invalid|calendar/i);
  const handoffs = await chainFor(); const registry = registryFor(handoffs);
  const history = qualificationEntryFor('writer'); history.model_identity = 'historical-model'; history.status = 'revoked'; history.criteria[0].passed = false;
  refreshQualificationDigest(history); registry.entries.push(history);
  await validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs, scope: baseScope, roleEvidence, asOf: '2026-08-12T00:00:00Z' });
});

test('scope is exact, complete, and binds human review plus conditional specialists', async () => {
  const handoffs = await chainFor(); const registry = registryFor(handoffs);
  for (const scope of [undefined, {}, { assessments_changed: false }, { ...baseScope, diagrams_changed: 'false' }]) {
    await assert.rejects(validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs, scope, roleEvidence, asOf: '2026-08-12T00:00:00Z' }), /scope/i);
  }
  const falseScope = { ...baseScope, human_assistive_review_required: false };
  const falseEvidence = structuredClone(roleEvidence);
  falseEvidence['accessibility-reviewer'].human_review = { required: false, status: 'not-required', reason: 'No interactive or assistive-technology-sensitive change.' };
  await validateDeliveryChain({ policy, qualificationRegistry: registry, handoffs, scope: falseScope, roleEvidence: falseEvidence, asOf: '2026-08-12T00:00:00Z' });
  delete falseEvidence['accessibility-reviewer'].human_review.reason;
  await assert.rejects(validateDeliveryChain({
    policy, qualificationRegistry: registry, handoffs, scope: falseScope, roleEvidence: falseEvidence,
    asOf: '2026-08-12T00:00:00Z'
  }), /reason/i);
});

test('claim inventory and every accessibility applicability category fail closed when incomplete', async () => {
  const handoffs = await chainFor(); const registry = registryFor(handoffs);
  for (const mutate of [
    (e) => { e['factual-verifier'].inventory.complete = false; },
    (e) => { e['factual-verifier'].inventory.volatile_claim_ids.push('omitted-claim'); },
  ]) {
    const evidence = structuredClone(roleEvidence); mutate(evidence);
    await assert.rejects(validateDeliveryChain({
      policy, qualificationRegistry: registry, handoffs, scope: baseScope, roleEvidence: evidence,
      asOf: '2026-08-12T00:00:00Z'
    }), /inventory|factual claims/i);
  }
  for (const name of accessibilityNames) {
    const evidence = structuredClone(roleEvidence); evidence['accessibility-reviewer'].checks = evidence['accessibility-reviewer'].checks.filter((check) => check.name !== name);
    await assert.rejects(validateDeliveryChain({
      policy, qualificationRegistry: registry, handoffs, scope: baseScope, roleEvidence: evidence,
      asOf: '2026-08-12T00:00:00Z'
    }), /accessibility applicability/i, name);
  }
});

test('handoff elapsed time must be valid and exactly match operation duration', async () => {
  await assert.rejects(createAgentHandoff({
    binding, role: 'writer', model: { identity: 'x', provider_family: 'y', qualification_digest: digest('a') },
    promptVersion: '1.0.0', input: {}, output: {}, status: 'passed', startedAt: '2026-02-30T00:00:00Z', completedAt: '2026-03-01T00:00:00Z'
  }), /calendar/i);
  const handoffs = await chainFor(); const accounting = await completeAccounting(handoffs);
  const copy = structuredClone(accounting); copy.partial_truth.results[0].usage.duration_ms += 1; copy.usage.duration_ms += 1; copy.by_item[itemId].duration_ms += 1;
  assert.throws(() => assertAccountingReady({ policy, accounting: copy, itemId, handoffs }), /duration/i);
});

test('complete six-role and eight-role specialist chains both reconcile successfully', async () => {
  for (const scope of [baseScope, { ...baseScope, assessments_changed: true, diagrams_changed: true }]) {
    const handoffs = await chainFor({ scope }); const accounting = await completeAccounting(handoffs);
    await validateHandoffChain({ binding, handoffs, policy, qualificationRegistry: registryFor(handoffs), scope, roleEvidence, asOf: '2026-08-12T00:00:00Z' });
    assert.equal(accounting.partial_truth.results.length, handoffs.length); assert.equal(accounting.by_item[itemId].item_count, 1);
  }
});
