import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson, sha256Digest } from './identity.mjs';

const POLICY_SCHEMA = new URL('../../config/schemas/delivery-policy.schema.json', import.meta.url);
const REGISTRY_SCHEMA = new URL('../../config/schemas/qualification-registry.schema.json', import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const USD_SCALE = 1_000_000;
const SCOPE_FIELDS = Object.freeze(['assessments_changed', 'diagrams_changed', 'human_assistive_review_required']);
const ACCESSIBILITY_CHECKS = Object.freeze([
  'structure', 'keyboard', 'captions', 'transcripts', 'text-alternatives',
  'color-independence', 'zoom', 'reduced-motion',
]);
export const USAGE_FIELDS = Object.freeze([
  'requests', 'input_tokens', 'output_tokens', 'total_tokens', 'duration_ms',
  'retries', 'source_fetches', 'item_count', 'concurrency', 'usd_spend',
]);
const ADDITIVE_USAGE_FIELDS = USAGE_FIELDS.filter((field) => !['item_count', 'concurrency'].includes(field));
let validators;

function fail(message) { throw new Error(`delivery policy refused: ${message}`); }
function stable(value) { return JSON.parse(canonicalJson(value)); }
function unique(values) { return [...new Set(values)]; }

export function parseCanonicalUtcInstant(value, label = 'date-time') {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value ?? '');
  if (!match) fail(`${label} must be a canonical RFC3339 UTC instant`);
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const components = [year, month, day, hour, minute, second].map(Number);
  const milliseconds = Number(fraction.padEnd(3, '0'));
  const instant = new Date(Date.UTC(components[0], components[1] - 1, components[2], components[3], components[4], components[5], milliseconds));
  if (instant.getUTCFullYear() !== components[0] || instant.getUTCMonth() !== components[1] - 1
    || instant.getUTCDate() !== components[2] || instant.getUTCHours() !== components[3]
    || instant.getUTCMinutes() !== components[4] || instant.getUTCSeconds() !== components[5]
    || instant.getUTCMilliseconds() !== milliseconds) fail(`${label} is not a valid calendar instant`);
  return instant.getTime();
}

export function assertDeliveryScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || canonicalJson(Object.keys(scope).sort()) !== canonicalJson([...SCOPE_FIELDS].sort())) {
    fail(`scope must contain exactly ${SCOPE_FIELDS.join(', ')}`);
  }
  for (const field of SCOPE_FIELDS) if (typeof scope[field] !== 'boolean') fail(`scope.${field} must be boolean`);
  return scope;
}

export function deliveryScopeDigest(scope) { return sha256Digest(assertDeliveryScope(scope)); }

export function qualificationDigest(entry) {
  const { model_identity, provider_family, role, qualified_at, expires_at, prompt_version, criteria } = entry ?? {};
  return sha256Digest({ model_identity, provider_family, role, qualified_at, expires_at, prompt_version, criteria });
}

export function factualInventoryDigest(volatileClaimIds) {
  return sha256Digest({ volatile_claim_ids: [...volatileClaimIds].sort() });
}

