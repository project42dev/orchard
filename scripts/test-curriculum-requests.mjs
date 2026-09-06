import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  ingestCurriculumRequests,
  parseIssueFormBody,
  parseObjectives,
  requestFromIssue,
  ingestCurriculumRequestsFromGitHub,
  announcePublishedRequest,
  slugifyRequestId,
  proposalsEnvelope,
} from './ingest-curriculum-requests.mjs';

const requestsPath = resolve(import.meta.dirname, '../seed-inputs/curriculum-requests.json');

test('ingests operator and user curriculum requests into valid opportunity proposals', () => {
  const proposals = ingestCurriculumRequests(requestsPath);
  assert.ok(proposals.length >= 2, 'Expected at least 2 curriculum requests');

  const foundryItem = proposals.find((p) => p.id === 'req-ai-foundry-custom-models');
  assert.ok(foundryItem, 'Expected ai-foundry-custom-models proposal');
  assert.equal(foundryItem.title, 'Microsoft AI Foundry & Bringing Your Own Models and Agents');
  assert.equal(foundryItem.targetPath, 'modules/developer-and-practitioner-ai/ai-foundry-custom-models.json');
  assert.ok(foundryItem.objectives.length >= 3);

  const orchestrationItem = proposals.find((p) => p.id === 'req-advanced-multi-agent-orchestration');
  assert.ok(orchestrationItem, 'Expected advanced-multi-agent-orchestration proposal');
  assert.equal(orchestrationItem.title, 'Advanced Multi-Agent Orchestration & Topologies');
  assert.equal(orchestrationItem.level, 'advanced');
  assert.ok(orchestrationItem.objectives.length >= 4);
});

// --- GitHub issue source (2026-09-05) ---------------------------------------
// A learner's request must become a proposal with nobody retyping it. These
// tests drive the real code path with an injected fetch, so what is exercised
// is the same listIssuesByLabel -> requestFromIssue -> proposalFromRequest
// chain the workflow runs, not a stand-in for it.

// Exactly the shape GitHub renders a submitted issue form into.
const WELL_FORMED_BODY = [
  '### Module title',
  '',
  'Advanced Multi-Agent Orchestration & Topologies',
  '',
  '### Learning path',
  '',
  'agentic-systems-and-mcp',
  '',
  '### Level',
  '',
  'advanced',
  '',
  '### Summary',
  '',
  'Architecting robust multi-agent systems with hierarchical delegation and consensus ensembles.',
  '',
  '### Learning objectives',
  '',
  '- Implement supervisor, router, and peer-to-peer topologies',
  '- Enforce memory boundaries between agents',
  '3. Construct critique and verification ensembles',
  '',
  '### Estimated duration (minutes)',
  '',
  '30',
  '',
  '### Intended audience',
  '',
  'AI Engineers, Systems Architects, and Technical Leads',
  '',
].join('\n');

const MALFORMED_BODY = [
  '### Module title',
  '',
  'A Module With No Objectives',
  '',
  '### Learning path',
  '',
  'agentic-systems-and-mcp',
  '',
  '### Summary',
  '',
  'Something worth teaching.',
  '',
  '### Learning objectives',
  '',
  '_No response_',
  '',
].join('\n');

function issue(number, body, extra = {}) {
  return {
    number,
    body,
    html_url: `https://github.com/project42dev/project42-content/issues/${number}`,
    repository_url: 'https://api.github.com/repos/project42dev/project42-content',
    created_at: '2026-09-05T10:00:00.000Z',
    user: { login: 'learner-one' },
    ...extra,
  };
}

function fakeFetch(issues) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const payload = page === 1 ? issues : [];
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(payload),
      };
    },
  };
}

test('parses a well-formed issue-form body into every request field', () => {
  const fields = parseIssueFormBody(WELL_FORMED_BODY);
  assert.equal(fields.title, 'Advanced Multi-Agent Orchestration & Topologies');
  assert.equal(fields.pathId, 'agentic-systems-and-mcp');
  assert.equal(fields.level, 'advanced');
  assert.equal(fields.estimatedMinutes, '30');
  assert.equal(fields.audience, 'AI Engineers, Systems Architects, and Technical Leads');
  assert.deepEqual(parseObjectives(fields.objectives), [
    'Implement supervisor, router, and peer-to-peer topologies',
    'Enforce memory boundaries between agents',
    'Construct critique and verification ensembles',
  ]);
});

