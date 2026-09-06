#!/usr/bin/env node
// Turn a request for new curriculum into an opportunity proposal.
//
// WHY THIS FILE CHANGED (2026-09-05). There were two halves of a path that
// never met. The support page on project-42.dev sent a learner to open a
// GitHub issue; this script read a local JSON file in seed-inputs. Nothing
// anywhere read the issues, so the only way a learner's request could become a
// proposal was for a human to retype it into that file. Nobody ever did, and
// the script was not wired to any workflow either, so it had never run except
// by hand.
//
// So this now has TWO sources and one shape:
//   - GitHub issues carrying the request label on the curriculum repository,
//     filed through the structured issue form
//     (project42-content/.github/ISSUE_TEMPLATE/content-request.yml)
//   - the local JSON file, kept working as a fixture and as an operator escape
//     hatch for a request that arrives some other way
//
// The issue form's field LABELS are the contract, not its field ids: GitHub
// renders a submitted form as `### <label>` followed by the value, and the ids
// never appear in the body. Change a label in the template and you must change
// FIELD_LABELS here in the same commit.
//
// A malformed issue is REPORTED, never fatal. One learner filing a request
// with the objectives box blank must not stop every other request in the batch
// from reaching the pipeline. The rejected ones come back in the result so the
// caller can say out loud how many were dropped and why; a run that quietly
// converts three of eight requests and exits zero is the degraded-success
// failure this project has been bitten by before.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listIssuesByLabel, commentOnIssue, closeIssue } from './lib/github-issues.mjs';

export const DEFAULT_REQUEST_LABEL = 'content-request';
export const DEFAULT_REQUEST_REPO = 'project42dev/project42-content';

// label in the rendered issue body -> key on the request object.
export const FIELD_LABELS = Object.freeze({
  'Module title': 'title',
  'Learning path': 'pathId',
  'Level': 'level',
  'Summary': 'summary',
  'Learning objectives': 'objectives',
  'Estimated duration (minutes)': 'estimatedMinutes',
  'Intended audience': 'audience',
});

const REQUIRED_FIELDS = ['title', 'pathId', 'summary', 'objectives'];

// GitHub writes this into every optional field the filer left empty.
const NO_RESPONSE = /^_no response_$/i;

/** The module file name a request becomes. Deterministic, so a re-filed request collides rather than duplicating. */
export function slugifyRequestId(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug;
}

/**
 * Split a rendered issue-form body back into its fields.
 *
 * GitHub renders `### <label>` then a blank line then the value. Headings that
 * are not form labels are ignored rather than rejected: people edit issue
 * bodies and add their own sections, and an added section is not corruption.
 */
export function parseIssueFormBody(body) {
  const fields = {};
  if (typeof body !== 'string') return fields;
  const sections = body.split(/^###[ \t]+/m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf('\n');
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const value = (newline === -1 ? '' : section.slice(newline + 1)).trim();
    if (!Object.prototype.hasOwnProperty.call(FIELD_LABELS, heading)) continue;
    fields[FIELD_LABELS[heading]] = NO_RESPONSE.test(value) ? '' : value;
  }
  return fields;
}