async function configurationValidators() {
  if (validators) return validators;
  const [policySchema, registrySchema] = await Promise.all([
    readFile(POLICY_SCHEMA, 'utf8').then(JSON.parse),
    readFile(REGISTRY_SCHEMA, 'utf8').then(JSON.parse),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  ajv.addFormat('date-time', (value) => {
    try { parseCanonicalUtcInstant(value); return true; } catch { return false; }
  });
  validators = { policy: ajv.compile(policySchema), registry: ajv.compile(registrySchema) };
  return validators;
}

function assertSchema(validator, value, label) {
  if (!validator(value)) {
    const details = validator.errors.map((entry) => `${entry.instancePath || '/'} ${entry.message}`).join('; ');
    fail(`${label} contract is invalid: ${details}`);
  }
}

export async function validateDeliveryConfiguration({ policy, qualificationRegistry }) {
  if (!policy) fail('an explicit delivery policy is required');
  if (!qualificationRegistry) fail('an explicit qualification registry is required');
  const compiled = await configurationValidators();
  assertSchema(compiled.policy, policy, 'delivery policy');
  assertSchema(compiled.registry, qualificationRegistry, 'qualification registry');
  return { policy, qualificationRegistry };
}

export function requiredDeliveryRoles(policy, scope) {
  if (!policy?.roles?.required_order) fail('validated delivery policy is required');
  assertDeliveryScope(scope);
  const roles = [...policy.roles.required_order];
  const finalIndex = roles.indexOf('final-reviewer');
  const specialists = [];
  if (scope.assessments_changed === true) specialists.push(policy.roles.conditional.assessments_changed);
  if (scope.diagrams_changed === true) specialists.push(policy.roles.conditional.diagrams_changed);
  roles.splice(finalIndex, 0, ...specialists);
  return roles;
}

function qualificationKey(entry) {
  return [entry.model_identity, entry.provider_family, entry.role, entry.qualification_digest, entry.prompt_version].join('\u0000');
}

export async function validateQualifications({ policy, qualificationRegistry, handoffs, asOf = new Date().toISOString() }) {
  await validateDeliveryConfiguration({ policy, qualificationRegistry });
  const now = parseCanonicalUtcInstant(asOf, 'qualification evaluation time');
  const entriesByKey = new Map();
  for (const entry of qualificationRegistry.entries) {
    if (entry.qualification_digest !== qualificationDigest(entry)) fail(`${entry.role} qualification digest does not match immutable evidence and binding fields`);
    const key = qualificationKey(entry);
    if (entriesByKey.has(key)) fail(`duplicate qualification registry entry for ${entry.role}`);
    entriesByKey.set(key, entry);
    const qualified = parseCanonicalUtcInstant(entry.qualified_at, `${entry.role} qualified_at`);
    const expires = parseCanonicalUtcInstant(entry.expires_at, `${entry.role} expires_at`);
    if (!(expires > qualified)) fail(`${entry.role} qualification expiry must be after qualification time`);
    if (expires - qualified > policy.qualification.maximum_age_days * DAY_MS) fail(`${entry.role} qualification exceeds ${policy.qualification.maximum_age_days} days`);
    const names = entry.criteria.map((criterion) => criterion.name);
    if (unique(names).length !== names.length) fail(`${entry.role} qualification has duplicate measured criteria`);
  }
  for (const handoff of handoffs) {
    const key = qualificationKey({
      model_identity: handoff.model.identity,
      provider_family: handoff.model.provider_family,
      role: handoff.role,
      qualification_digest: handoff.model.qualification_digest,
      prompt_version: handoff.prompt_version,
    });
    const entry = entriesByKey.get(key);
    if (!entry) fail(`no exact qualification matches ${handoff.role} identity, provider, digest, and prompt`);
    if (entry.status !== 'qualified') fail(`${handoff.role} qualification status is ${entry.status}`);
    for (const required of policy.qualification.required_criteria) {
      const criterion = entry.criteria.find((candidate) => candidate.name === required);
      if (!criterion) fail(`${entry.role} qualification is missing measured criterion ${required}`);
      if (criterion.passed !== true) fail(`${entry.role} qualification criterion ${required} did not pass`);
    }
    if (parseCanonicalUtcInstant(entry.qualified_at) > now) fail(`${handoff.role} qualification is from the future`);
    if (parseCanonicalUtcInstant(entry.expires_at) <= now) fail(`${handoff.role} qualification is expired`);
  }
}

function assertRoleEvidence(roleEvidence, scope) {
  const factual = roleEvidence?.['factual-verifier'];
  if (!factual || !Array.isArray(factual.claims) || factual.claims.length === 0) fail('factual-verifier claim evidence is required');
  const inventory = factual.inventory;
  if (!inventory || inventory.complete !== true || !Array.isArray(inventory.volatile_claim_ids)
    || unique(inventory.volatile_claim_ids).length !== inventory.volatile_claim_ids.length
    || inventory.volatile_claim_ids.some((claimId) => typeof claimId !== 'string' || !claimId)
    || inventory.inventory_digest !== factualInventoryDigest(inventory.volatile_claim_ids)) {
    fail('factual-verifier requires an explicit complete volatile-claim inventory and matching digest');
  }
  const claimIds = factual.claims.map((claim) => claim.claim_id).sort();
  if (canonicalJson(claimIds) !== canonicalJson([...inventory.volatile_claim_ids].sort())) fail('factual claims must match the complete volatile-claim inventory exactly');
  for (const claim of factual.claims) {
    if (!claim.claim_id) fail('each factual claim requires a claim_id');
    if (claim.status === 'missing' || claim.status === 'conflicting') fail(`factual claim ${claim.claim_id} has ${claim.status} evidence`);
    if (claim.status !== 'supported' || claim.source?.primary !== true || claim.source?.current !== true
      || !claim.source?.evidence_ref) {
      fail(`factual claim ${claim.claim_id} is not mapped to a current primary source`);
    }
    parseCanonicalUtcInstant(claim.source.verified_at, `factual claim ${claim.claim_id} verified_at`);
  }

  const accessibility = roleEvidence?.['accessibility-reviewer'];
  if (!accessibility || !Array.isArray(accessibility.checks)) {
    fail('accessibility deterministic-check evidence is required');
  }
  if (unique(accessibility.checks.map((check) => check.name)).length !== accessibility.checks.length
    || canonicalJson(accessibility.checks.map((check) => check.name).sort()) !== canonicalJson([...ACCESSIBILITY_CHECKS].sort())) {
    fail(`accessibility applicability is required exactly for ${ACCESSIBILITY_CHECKS.join(', ')}`);
  }
  for (const check of accessibility.checks) {
    if (typeof check.applicable !== 'boolean') fail(`accessibility ${check.name} applicability must be boolean`);
    if (check.applicable && (check.status !== 'passed' || !check.evidence_ref)) fail(`applicable accessibility ${check.name} requires passed evidence`);
    if (!check.applicable && (check.status !== 'not-applicable' || !check.reason)) fail(`non-applicable accessibility ${check.name} requires a reason`);
  }
  const human = accessibility.human_review;
  if (!human || typeof human.required !== 'boolean') fail('accessibility human-review applicability must be explicit');
  if (human.required !== scope.human_assistive_review_required) fail('accessibility human-review applicability must match exact scope');
  if (human.required && (human.status !== 'passed' || !human.evidence_ref)) fail('required human assistive-technology review is unresolved or failed');
  if (!human.required && (human.status !== 'not-required' || !human.reason)) fail('non-applicable human review must be recorded as not-required with a reason');

  for (const [flag, role] of [['assessments_changed', 'assessment-reviewer'], ['diagrams_changed', 'diagram-reviewer']]) {
    if (scope[flag] !== true) continue;
    const evidence = roleEvidence?.[role];
    if (!evidence || evidence.status !== 'passed' || !evidence.evidence_ref
      || !Array.isArray(evidence.checks) || evidence.checks.length === 0
      || evidence.checks.some((check) => check.status !== 'passed' || !check.name || !check.evidence_ref)) {
      fail(`${role} specialist evidence is required and must pass`);
    }
  }
}

export async function validateDeliveryChain({ policy, qualificationRegistry, handoffs, scope, roleEvidence, asOf }) {
  await validateDeliveryConfiguration({ policy, qualificationRegistry });
  assertDeliveryScope(scope);
  const expected = requiredDeliveryRoles(policy, scope);
  const actual = handoffs.map((handoff) => handoff.role);
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`exact ordered role chain required: ${expected.join(', ')}`);
  if (unique(actual).length !== actual.length) fail('each applicable role must appear exactly once');
  for (const handoff of handoffs) {
    if (handoff.status !== 'passed') fail(`${handoff.role} status must be passed`);
    if (handoff.findings.some((finding) => finding.severity === 'blocking')) fail(`${handoff.role} has a blocking finding`);
  }
  const byRole = Object.fromEntries(handoffs.map((handoff) => [handoff.role, handoff]));
  if (byRole.writer.model.provider_family === byRole['factual-verifier'].model.provider_family) {
    fail('writer and factual-verifier must use different provider families');
  }
  const final = byRole['final-reviewer'];
  for (const implementationRole of ['writer', 'editor']) {
    const implementation = byRole[implementationRole];
    if (final.model.identity === implementation.model.identity) fail(`final-reviewer identity must differ from ${implementationRole}`);
    if (final.model.provider_family === implementation.model.provider_family) fail(`final-reviewer provider family must differ from ${implementationRole}`);
  }
  await validateQualifications({ policy, qualificationRegistry, handoffs, asOf });
  assertRoleEvidence(roleEvidence, scope);
  return { roles: actual, evidence_digest: sha256Digest(roleEvidence), scope_digest: deliveryScopeDigest(scope) };
}

function zeroUsage() { return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])); }

