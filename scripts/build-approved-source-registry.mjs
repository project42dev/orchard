#!/usr/bin/env node
// Build the approved source registry that Track 1 binds to.
//
// Track 1 fetches from the public internet on the deployer's behalf, so the
// runtime refuses to start without a registry in which every ENABLED source
// carries a reviewed policy: an approval reference, an owner, a licence terms
// review, a robots policy, a rate policy, an evidence retention class, a
// review date and cadence, and the hosts it may contact. That contract lives
// in loadApprovedSourceRegistry in lib/track-1-controller.mjs and it fails
// closed.
//
// This script does not INVENT approvals. It joins three inputs:
//
//   1. the watch list, which says what exists
//   2. the robots review, which is machine-gathered evidence from each host
//   3. the approvals file, which is where a human records a decision
//
// A source with no recorded decision is emitted disabled with approval
// "pending" and a stated reason, which is valid and which Track 1 will skip.
// Regenerating is safe and deterministic: the output is a pure function of the
// three inputs, so a reviewer can re-run it and diff.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REGISTRY_VERSION = '1.0.0';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i += 1; }
  }
  return args;
}

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`${what} not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The rate policy is taken from the host's own Crawl-delay when it publishes
// one, because a number the site chose beats a number we chose.
function ratePolicyFor(evidence, defaultDelaySeconds) {
  if (evidence?.crawlDelaySeconds) {
    return `At most one request per ${evidence.crawlDelaySeconds} seconds, the Crawl-delay ${evidence.host} publishes in its own robots.txt. One request per run; Track 1 reads the listing page only.`;
  }
  return `At most one request per ${defaultDelaySeconds} seconds. ${evidence?.host ?? 'The host'} publishes no Crawl-delay, so this is the conservative default. One request per run; Track 1 reads the listing page only.`;
}

function robotsPolicyFor(evidence, reviewedAt) {
  if (evidence?.robotsAllowsWildcardAgent === true) {
    const rule = evidence.matchedRule ? `matched "${evidence.matchedRule}"` : evidence.basis;
    return `Honoured. Checked ${reviewedAt}: https://${evidence.host}/robots.txt permits a generic agent on this path (${rule}).`;
  }
  if (evidence?.robotsAllowsWildcardAgent === false) {
    return `Honoured. Checked ${reviewedAt}: https://${evidence.host}/robots.txt DISALLOWS a generic agent on this path (${evidence.matchedRule}). Not fetched.`;
  }
  return `Undetermined. Checked ${reviewedAt}: ${evidence?.basis ?? 'robots.txt could not be read'}. Treated as refusal until a human resolves it.`;
}

export function buildRegistry({ watchList, robotsEvidence, approvals, reviewedAt, defaultDelaySeconds = 30 }) {
  const evidenceById = new Map((robotsEvidence?.sources ?? []).map((s) => [s.id, s]));
  const decisionById = new Map((approvals?.decisions ?? []).map((d) => [d.id, d]));

  const approvedSources = watchList.map((entry) => {
    const url = new URL(entry.url);
    const evidence = evidenceById.get(entry.id);
    const decision = decisionById.get(entry.id);
    const base = {
      id: entry.id,
      label: entry.label ?? entry.id,
      url: entry.url,
      kind: entry.kind ?? null,
    };

    if (decision?.approval !== 'approved') {
      const reason = decision?.statusReason
        ?? (evidence?.robotsAllowsWildcardAgent === false
          ? `Held: the host's robots.txt disallows a generic agent on this path (${evidence.matchedRule}).`
          : evidence?.robotsAllowsWildcardAgent === null
            ? `Held: robots.txt could not be read (${evidence.basis}), so permission is unknown and unknown is not permission.`
            : 'Held: no human approval has been recorded for this source.');
      return {
        ...base,
        enabled: false,
        policy: {
          approval: decision?.approval ?? 'pending',
          statusReason: reason,
          robotsEvidence: evidence?.basis ?? 'not checked',
        },
      };
    }

    return {
      ...base,
      enabled: true,
      policy: {
        approval: 'approved',
        approvalReference: decision.approvalReference,
        owner: decision.owner ?? approvals.defaultOwner,
        licenseTermsReview: decision.licenseTermsReview ?? approvals.defaultLicenseTermsReview,
        robotsPolicy: robotsPolicyFor(evidence, reviewedAt),
        ratePolicy: decision.ratePolicy ?? ratePolicyFor(evidence, defaultDelaySeconds),
        evidenceRetentionClass: decision.evidenceRetentionClass ?? approvals.defaultEvidenceRetentionClass,
        reviewedAt: decision.reviewedAt ?? reviewedAt,
        reviewCadenceDays: decision.reviewCadenceDays ?? approvals.defaultReviewCadenceDays,
        allowedHosts: decision.allowedHosts ?? [url.hostname],
      },
    };
  });

  return { registryVersion: REGISTRY_VERSION, generatedFrom: 'build-approved-source-registry.mjs', approvedSources };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.watchlist || !args.approvals || !args.out) {
    console.error('usage: build-approved-source-registry.mjs --watchlist <opportunity-registry.json> --approvals <source-approvals.json> --out <approved-source-registry.json> [--robots <robots-review.json>] [--reviewed-at YYYY-MM-DD]');
    process.exit(2);
  }
  const watchDoc = readJson(args.watchlist, 'watch list');
  const watchList = watchDoc.watchList ?? watchDoc.sources ?? [];
  if (!watchList.length) throw new Error(`${args.watchlist} has no watchList entries`);

  const approvals = readJson(args.approvals, 'approvals file');
  const robotsEvidence = args.robots ? readJson(args.robots, 'robots review') : { sources: [] };
  const reviewedAt = typeof args['reviewed-at'] === 'string' ? args['reviewed-at'] : approvals.reviewedAt;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt ?? '')) throw new Error('a reviewedAt date is required, as YYYY-MM-DD, in the approvals file or --reviewed-at');

  const registry = buildRegistry({ watchList, robotsEvidence, approvals, reviewedAt });

  // Prove the output against the runtime's own loader before writing it. A
  // registry that this script accepts and the runtime rejects is worse than no
  // registry, because the failure lands in production instead of here.
  const { loadApprovedSourceRegistry } = await import('./lib/track-1-controller.mjs');
  const loaded = loadApprovedSourceRegistry(registry, { allowLegacyMetadata: false, requirePolicyReview: true });

  writeFileSync(args.out, `${JSON.stringify(registry, null, 2)}\n`);

  const enabled = registry.approvedSources.filter((s) => s.enabled);
  const held = registry.approvedSources.filter((s) => !s.enabled);
  console.log(`approved source registry written to ${args.out}`);
  console.log(`  enabled   ${enabled.length}`);
  console.log(`  held      ${held.length}`);
  console.log(`  hosts     ${new Set(enabled.map((s) => new URL(s.url).hostname)).size} distinct, across enabled sources`);
  console.log(`  canonical digest ${loaded.digest}`);
  if (held.length) {
    console.log('\nheld, and why:');
    for (const source of held) console.log(`  ${source.id.padEnd(28)} ${source.policy.statusReason}`);
  }
}

if (process.argv[1]?.endsWith('build-approved-source-registry.mjs')) {
  await main();
}
