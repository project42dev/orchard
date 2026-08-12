import { randomUUID } from "node:crypto";
import { validateTargetPath } from "./identity.mjs";

export const LEASE_SCOPE_TYPES = Object.freeze(["track-run", "item", "target-path"]);

function iso(value) {
    return (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
}

function expiry(now, ttlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
    return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

function validateScope(scopeType, scopeKey) {
    if (!LEASE_SCOPE_TYPES.includes(scopeType)) throw new TypeError(`unsupported lease scope: ${scopeType}`);
    if (typeof scopeKey !== "string" || scopeKey.length === 0) throw new TypeError("scopeKey must be non-empty");
}

function transaction(db, operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = operation();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
        throw error;
    }
}

export function trackRunLeaseScope(track) {
    if (track !== "track-1" && track !== "track-2") throw new TypeError("track must be track-1 or track-2");
    return { scopeType: "track-run", scopeKey: track };
}

export function itemLeaseScope(itemId) {
    if (typeof itemId !== "string" || itemId.length === 0) throw new TypeError("itemId must be non-empty");
    return { scopeType: "item", scopeKey: itemId };
}

export function targetPathLeaseScope(repository, path) {
    if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TypeError("repository must be owner/name");
    return { scopeType: "target-path", scopeKey: `${repository}:${validateTargetPath(path)}` };
}

export function acquireLease(db, { scopeType, scopeKey, owner, ttlMs, now = Date.now(), ownerToken = randomUUID() }) {
    validateScope(scopeType, scopeKey);
    if (typeof owner !== "string" || owner.length === 0) throw new TypeError("owner must be non-empty");
    if (typeof ownerToken !== "string" || ownerToken.length === 0) throw new TypeError("ownerToken must be non-empty");
    const acquiredAt = iso(now);
    const expiresAt = expiry(acquiredAt, ttlMs);

    return transaction(db, () => {
        const existing = db.prepare("SELECT * FROM lease WHERE scope_type = ? AND scope_key = ?").get(scopeType, scopeKey);
        if (existing && existing.expires_at > acquiredAt) return null;
        const generation = existing ? Number(existing.generation) + 1 : 1;
        if (existing) {
            const result = db.prepare(`UPDATE lease SET owner = ?, owner_token = ?, acquired_at = ?, renewed_at = ?, expires_at = ?, generation = ?
                WHERE scope_type = ? AND scope_key = ? AND generation = ? AND expires_at <= ?`).run(
                owner, ownerToken, acquiredAt, acquiredAt, expiresAt, generation,
                scopeType, scopeKey, existing.generation, acquiredAt
            );
            if (result.changes !== 1) return null;
        } else {
            db.prepare(`INSERT INTO lease (scope_type, scope_key, owner, owner_token, acquired_at, renewed_at, expires_at, generation)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(scopeType, scopeKey, owner, ownerToken, acquiredAt, acquiredAt, expiresAt, generation);
        }
        return { scopeType, scopeKey, owner, ownerToken, acquiredAt, renewedAt: acquiredAt, expiresAt, generation };
    });
}

export function renewLease(db, { scopeType, scopeKey, ownerToken, ttlMs, now = Date.now() }) {
    validateScope(scopeType, scopeKey);
    const renewedAt = iso(now);
    const expiresAt = expiry(renewedAt, ttlMs);
    return transaction(db, () => {
        const result = db.prepare(`UPDATE lease SET renewed_at = ?, expires_at = ?
            WHERE scope_type = ? AND scope_key = ? AND owner_token = ? AND expires_at > ?`).run(
            renewedAt, expiresAt, scopeType, scopeKey, ownerToken, renewedAt
        );
        if (result.changes !== 1) return null;
        const row = db.prepare("SELECT * FROM lease WHERE scope_type = ? AND scope_key = ?").get(scopeType, scopeKey);
        return rowToLease(row);
    });
}

export function releaseLease(db, { scopeType, scopeKey, ownerToken }) {
    validateScope(scopeType, scopeKey);
    return transaction(db, () => db.prepare(
        "DELETE FROM lease WHERE scope_type = ? AND scope_key = ? AND owner_token = ?"
    ).run(scopeType, scopeKey, ownerToken).changes === 1);
}

export function getLease(db, { scopeType, scopeKey }, { now = Date.now(), includeExpired = false } = {}) {
    validateScope(scopeType, scopeKey);
    const row = db.prepare("SELECT * FROM lease WHERE scope_type = ? AND scope_key = ?").get(scopeType, scopeKey);
    if (!row || (!includeExpired && row.expires_at <= iso(now))) return null;
    return rowToLease(row);
}

export function purgeExpiredLeases(db, { now = Date.now() } = {}) {
    return db.prepare("DELETE FROM lease WHERE expires_at <= ?").run(iso(now)).changes;
}

function rowToLease(row) {
    if (!row) return null;
    return {
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        owner: row.owner,
        ownerToken: row.owner_token,
        acquiredAt: row.acquired_at,
        renewedAt: row.renewed_at,
        expiresAt: row.expires_at,
        generation: Number(row.generation)
    };
}

export class LeaseStore {
    constructor(db) { this.db = db; }
    acquire(options) { return acquireLease(this.db, options); }
    renew(options) { return renewLease(this.db, options); }
    release(options) { return releaseLease(this.db, options); }
    get(scope, options) { return getLease(this.db, scope, options); }
    purgeExpired(options) { return purgeExpiredLeases(this.db, options); }
}