export function assertUsage(usage, label = 'usage') {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail(`${label} must be an object`);
  const keys = Object.keys(usage).sort();
  if (canonicalJson(keys) !== canonicalJson([...USAGE_FIELDS].sort())) fail(`${label} must contain exactly ${USAGE_FIELDS.join(', ')}`);
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (!Number.isFinite(value) || value < 0 || (field !== 'usd_spend' && !Number.isSafeInteger(value))) {
      fail(`${label}.${field} must be a non-negative finite safe ${field === 'usd_spend' ? 'number' : 'integer'}`);
    }
    if (field === 'usd_spend' && (!Number.isSafeInteger(Math.round(value * USD_SCALE))
      || Math.abs(value * USD_SCALE - Math.round(value * USD_SCALE)) > Number.EPSILON * USD_SCALE)) {
      fail(`${label}.usd_spend must use at most six decimal places and fit safe micro-dollar accounting`);
    }
  }
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens || !Number.isSafeInteger(usage.total_tokens)) {
    fail(`${label}.total_tokens must exactly equal input_tokens plus output_tokens without overflow`);
  }
  return usage;
}

function assertLimits(limits, label) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)
    || canonicalJson(Object.keys(limits).sort()) !== canonicalJson([...USAGE_FIELDS].sort())) {
    fail(`${label} must contain exactly ${USAGE_FIELDS.join(', ')}`);
  }
  for (const field of USAGE_FIELDS) {
    const value = limits[field];
    if (!Number.isFinite(value) || value < 0 || (field !== 'usd_spend' && !Number.isSafeInteger(value))) {
      fail(`${label}.${field} must be a non-negative finite safe ${field === 'usd_spend' ? 'number' : 'integer'}`);
    }
    if (field === 'usd_spend' && (!Number.isSafeInteger(Math.round(value * USD_SCALE))
      || Math.abs(value * USD_SCALE - Math.round(value * USD_SCALE)) > Number.EPSILON * USD_SCALE)) {
      fail(`${label}.usd_spend must use at most six decimal places and fit safe micro-dollar accounting`);
    }
  }
  if (limits.concurrency < 1) fail(`${label}.concurrency must be at least one`);
}