test('an empty optional field renders _No response_ and is not treated as a value', () => {
  const fields = parseIssueFormBody('### Intended audience\n\n_No response_\n');
  assert.equal(fields.audience, '');
});

test('a well-formed issue becomes a request carrying its originating issue', () => {
  const outcome = requestFromIssue(issue(42, WELL_FORMED_BODY), { pathIds: ['agentic-systems-and-mcp'] });
  assert.equal(outcome.rejected, undefined);
  assert.equal(outcome.request.id, 'advanced-multi-agent-orchestration-topologies');
  assert.equal(outcome.request.issueNumber, 42);
  assert.equal(outcome.request.issueRepo, 'project42dev/project42-content');
  assert.equal(outcome.request.requestedBy, 'github:learner-one');
  assert.equal(outcome.request.estimatedMinutes, 30);
});

test('a malformed issue is rejected with a reason and never throws', () => {
  const outcome = requestFromIssue(issue(43, MALFORMED_BODY));
  assert.equal(outcome.request, undefined);
  assert.equal(outcome.rejected.issueNumber, 43);
  assert.match(outcome.rejected.reason, /objectives/);

  const empty = requestFromIssue(issue(44, 'I would like a module about agents please.'));
  assert.match(empty.rejected.reason, /missing or empty required field/);

  const badPath = requestFromIssue(issue(45, WELL_FORMED_BODY), { pathIds: ['ai-foundations'] });
  assert.match(badPath.rejected.reason, /is not a known path/);
});

test('labelled issues become proposals with no human transcription, and bad ones are reported not dropped silently', async () => {
  const { fetchImpl, calls } = fakeFetch([
    issue(42, WELL_FORMED_BODY),
    issue(43, MALFORMED_BODY),
    { ...issue(44, WELL_FORMED_BODY), pull_request: { url: 'x' } },
  ]);

  const result = await ingestCurriculumRequestsFromGitHub({
    repo: 'project42dev/project42-content',
    label: 'content-request',
    token: 'test-token',
    fetchImpl,
    pathIds: ['agentic-systems-and-mcp'],
  });

  assert.match(calls[0], /labels=content-request/);
  assert.equal(result.considered, 2, 'a pull request carrying the label is not a content request');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].issueNumber, 43);

  const [proposal] = result.proposals;
  assert.equal(proposal.id, 'req-advanced-multi-agent-orchestration-topologies');
  assert.equal(proposal.source, 'direct-curriculum-request');
  assert.equal(proposal.status, 'pending-authoring');
  assert.equal(proposal.priority, 'high');
  assert.equal(proposal.surface, 'learn');
  assert.equal(
    proposal.targetPath,
    'modules/agentic-systems-and-mcp/advanced-multi-agent-orchestration-topologies.json',
  );
  assert.deepEqual(proposal.originatingIssue, {
    repo: 'project42dev/project42-content',
    number: 42,
    url: 'https://github.com/project42dev/project42-content/issues/42',
  });
});

test('a missing token is refused rather than silently reading nothing', async () => {
  await assert.rejects(() => ingestCurriculumRequestsFromGitHub({ token: '' }), /GitHub token is required/);
});

test('local-file ingest still works and carries no originating issue', () => {
  const proposals = ingestCurriculumRequests(requestsPath);
  assert.ok(proposals.every((p) => p.originatingIssue === undefined));
});

test('slugs are stable, so re-filing the same request collides instead of duplicating', () => {
  assert.equal(
    slugifyRequestId('Advanced Multi-Agent Orchestration & Topologies'),
    'advanced-multi-agent-orchestration-topologies',
  );
  assert.equal(slugifyRequestId('  RAG:  Chunking!!  '), 'rag-chunking');
  assert.equal(slugifyRequestId(''), '');
});