/** One objective per line; the filer's bullet markers and numbering are not part of the objective. */
export function parseObjectives(value) {
  if (!value) return [];
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * A GitHub issue -> the same request shape the local JSON file carries.
 *
 * Returns { request } or { rejected: { issueNumber, reason } }. It never
 * throws on bad learner input: the learner is not the operator, and their
 * typo is not an outage.
 */
export function requestFromIssue(issue, { pathIds = null } = {}) {
  const issueNumber = Number(issue?.number);
  const reject = (reason) => ({ rejected: { issueNumber: Number.isFinite(issueNumber) ? issueNumber : null, reason } });

  if (!Number.isFinite(issueNumber)) return reject('issue has no number');
  const fields = parseIssueFormBody(issue?.body);

  const objectives = parseObjectives(fields.objectives);
  const missing = REQUIRED_FIELDS.filter((key) => (key === 'objectives' ? objectives.length === 0 : !fields[key]));
  if (missing.length > 0) {
    return reject(`missing or empty required field(s): ${missing.join(', ')}`);
  }

  const pathId = fields.pathId.trim();
  if (Array.isArray(pathIds) && pathIds.length > 0 && !pathIds.includes(pathId)) {
    return reject(`learning path "${pathId}" is not a known path`);
  }

  const id = slugifyRequestId(fields.title);
  if (!id) return reject('module title produced no usable identifier');

  const minutes = Number.parseInt(String(fields.estimatedMinutes ?? '').replace(/[^0-9]/g, ''), 10);

  return {
    request: {
      id,
      title: fields.title.trim(),
      pathId,
      level: (fields.level || '').trim().toLowerCase() || 'intermediate',
      audience: (fields.audience || '').trim() || undefined,
      estimatedMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
      summary: fields.summary.trim(),
      objectives,
      requestedBy: issue?.user?.login ? `github:${issue.user.login}` : 'community',
      priority: 'high',
      createdAt: issue?.created_at || undefined,
      // 2.4 depends on this surviving onto the proposal: without the issue
      // number there is no way back to the person who asked, and "we shipped
      // it" never reaches them.
      issueNumber,
      issueUrl: issue?.html_url || undefined,
      issueRepo: issue?.repository_url ? issue.repository_url.replace(/^.*\/repos\//, '') : undefined,
    },
  };
}

/** The one place the request shape becomes a proposal, whichever source it came from. */
export function proposalFromRequest(req) {
  if (!req.id || !req.title || !req.summary || !Array.isArray(req.objectives)) {
    throw new Error(`Invalid curriculum request format for item: ${JSON.stringify(req)}`);
  }

  const proposal = {
    id: `req-${req.id}`,
    kind: 'learn',
    surface: 'learn',
    targetPath: `modules/${req.pathId || 'discovery'}/${req.id}.json`,
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
  };

  if (Number.isFinite(Number(req.issueNumber))) {
    proposal.originatingIssue = {
      repo: req.issueRepo || DEFAULT_REQUEST_REPO,
      number: Number(req.issueNumber),
      ...(req.issueUrl ? { url: req.issueUrl } : {}),
    };
  }
  if (req.audience) proposal.audience = req.audience;

  return proposal;
}

export function ingestCurriculumRequests(requestsFilePath) {
  if (!existsSync(requestsFilePath)) {
    throw new Error(`Curriculum requests file not found: ${requestsFilePath}`);
  }

  const raw = readFileSync(requestsFilePath, 'utf8');
  const requests = JSON.parse(raw);

  if (!Array.isArray(requests)) {
    throw new Error('Curriculum requests file must contain a JSON array of requests');
  }

  return requests.map((req) => proposalFromRequest(req));
}

/**
 * Every labelled issue on the curriculum repository, as proposals.
 *
 * `rejected` is part of the return value, not a log line, so the caller has to
 * decide what to do about the ones that did not convert.
 */
export async function ingestCurriculumRequestsFromGitHub({
  repo = DEFAULT_REQUEST_REPO,
  label = DEFAULT_REQUEST_LABEL,
  token,
  fetchImpl = fetch,
  pathIds = null,
  state = 'open',
} = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('a GitHub token is required to read curriculum request issues');
  }
  const issues = await listIssuesByLabel({ repo, label, state, token, fetchImpl });
  const proposals = [];
  const rejected = [];
  for (const issue of issues) {
    const outcome = requestFromIssue(issue, { pathIds });
    if (outcome.rejected) {
      rejected.push(outcome.rejected);
      continue;
    }
    proposals.push(proposalFromRequest({ ...outcome.request, issueRepo: outcome.request.issueRepo || repo }));
  }
  return { proposals, rejected, considered: issues.length };
}

/**
 * Tell the person who asked that the thing they asked for exists, and close
 * their issue.
 *
 * A request that is fulfilled in silence is, from the requester's side,
 * indistinguishable from one that was ignored, and the second time that
 * happens they stop filing them.
 *
 * Reusable on purpose: the moment a module truly becomes published lives in
 * the publication engine inside the container job, which has no GitHub
 * credential for the curriculum repository. This function is called from the
 * acceptance path that CAN reach GitHub, and is ready for the engine to call
 * the day it is given a token.
 */
export async function announcePublishedRequest({
  proposal,
  publishedPath = null,
  token,
  fetchImpl = fetch,
  close = true,
  reference = null,
}) {
  const origin = proposal?.originatingIssue;
  if (!origin?.repo || !Number.isFinite(Number(origin.number))) {
    return { announced: false, reason: 'proposal carries no originating issue' };
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { announced: false, reason: 'no GitHub token available to comment on the originating issue' };
  }

  const target = publishedPath || proposal.targetPath;
  const lines = [
    `**Published: ${proposal.title}**`,
    '',
    `The module you requested is live in the curriculum as \`${target}\`.`,
    ...(reference ? ['', `Reference: ${reference}`] : []),
    '',
    'Thank you for the request. Reopen this issue if the published module does not answer it.',
  ];
  const body = lines.join('\n');

  if (close) {
    const result = await closeIssue({ repo: origin.repo, issueNumber: origin.number, comment: body, token, fetchImpl });
    return { announced: true, closed: result.state === 'closed', number: result.number };
  }
  const comment = await commentOnIssue({ repo: origin.repo, issueNumber: origin.number, body, token, fetchImpl });
  return { announced: true, closed: false, number: origin.number, commentUrl: comment.url };
}

/**
 * The envelope merge-opportunity-proposals.mjs actually reads.
 *
 * A FOURTH BREAK IN THE SAME PATH, found 2026-09-05. This script wrote a bare
 * JSON array; mergeProposals iterates `proposals.opportunities`. Feeding one to
 * the other therefore merged NOTHING and reported no error, which is the
 * quietest possible way for a learner's request to die. Emitting the envelope
 * is what makes the ingest's output usable by the next step at all.
 */
export function proposalsEnvelope(proposals, { source = 'curriculum-request-ingest', generatedAt = new Date().toISOString() } = {}) {
  return { generatedAt, source, opportunities: proposals };
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [flag, inline] = token.slice(2).split('=');
      args[flag] = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

/**
 * The CLI.
 *
 * EXIT CODES ARE THE CONTRACT with the workflow, so they are set on
 * process.exitCode and returned, never thrown by process.exit(). Calling
 * process.exit() while a fetch is still unwinding aborts libuv mid-close on
 * Windows: the process dies with "Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)" and reports 127, so the deliberate 2 ("some requests were
 * malformed") and 3 ("rate limited") never reach the caller that has to tell
 * them apart.
 *
 *   0  every labelled request converted
 *   1  could not read the requests at all
 *   2  read them, but one or more were malformed and were skipped
 *   3  rate limited; nothing was read and nothing was written
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputFile = resolve(process.cwd(), args.out || args.positional[1] || 'proposals-direct-requests.json');

  let proposals;
  if (args['from-issues'] === 'true' || args['issues-repo']) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.error('GITHUB_TOKEN (or GH_TOKEN) is required to read curriculum request issues');
      return 1;
    }
    let result;
    try {
      result = await ingestCurriculumRequestsFromGitHub({
        repo: args['issues-repo'] || DEFAULT_REQUEST_REPO,
        label: args.label || DEFAULT_REQUEST_LABEL,
        token,
      });
    } catch (err) {
      // A stack trace tells an operator nothing they can act on, and the two
      // 403s that matter here look identical until you read GitHub's message:
      // "you may not" and "you have used your quota" need opposite responses.
      if (err?.rateLimited) {
        const resetAt = err.resetAt ? new Date(Number(err.resetAt) * 1000).toISOString() : 'an unknown time';
        console.error(`RATE LIMITED reading content requests. The quota resets at ${resetAt}. No proposals were written.`);
        return 3;
      }
      console.error(`FAILED reading content requests: ${err?.message ?? err}`);
      return 1;
    }
    proposals = result.proposals;
    console.log(`Considered ${result.considered} labelled issue(s); converted ${proposals.length}.`);
    if (result.rejected.length > 0) {
      // Loud, and non-zero at the end: a partial conversion is not a success.
      console.error(`REJECTED ${result.rejected.length} request(s):`);
      for (const r of result.rejected) console.error(`  issue #${r.issueNumber}: ${r.reason}`);
    }
    writeFileSync(outputFile, JSON.stringify(proposalsEnvelope(proposals), null, 2) + '\n', 'utf8');
    console.log(`Wrote ${proposals.length} opportunity proposal(s) to ${outputFile}`);
    return result.rejected.length > 0 ? 2 : 0;
  }

  const inputFile = resolve(process.cwd(), args.input || args.positional[0] || 'seed-inputs/curriculum-requests.json');
  proposals = ingestCurriculumRequests(inputFile);
  writeFileSync(outputFile, JSON.stringify(proposalsEnvelope(proposals, { source: 'curriculum-request-file' }), null, 2) + '\n', 'utf8');
  console.log(`Successfully converted ${proposals.length} curriculum request(s) into opportunity proposals at ${outputFile}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('ingest-curriculum-requests.mjs')) {
  process.exitCode = await main();
}