function addUsage(left, right) {
  const result = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const value = field === 'usd_spend'
      ? (Math.round(left[field] * USD_SCALE) + Math.round(right[field] * USD_SCALE)) / USD_SCALE
      : left[field] + right[field];
    if (!Number.isFinite(value) || value < 0 || (field !== 'usd_spend' && !Number.isSafeInteger(value))) fail(`accounting overflow for ${field}`);
    result[field] = value;
  }
  result.item_count = Math.max(left.item_count, right.item_count);
  result.concurrency = Math.max(left.concurrency, right.concurrency);
  return result;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) fail(`${label} has an invalid shape`);
}

function assertOperation(operation, label = 'operation') {
  exactKeys(operation, ['handoff_id', 'item_id', 'role'], label);
  for (const field of ['handoff_id', 'item_id', 'role']) if (typeof operation[field] !== 'string' || !operation[field]) fail(`${label}.${field} is required`);
  return operation;
}

function operationFrom(record) { return { handoff_id: record.dispatch_id, item_id: record.item_id, role: record.role }; }

function usageFromRecords(records, field, itemId = undefined, universe = records) {
  let total = zeroUsage();
  const selected = records.filter((entry) => itemId === undefined || entry.item_id === itemId);
  for (const record of selected) total = addUsage(total, record[field]);
  total.item_count = selected.length === 0 ? 0 : new Set(selected.map((entry) => entry.item_id)).size;
  total.concurrency = selected.reduce((peak, entry) => Math.max(peak,
    itemId === undefined ? entry.active_operation_ids.length
      : entry.active_operation_ids.filter((id) => universe.find((candidate) => candidate.dispatch_id === id)?.item_id === itemId).length), 0);
  return total;
}

