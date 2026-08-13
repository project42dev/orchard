#!/usr/bin/env node
// ACA integration test: triggers the harness job and verifies the run record.
//
// This test requires:
//   - Azure CLI authenticated with access to the delivery platform subscription
//   - The harness ACA job deployed (caj-p42-harness-prod-eus-01)
//   - Network access to the storage account for run record download
//
// It does NOT require a model endpoint — the harness job uses the deployed
// endpoint. It costs real money per run (~$0.50–$2.00 depending on model).
//
// Usage:
//   node scripts/test-lifecycle-aca.mjs
//
// Environment variables:
//   ACA_SUBSCRIPTION    — Azure subscription ID (default: from az account show)
//   ACA_RESOURCE_GROUP  — Resource group (default: rg-p42-delivery-prod-eus-01)
//   ACA_JOB_NAME        — Harness job name (default: caj-p42-harness-prod-eus-01)
//   ACA_POLL_TIMEOUT_MS — Max poll time in ms (default: 600000 = 10 min)
//   ACA_SKIP_TRIGGER    — If '1', skip triggering and only verify existing records

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const SUBSCRIPTION = process.env.ACA_SUBSCRIPTION || execFileSync(
    'az', ['account', 'show', '--query', 'id', '-o', 'tsv'], { encoding: 'utf8', timeout: 10000 }
).trim();
const RESOURCE_GROUP = process.env.ACA_RESOURCE_GROUP || 'rg-p42-delivery-prod-eus-01';
const JOB_NAME = process.env.ACA_JOB_NAME || 'caj-p42-harness-prod-eus-01';
const POLL_TIMEOUT_MS = parseInt(process.env.ACA_POLL_TIMEOUT_MS || '600000', 10);
const SKIP_TRIGGER = process.env.ACA_SKIP_TRIGGER === '1';

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(SUBSCRIPTION)) throw new Error('ACA_SUBSCRIPTION must be an Azure subscription UUID');
if (!/^[A-Za-z0-9._()\-]{1,90}$/.test(RESOURCE_GROUP)) throw new Error('ACA_RESOURCE_GROUP is invalid');
if (!/^[A-Za-z0-9-]{2,32}$/.test(JOB_NAME)) throw new Error('ACA_JOB_NAME is invalid');
if (!Number.isSafeInteger(POLL_TIMEOUT_MS) || POLL_TIMEOUT_MS < 1) throw new Error('ACA_POLL_TIMEOUT_MS must be a positive integer');

let passed = 0;
const failures = [];

function check(label, condition) {
    if (condition) { passed += 1; }
    else { failures.push(label); }
}

function equal(label, actual, expected) {
    check(`${label} (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`,
        actual === expected);
}

