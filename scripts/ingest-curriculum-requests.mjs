#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function ingestCurriculumRequests(requestsFilePath) {
  if (!existsSync(requestsFilePath)) {
    throw new Error(`Curriculum requests file not found: ${requestsFilePath}`);
  }

  const raw = readFileSync(requestsFilePath, 'utf8');
  const requests = JSON.parse(raw);

  if (!Array.isArray(requests)) {
    throw new Error('Curriculum requests file must contain a JSON array of requests');
  }

  const proposals = [];
  for (const req of requests) {
    if (!req.id || !req.title || !req.summary || !Array.isArray(req.objectives)) {
      throw new Error(`Invalid curriculum request format for item: ${JSON.stringify(req)}`);
    }

    proposals.push({
      id: `req-${req.id}`,
      kind: 'learn',
      surface: 'learn',
      targetPath: `content/modules/${req.pathId || 'discovery'}/${req.id}.json`,
      title: req.title,
      summary: req.summary,
      level: req.level || 'intermediate',
      estimatedMinutes: req.estimatedMinutes || 25,
      objectives: req.objectives,
      providers: ['provider-neutral'],
      source: 'direct-curriculum-request',
      requestedBy: req.requestedBy || 'operator',
      priority: req.priority || 'high',
      status: 'pending-authoring',
      createdAt: req.createdAt || new Date().toISOString(),
    });
  }

  return proposals;
}

if (process.argv[1] && process.argv[1].endsWith('ingest-curriculum-requests.mjs')) {
  const inputFile = process.argv[2] || resolve(process.cwd(), 'seed-inputs/curriculum-requests.json');
  const outputFile = process.argv[3] || resolve(process.cwd(), 'proposals-direct-requests.json');
  
  const proposals = ingestCurriculumRequests(inputFile);
  writeFileSync(outputFile, JSON.stringify(proposals, null, 2) + '\n', 'utf8');
  console.log(`Successfully converted ${proposals.length} curriculum request(s) into opportunity proposals at ${outputFile}`);
}