function firstExceeded(usage, limits) {
  return USAGE_FIELDS.find((field) => usage[field] > limits[field]);
}

function stopped(accounting, reason, itemId) {
  const incomplete = unique([...accounting.partial_truth.incomplete_items, itemId].filter(Boolean)).sort();
  return { ...accounting, stopped: true, stop_reason: reason, partial_truth: { ...accounting.partial_truth, incomplete_items: incomplete } };
}

export function createDeliveryAccounting(policy) {
  if (!policy?.limits?.per_run || !policy?.limits?.per_item) fail('validated policy limits are required');
  assertLimits(policy.limits.per_run, 'per-run limits');
  assertLimits(policy.limits.per_item, 'per-item limits');
  return {
    schema_version: '1.0.0', policy_digest: sha256Digest(policy), usage: zeroUsage(), by_item: {}, reservations: [],
    stopped: false, stop_reason: null, partial_truth: { completed_items: [], incomplete_items: [], results: [], denials: [] },
  };
}

function assertOperationRecord(record, label, usageField) {
  exactKeys(record, ['dispatch_id', 'item_id', 'role', 'ordinal', 'active_operation_ids', usageField, ...(usageField === 'usage' ? ['expected_usage', 'status'] : [])], label);
  assertOperation(operationFrom(record), label);
  if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 1) fail(`${label}.ordinal must be a positive safe integer`);
  if (!Array.isArray(record.active_operation_ids) || unique(record.active_operation_ids).length !== record.active_operation_ids.length
    || !record.active_operation_ids.includes(record.dispatch_id)) fail(`${label}.active_operation_ids must be a unique snapshot containing this operation`);
  assertUsage(record[usageField], `${label}.${usageField}`);
  if (usageField === 'usage') {
    assertUsage(record.expected_usage, `${label}.expected_usage`);
    if (!['completed', 'failed', 'blocked'].includes(record.status)) fail(`${label}.status is invalid`);
  }
}