function az(args, timeoutMs = 30000) {
    const fullArgs = [...args, '--subscription', SUBSCRIPTION, '-o', 'json'];
    try {
        const result = execFileSync('az', fullArgs, {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(result);
    } catch (e) {
        if (e.stderr) {
            console.error(`  az error: ${e.stderr.toString().trim()}`);
        }
        throw new Error(`az ${args[0]} ${args[1]} failed: ${e.message}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Verify prerequisites ----------------------------------------------------

console.log('1. Verifying prerequisites...');

// Check az CLI is available
try {
    execFileSync('az', ['version'], { encoding: 'utf8', timeout: 10000, stdio: 'ignore' });
    check('az CLI is available', true);
} catch {
    check('az CLI is available', false);
    console.error('  Azure CLI is not available. Install it and log in with `az login`.');
    process.exit(1);
}

// Check the job exists
let jobInfo;
try {
    jobInfo = az(['containerapp', 'job', 'show',
        '--name', JOB_NAME,
        '--resource-group', RESOURCE_GROUP,
    ]);
    check(`Job ${JOB_NAME} exists`, jobInfo?.name === JOB_NAME);
    console.log(`  Job provisioning state: ${jobInfo?.properties?.provisioningState}`);
} catch (e) {
    check(`Job ${JOB_NAME} exists`, false);
    console.error(`  Cannot find job ${JOB_NAME} in ${RESOURCE_GROUP}: ${e.message}`);
    process.exit(1);
}

// --- Trigger the harness job -------------------------------------------------

let executionName = null;

if (SKIP_TRIGGER) {
    console.log('\n2. Skipping trigger (ACA_SKIP_TRIGGER=1). Verifying existing records...');
} else {
    console.log('\n2. Triggering harness job...');

    try {
        const startResult = az(['containerapp', 'job', 'start',
            '--name', JOB_NAME,
            '--resource-group', RESOURCE_GROUP,
        ], 60000);

        // The start command returns the execution name
        executionName = startResult?.name;
        check('Job start returned an execution name', !!executionName);
        console.log(`  Execution: ${executionName}`);
    } catch (e) {
        check('Job start succeeded', false);
        console.error(`  Failed to start job: ${e.message}`);
        process.exit(1);
    }

    // --- Poll for completion -----------------------------------------------------

    console.log('\n3. Polling for completion...');
    const startTime = Date.now();
    let status = 'Running';
    let pollCount = 0;

    while (status === 'Running' || status === 'Processing' || status === 'Pending') {
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
            check('Job completed within timeout', false);
            console.error(`  Timed out after ${POLL_TIMEOUT_MS}ms. Last status: ${status}`);
            process.exit(1);
        }

        await sleep(15000); // Poll every 15 seconds
        pollCount++;

        try {
            const execList = az(['containerapp', 'job', 'execution', 'list',
                '--name', JOB_NAME,
                '--resource-group', RESOURCE_GROUP,
            ]);

            const ourExecution = execList?.find(e => e.name === executionName);
            if (ourExecution) {
                status = ourExecution.properties?.status || 'Unknown';
                console.log(`  Poll ${pollCount}: ${status}`);
            } else {
                console.log(`  Poll ${pollCount}: execution not yet visible`);
            }
        } catch (e) {
            console.log(`  Poll ${pollCount}: error fetching status (${e.message})`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    check('Job completed successfully', status === 'Succeeded');
    console.log(`  Final status: ${status} (after ${elapsed}s, ${pollCount} polls)`);

    if (status !== 'Succeeded') {
        // Try to get logs
        try {
            console.log('\n  Recent job logs:');
            execFileSync(
                'az', ['containerapp', 'job', 'logs', 'show', '--name', JOB_NAME, '--resource-group', RESOURCE_GROUP, '--subscription', SUBSCRIPTION, '--tail', '30'],
                { encoding: 'utf8', timeout: 30000, stdio: 'inherit' }
            );
        } catch {
            // Logs may not be available
        }
    }
}

// --- Verify run records ------------------------------------------------------

console.log('\n4. Verifying run records...');

// List recent executions
const recentExecutions = az(['containerapp', 'job', 'execution', 'list',
    '--name', JOB_NAME,
    '--resource-group', RESOURCE_GROUP,
]);

check('Execution list is an array', Array.isArray(recentExecutions));

if (recentExecutions && recentExecutions.length > 0) {
    const succeeded = recentExecutions.filter(
        e => e.properties?.status === 'Succeeded'
    );
    console.log(`  Total executions: ${recentExecutions.length}`);
    console.log(`  Succeeded: ${succeeded.length}`);

    check('At least one successful execution exists', succeeded.length > 0);

    // Show the most recent 3
    const recent = recentExecutions.slice(0, 3);
    for (const exec of recent) {
        const name = exec.name || 'unknown';
        const status = exec.properties?.status || 'unknown';
        const startTime = exec.properties?.startTime || 'unknown';
        console.log(`  ${name}: ${status} (started: ${startTime})`);
    }
} else {
    check('Execution list is non-empty', false);
}

// --- Verify content database (if accessible) ---------------------------------

console.log('\n5. Verifying content database...');

// The content database is in the storage account. Try to check if it exists
// and has recent content.
const dbPath = join(ROOT, 'content.db');
if (existsSync(dbPath)) {
    try {
        // Dynamic import for sqlite
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbPath);

        // Check work_item table
        const workItemCount = db.prepare('SELECT COUNT(*) as cnt FROM work_item').get();
        check('Content database has work items', workItemCount?.cnt > 0);
        console.log(`  Work items: ${workItemCount?.cnt}`);

        // Check publication table
        const pubCount = db.prepare('SELECT COUNT(*) as cnt FROM publication').get();
        console.log(`  Publications: ${pubCount?.cnt}`);

        // Check for recent publications (last 7 days)
        const recentPubs = db.prepare(
            "SELECT COUNT(*) as cnt FROM publication WHERE published_at > datetime('now', '-7 days')"
        ).get();
        console.log(`  Recent publications (7d): ${recentPubs?.cnt}`);

        // Check item table
        const itemCount = db.prepare('SELECT COUNT(*) as cnt FROM item').get();
        console.log(`  Items: ${itemCount?.cnt}`);

        // Check candidate table
        const candidateCount = db.prepare('SELECT COUNT(*) as cnt FROM candidate').get();
        console.log(`  Candidates: ${candidateCount?.cnt}`);

        db.close();
    } catch (e) {
        console.log(`  Could not query content database: ${e.message}`);
        check('Content database is queryable', false);
    }
} else {
    console.log(`  Content database not found at ${dbPath}`);
    console.log('  (This is expected if running in CI — the DB is in Azure Storage)');
}

// --- Summary -----------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
console.log(`ACA Integration Test: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`Assertions: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
}
console.log('='.repeat(60));

process.exit(failures.length === 0 ? 0 : 1);