test('publishing a requested module comments on and closes the originating issue', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ number: 42, state: 'closed', html_url: 'https://example.invalid/c' }),
    };
  };

  const result = await announcePublishedRequest({
    proposal: {
      title: 'Advanced Multi-Agent Orchestration & Topologies',
      targetPath: 'modules/agentic-systems-and-mcp/advanced-multi-agent-orchestration-topologies.json',
      originatingIssue: { repo: 'project42dev/project42-content', number: 42 },
    },
    token: 'test-token',
    fetchImpl,
  });

  assert.equal(result.announced, true);
  assert.equal(result.closed, true);
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].url, /\/issues\/42\/comments$/);
  assert.match(requests[0].body.body, /Advanced Multi-Agent Orchestration/);
  assert.match(requests[0].body.body, /modules\/agentic-systems-and-mcp/);
  assert.equal(requests[1].method, 'PATCH');
  assert.deepEqual(requests[1].body, { state: 'closed', state_reason: 'completed' });
});

test('a proposal with no originating issue is a no-op, not a crash', async () => {
  const result = await announcePublishedRequest({ proposal: { title: 'x', targetPath: 'y' }, token: 't' });
  assert.equal(result.announced, false);
  assert.match(result.reason, /no originating issue/);
});

// --- the loop closes (2.4) ---------------------------------------------------
// The originating issue has to survive from the ingest all the way to the
// moment someone accepts the published module, or "we shipped what you asked
// for" never reaches the person who asked.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeProposals } from './merge-opportunity-proposals.mjs';
import { findOriginatingIssue } from './record-publication.mjs';

test('what the ingest writes is what the merge reads, and the originating issue survives it', () => {
  // REGRESSION GUARD. The ingest used to write a bare JSON array while
  // mergeProposals iterates `proposals.opportunities`, so feeding one to the
  // other merged zero requests and reported nothing wrong. If this file ever
  // goes back to writing an array, this test fails instead of the pipeline
  // going quiet.
  const proposal = {
    id: 'req-prompt-injection-defence',
    title: 'Prompt Injection Defence',
    targetPath: 'modules/ai-security-and-governance/prompt-injection-defence.json',
    source: 'direct-curriculum-request',
    originatingIssue: { repo: 'project42dev/project42-content', number: 101 },
  };
  const registry = { opportunities: [] };
  const report = mergeProposals(registry, proposalsEnvelope([proposal]), '2026-09-05T12:00:00.000Z');
  assert.deepEqual(report.added, ['req-prompt-injection-defence']);
  assert.deepEqual(report.invalid, []);
  const entry = registry.opportunities.find((o) => o.id === 'req-prompt-injection-defence');
  assert.ok(entry, 'the request must reach the registry');
  assert.deepEqual(entry.originatingIssue, { repo: 'project42dev/project42-content', number: 101 });
});

test('the originating issue is recoverable at publication time from the registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-request-loop-'));
  try {
    const registryPath = join(dir, 'opportunity-registry.json');
    writeFileSync(registryPath, JSON.stringify({
      opportunities: [
        { id: 'unrelated', source: 'discovery', targetPath: 'modules/x/y.json' },
        {
          id: 'req-prompt-injection-defence',
          title: 'Prompt Injection Defence',
          source: 'direct-curriculum-request',
          targetPath: 'modules/ai-security-and-governance/prompt-injection-defence.json',
          originatingIssue: { repo: 'project42dev/project42-content', number: 101 },
        },
      ],
    }), 'utf8');

    const byPath = findOriginatingIssue({
      registryPath,
      targetPath: 'modules/ai-security-and-governance/prompt-injection-defence.json',
      subjectId: 'anything',
    });
    assert.equal(byPath.issue.number, 101);

    const bySubject = findOriginatingIssue({ registryPath, targetPath: null, subjectId: 'prompt-injection-defence' });
    assert.equal(bySubject.issue.number, 101);

    assert.equal(findOriginatingIssue({ registryPath, targetPath: 'modules/x/y.json', subjectId: 'unrelated' }), null,
      'a discovery-sourced item has no requester to tell');
    assert.equal(findOriginatingIssue({ registryPath: null, targetPath: 'anything' }), null);
    assert.equal(findOriginatingIssue({ registryPath: join(dir, 'missing.json'), targetPath: 'anything' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