function rebuildAccounting(policy, accounting) {
  const results = accounting.partial_truth.results;
  const allRecords = [...results, ...accounting.reservations];
  const usage = usageFromRecords(results, 'usage');
  usage.item_count = new Set(allRecords.map((entry) => entry.item_id)).size;
  usage.concurrency = allRecords.reduce((peak, entry) => Math.max(peak, entry.active_operation_ids.length), 0);
  const itemIds = unique(allRecords.map((entry) => entry.item_id)).sort();
  const by_item = Object.fromEntries(itemIds.map((id) => {
    const itemUsage = usageFromRecords(results, 'usage', id, allRecords);
    const itemRecords = allRecords.filter((entry) => entry.item_id === id);
    itemUsage.item_count = 1;
    itemUsage.concurrency = itemRecords.reduce((peak, entry) => Math.max(peak,
      entry.active_operation_ids.filter((operationId) => allRecords.find((candidate) => candidate.dispatch_id === operationId)?.item_id === id).length), 0);
    return [id, itemUsage];
  }));
  const activeItems = new Set(accounting.reservations.map((entry) => entry.item_id));
  const failedItems = new Set(results.filter((entry) => entry.status !== 'completed').map((entry) => entry.item_id));
  const runExceeded = firstExceeded(usage, policy.limits.per_run);
  const itemExceeded = itemIds.map((id) => [id, firstExceeded(by_item[id], policy.limits.per_item)]).find(([, field]) => field);
  const exceededItems = new Set(runExceeded ? itemIds : itemExceeded ? [itemExceeded[0]] : []);
  const completed_items = itemIds.filter((id) => !activeItems.has(id) && !failedItems.has(id) && !exceededItems.has(id));
  const incomplete_items = unique([...activeItems, ...failedItems, ...exceededItems, ...accounting.partial_truth.denials.map((entry) => entry.item_id)]).sort();
  let stop_reason = accounting.partial_truth.denials[0]?.reason ?? null;
  if (!stop_reason && runExceeded) stop_reason = `post-result:run:${runExceeded}-cap-exceeded`;
  if (!stop_reason && itemExceeded) stop_reason = `post-result:item:${itemExceeded[1]}-cap-exceeded`;
  if (!stop_reason) {
    const failed = results.find((entry) => entry.status !== 'completed');
    if (failed) stop_reason = `result:${failed.status}`;
  }
  return { usage, by_item, completed_items, incomplete_items, stopped: stop_reason !== null, stop_reason };
}

export function assertAccountingIntegrity({ policy, accounting }) {
  exactKeys(accounting, ['schema_version', 'policy_digest', 'usage', 'by_item', 'reservations', 'stopped', 'stop_reason', 'partial_truth'], 'accounting');
  if (accounting.schema_version !== '1.0.0' || accounting.policy_digest !== sha256Digest(policy)) fail('accounting is bound to a different policy or schema');
  exactKeys(accounting.partial_truth, ['completed_items', 'incomplete_items', 'results', 'denials'], 'accounting.partial_truth');
  if (!Array.isArray(accounting.reservations) || !Array.isArray(accounting.partial_truth.results)
    || !Array.isArray(accounting.partial_truth.denials) || !Array.isArray(accounting.partial_truth.completed_items)
    || !Array.isArray(accounting.partial_truth.incomplete_items)) fail('accounting collections must be arrays');
  const records = [...accounting.partial_truth.results, ...accounting.reservations];
  accounting.reservations.forEach((entry, index) => assertOperationRecord(entry, `reservation[${index}]`, 'expected_usage'));
  accounting.partial_truth.results.forEach((entry, index) => assertOperationRecord(entry, `result[${index}]`, 'usage'));
  const ids = records.map((entry) => entry.dispatch_id);
  if (unique(ids).length !== ids.length) fail('duplicate active or completed operation ID');
  const ordinals = records.map((entry) => entry.ordinal).sort((a, b) => a - b);
  if (canonicalJson(ordinals) !== canonicalJson(Array.from({ length: records.length }, (_, index) => index + 1))) fail('operation ordinals must be unique and contiguous');
  const byId = new Map(records.map((entry) => [entry.dispatch_id, entry]));
  for (const record of records) {
    if (record.active_operation_ids.some((id) => !byId.has(id) || byId.get(id).ordinal > record.ordinal)) fail('active-operation snapshot contains an unknown or future operation');
    const expectedItemCount = records.some((candidate) => candidate.item_id === record.item_id && candidate.ordinal < record.ordinal) ? 0 : 1;
    if (record.expected_usage.item_count !== expectedItemCount || record.expected_usage.concurrency !== record.active_operation_ids.length) {
      fail('expected usage item_count and concurrency must equal policy-derived operation values');
    }
    if ('usage' in record && (record.usage.item_count !== expectedItemCount || record.usage.concurrency !== record.active_operation_ids.length)) {
      fail('actual usage item_count and concurrency must equal policy-derived operation values');
    }
  }
  for (const [index, denial] of accounting.partial_truth.denials.entries()) {
    exactKeys(denial, ['dispatch_id', 'item_id', 'role', 'expected_usage', 'active_operation_ids', 'reason'], `denial[${index}]`);
    assertOperation(operationFrom(denial), `denial[${index}]`); assertUsage(denial.expected_usage, `denial[${index}].expected_usage`);
    if (!Array.isArray(denial.active_operation_ids) || !denial.active_operation_ids.includes(denial.dispatch_id)
      || typeof denial.reason !== 'string' || !denial.reason.startsWith('pre-dispatch:')) fail('denial record is invalid');
  }
  const derived = rebuildAccounting(policy, accounting);
  for (const field of ['usage', 'by_item', 'stopped', 'stop_reason']) {
    if (canonicalJson(accounting[field]) !== canonicalJson(derived[field])) fail(`accounting ${field} is inconsistent with immutable result records`);
  }
  for (const field of ['completed_items', 'incomplete_items']) {
    if (canonicalJson(accounting.partial_truth[field]) !== canonicalJson(derived[field])) fail(`accounting ${field} is inconsistent with immutable result records`);
  }
  return accounting;
}

