#!/usr/bin/env node
// Fetch and evaluate robots.txt for every host in the watch list.
//
// Track 1 fetches from the public internet on Orchard's behalf, so every
// approved source needs a stated robots policy. Determining that by hand for
// seventy odd hosts is slow and, worse, it is guesswork: a human reads a terms
// page and writes down an impression. robots.txt is a fact, published by the
// site itself, and it can be read in a minute.
//
// This produces EVIDENCE, not a decision. It answers "does this host's
// robots.txt permit a generic agent to read this path", which is one input to
// an approval. Licence terms, rate limits and retention are separate human
// judgements that no script can make.
//
// Read only. Fetches robots.txt and nothing else, one request per host.

import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const USER_AGENT = 'OrchardSourceReview/1.0 (+https://github.com/project42dev/orchard)';

// A minimal robots.txt evaluator. Only the parts that matter for a yes or no:
// group the rules by user-agent, prefer an exact agent match over the wildcard,
// and apply longest-match-wins between Allow and Disallow, which is what the
// major crawlers do.
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastLineWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one rule group.
      if (!lastLineWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
    }
  }
  return groups;
}

export function evaluateRobots(groups, pathname, agent = '*') {
  const lower = agent.toLowerCase();
  const exact = groups.filter((g) => g.agents.includes(lower));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = exact.length ? exact : wildcard;
  if (!applicable.length) return { allowed: true, rule: null, basis: 'no applicable group', crawlDelay: null };

  let best = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      // An empty Disallow means "allow everything" and matches nothing.
      if (rule.path === '') continue;
      const pattern = rule.path;
      if (!matchesRobotsPattern(pattern, pathname)) continue;
      const specificity = pattern.length;
      if (!best || specificity > best.specificity || (specificity === best.specificity && rule.allow)) {
        best = { allow: rule.allow, pattern, specificity };
      }
    }
  }
  const crawlDelay = applicable.map((g) => g.crawlDelay).filter((d) => d !== null).sort((a, b) => b - a)[0] ?? null;
  if (!best) return { allowed: true, rule: null, basis: 'no matching rule', crawlDelay };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}`, basis: 'longest match', crawlDelay };
}

function matchesRobotsPattern(pattern, pathname) {
  // robots.txt wildcards: * matches any run, $ anchors the end.
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const expression = new RegExp(`^${parts.join('.*')}${anchored ? '$' : ''}`);
  return expression.test(pathname);
}

async function fetchRobots(host) {
  const url = `https://${host}/robots.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*' },
    });
    // A 404 means no robots.txt, which means nothing is disallowed. A 401 or
    // 403 on robots.txt itself is the site refusing to talk to us, which is a
    // different answer and must not be read as permission.
    if (response.status === 404 || response.status === 410) {
      return { status: response.status, text: '', verdict: 'no robots.txt published' };
    }
    if (!response.ok) {
      return { status: response.status, text: null, verdict: `robots.txt returned ${response.status}` };
    }
    return { status: response.status, text: await response.text(), verdict: 'fetched' };
  } catch (error) {
    return { status: null, text: null, verdict: `unreachable: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function reviewSources(sources, { concurrency = 6, pauseMs = 250 } = {}) {
  const byHost = new Map();
  for (const source of sources) {
    const host = new URL(source.url).hostname;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(source);
  }

  const hosts = [...byHost.keys()];
  const robotsByHost = new Map();
  for (let offset = 0; offset < hosts.length; offset += concurrency) {
    const batch = hosts.slice(offset, offset + concurrency);
    const fetched = await Promise.all(batch.map((host) => fetchRobots(host)));
    batch.forEach((host, index) => robotsByHost.set(host, fetched[index]));
    process.stderr.write(`  robots.txt ${Math.min(offset + concurrency, hosts.length)}/${hosts.length}\n`);
    if (offset + concurrency < hosts.length) await delay(pauseMs);
  }

  const results = [];
  for (const source of sources) {
    const url = new URL(source.url);
    const robots = robotsByHost.get(url.hostname);
    let decision;
    if (robots.text === null) {
      decision = { allowed: null, rule: null, basis: robots.verdict, crawlDelay: null };
    } else if (robots.text === '') {
      decision = { allowed: true, rule: null, basis: robots.verdict, crawlDelay: null };
    } else {
      decision = evaluateRobots(parseRobots(robots.text), url.pathname + url.search, '*');
    }
    results.push({
      id: source.id,
      label: source.label,
      url: source.url,
      host: url.hostname,
      kind: source.kind ?? null,
      robotsStatus: robots.status,
      robotsAllowsWildcardAgent: decision.allowed,
      matchedRule: decision.rule,
      basis: decision.basis,
      crawlDelaySeconds: decision.crawlDelay,
    });
  }
  return results;
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    if (!process.argv[i].startsWith('--')) continue;
    const key = process.argv[i].slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i += 1; }
  }
  if (!args.watchlist || !args.out) {
    console.error('usage: check-source-robots.mjs --watchlist <opportunity-registry.json> --out <robots-review.json>');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const doc = JSON.parse(readFileSync(args.watchlist, 'utf8'));
  const sources = doc.watchList ?? doc.sources ?? [];
  if (!sources.length) throw new Error(`${args.watchlist} has no watchList entries`);

  console.error(`reviewing ${sources.length} source(s) across distinct hosts`);
  const results = await reviewSources(sources);
  writeFileSync(args.out, `${JSON.stringify({ reviewedWith: USER_AGENT, sources: results }, null, 2)}\n`);

  const allowed = results.filter((r) => r.robotsAllowsWildcardAgent === true).length;
  const denied = results.filter((r) => r.robotsAllowsWildcardAgent === false).length;
  const unknown = results.filter((r) => r.robotsAllowsWildcardAgent === null).length;
  console.error(`\nrobots.txt permits a generic agent: ${allowed}`);
  console.error(`robots.txt disallows:                ${denied}`);
  console.error(`could not be determined:             ${unknown}`);
  console.error(`\nwritten to ${args.out}`);
  console.error('This is evidence toward an approval, not an approval. Licence terms,');
  console.error('rate limits and evidence retention remain human judgements.');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-source-robots.mjs')) {
  await main();
}
