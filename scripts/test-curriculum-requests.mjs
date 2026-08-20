import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { ingestCurriculumRequests } from './ingest-curriculum-requests.mjs';

const requestsPath = resolve(import.meta.dirname, '../seed-inputs/curriculum-requests.json');

test('ingests operator and user curriculum requests into valid opportunity proposals', () => {
  const proposals = ingestCurriculumRequests(requestsPath);
  assert.ok(proposals.length >= 2, 'Expected at least 2 curriculum requests');
  
  const foundryItem = proposals.find((p) => p.id === 'req-ai-foundry-custom-models');
  assert.ok(foundryItem, 'Expected ai-foundry-custom-models proposal');
  assert.equal(foundryItem.title, 'Microsoft AI Foundry & Bringing Your Own Models and Agents');
  assert.equal(foundryItem.targetPath, 'content/modules/discovery/ai-foundry-custom-models.json');
  assert.ok(foundryItem.objectives.length >= 3);

  const orchestrationItem = proposals.find((p) => p.id === 'req-advanced-multi-agent-orchestration');
  assert.ok(orchestrationItem, 'Expected advanced-multi-agent-orchestration proposal');
  assert.equal(orchestrationItem.title, 'Advanced Multi-Agent Orchestration & Topologies');
  assert.equal(orchestrationItem.level, 'advanced');
  assert.ok(orchestrationItem.objectives.length >= 4);
});