function withDerived(accounting, policy) {
  const derived = rebuildAccounting(policy, accounting);
  return {
    ...accounting, usage: derived.usage, by_item: derived.by_item, stopped: derived.stopped, stop_reason: derived.stop_reason,
    partial_truth: { ...accounting.partial_truth, completed_items: derived.completed_items, incomplete_items: derived.incomplete_items }
  };
}

export function checkBeforeDispatch({ policy, accounting, operation, expectedUsage }) {
  assertUsage(expectedUsage, 'expected usage');
  assertOperation(operation);
  assertAccountingIntegrity({ policy, accounting });
  if (accounting.stopped) return { allowed: false, accounting };
  const completedIds = accounting.partial_truth.results.map((entry) => entry.dispatch_id);
  if ([...completedIds, ...accounting.reservations.map((entry) => entry.dispatch_id)].includes(operation.handoff_id)) fail('duplicate active or completed operation ID');
  const ordinal = completedIds.length + accounting.reservations.length + 1;
  const active_operation_ids = [...accounting.reservations.map((entry) => entry.dispatch_id), operation.handoff_id];
  const knownItem = [...accounting.partial_truth.results, ...accounting.reservations].some((entry) => entry.item_id === operation.item_id);
  if (expectedUsage.item_count !== (knownItem ? 0 : 1) || expectedUsage.concurrency !== active_operation_ids.length) {
    fail('expected usage item_count and concurrency must equal policy-derived operation values');
  }
  const reservation = {
    dispatch_id: operation.handoff_id, item_id: operation.item_id, role: operation.role,
    ordinal, active_operation_ids, expected_usage: stable(expectedUsage)
  };
  const projectedRecords = [...accounting.partial_truth.results, ...accounting.reservations, reservation];
  let runProjection = addUsage(accounting.usage, usageFromRecords([...accounting.reservations, reservation], 'expected_usage'));
  runProjection.item_count = new Set(projectedRecords.map((entry) => entry.item_id)).size;
  runProjection.concurrency = active_operation_ids.length;
  const runExceeded = firstExceeded(runProjection, policy.limits.per_run);
  const itemUsage = accounting.by_item[operation.item_id] ?? zeroUsage();
  const itemReservations = [...accounting.reservations, reservation].filter((entry) => entry.item_id === operation.item_id);
  const projectedItem = addUsage(itemUsage, usageFromRecords(itemReservations, 'expected_usage', operation.item_id));
  projectedItem.item_count = 1; projectedItem.concurrency = itemReservations.length;
  const itemExceeded = firstExceeded(projectedItem, policy.limits.per_item);
  const exceeded = runExceeded ? `run:${runExceeded}` : itemExceeded ? `item:${itemExceeded}` : null;
  if (exceeded) {
    const denial = {
      dispatch_id: operation.handoff_id, item_id: operation.item_id, role: operation.role, expected_usage: stable(expectedUsage),
      active_operation_ids, reason: `pre-dispatch:${exceeded}-cap-exceeded`
    };
    const denied = withDerived({ ...accounting, partial_truth: { ...accounting.partial_truth, denials: [...accounting.partial_truth.denials, denial] } }, policy);
    return { allowed: false, accounting: denied };
  }
  return {
    allowed: true, dispatch_id: operation.handoff_id,
    accounting: withDerived({ ...accounting, reservations: [...accounting.reservations, reservation] }, policy)
  };
}

export function recordDispatchResult({ policy, accounting, dispatchId, actualUsage, status = 'completed' }) {
  assertUsage(actualUsage, 'actual usage');
  assertAccountingIntegrity({ policy, accounting });
  if (accounting.stopped) fail(`cannot record a result after accounting stopped: ${accounting.stop_reason}`);
  const reservation = accounting.reservations.find((entry) => entry.dispatch_id === dispatchId);
  if (!reservation) fail('result does not match an active dispatch reservation');
  if (actualUsage.item_count !== reservation.expected_usage.item_count || actualUsage.concurrency !== reservation.expected_usage.concurrency) {
    fail('actual usage item_count and concurrency must equal reserved policy-derived values');
  }
  const reservations = accounting.reservations.filter((entry) => entry.dispatch_id !== dispatchId);
  let next = withDerived({
    ...accounting, reservations,
    partial_truth: {
      ...accounting.partial_truth,
      results: [...accounting.partial_truth.results, { ...reservation, status, usage: stable(actualUsage) }],
    },
  }, policy);
  assertAccountingIntegrity({ policy, accounting: next });
  return { accepted: !next.stopped, accounting: next };
}

export function assertAccountingReady({ policy, accounting, itemId, handoffs }) {
  if (!accounting) fail('deterministic delivery accounting is required');
  assertAccountingIntegrity({ policy, accounting });
  if (accounting.stopped) fail(`accounting stopped: ${accounting.stop_reason}`);
  if (accounting.reservations.length !== 0) fail('accounting has incomplete dispatches');
  assertUsage(accounting.usage, 'run accounting');
  const itemUsage = accounting.by_item[itemId];
  if (!itemUsage) fail('item accounting is required');
  assertUsage(itemUsage, 'item accounting');
  const exceeded = firstExceeded(accounting.usage, policy.limits.per_run) ?? firstExceeded(itemUsage, policy.limits.per_item);
  if (exceeded) fail(`${exceeded} cap exceeded`);
  if (!Array.isArray(handoffs) || handoffs.length === 0) fail('exact handoff chain is required for accounting reconciliation');
  const expected = handoffs.map((handoff) => ({ dispatch_id: handoff.handoff_id, item_id: handoff.item_id, role: handoff.role }));
  const actual = accounting.partial_truth.results.map(({ dispatch_id, item_id, role }) => ({ dispatch_id, item_id, role }));
  if (canonicalJson(actual) !== canonicalJson(expected)) fail('completed successful result set must match the exact handoff chain one-for-one');
  for (let index = 0; index < handoffs.length; index += 1) {
    const result = accounting.partial_truth.results[index]; const handoff = handoffs[index];
    if (result.status !== 'completed') fail(`handoff operation ${handoff.handoff_id} did not complete successfully`);
    const elapsed = parseCanonicalUtcInstant(handoff.completed_at, 'handoff completed_at') - parseCanonicalUtcInstant(handoff.started_at, 'handoff started_at');
    if (result.usage.duration_ms !== elapsed) fail(`handoff operation ${handoff.handoff_id} duration does not match dispatch accounting`);
  }
  return accounting;
}
