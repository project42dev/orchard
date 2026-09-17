import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalogueDraft, parseCatalogueDraft, selectedCatalogueContent } from "../scripts/lib/catalogue-deliverable.mjs";
import { prepareRealCommit } from "../scripts/lib/prepare-gate2-evidence.mjs";
import { briefFor } from "../scripts/generate-briefs.mjs";
import { sha256Digest } from "../scripts/lib/identity.mjs";

const registry = { schemaVersion: 1, title: "Original", paths: [{ id: "a", title: "A" }, { id: "b", title: "B" }], modules: [], resources: [] };
const text = `${JSON.stringify(registry, null, 2)}\n`;

test("a selected path draft changes only that path", () => {
    const changed = JSON.parse(applyCatalogueDraft({ path: "catalog.json", canonicalId: "learning-path:a", content: JSON.stringify({ id: "a", title: "Updated" }), registryText: text }));
    assert.equal(changed.paths[0].title, "Updated");
    assert.deepEqual(changed.paths[1], registry.paths[1]);
    assert.deepEqual(changed.modules, registry.modules);
    assert.deepEqual(selectedCatalogueContent({ path: "catalog.json", canonicalId: "learning-path:b", registry }), registry.paths[1]);
});

test("a singleton draft preserves all arrays", () => {
    const changed = JSON.parse(applyCatalogueDraft({ path: "catalog.json", canonicalId: "catalogue:content", content: JSON.stringify({ schemaVersion: 1, title: "Updated" }), registryText: text }));
    assert.equal(changed.title, "Updated");
    assert.deepEqual(changed.paths, registry.paths);
});

test("missing, renamed, unrelated, and unchanged entries hold", () => {
    const run = (canonicalId, content) => applyCatalogueDraft({ path: "catalog.json", canonicalId, content, registryText: text });
    assert.throws(() => run("learning-path:a", JSON.stringify({ id: "c", title: "Bad" })), /retain id/);
    assert.throws(() => run("learning-path:a", JSON.stringify({ id: "a" })), /omitted existing field/);
    assert.throws(() => run("learning-path:a", JSON.stringify(registry.paths[0])), /no change/);
    assert.throws(() => run("learning-path:c", JSON.stringify({ id: "c", title: "C" })), /exactly one/);
    assert.throws(() => run("guide:a", JSON.stringify({ id: "a", title: "A" })), /exactly one/);
    assert.throws(() => parseCatalogueDraft({ path: "catalog.json", canonicalId: "learning-path:a", content: "{broken" }), /not valid JSON/);
    assert.throws(() => applyCatalogueDraft({ path: "catalog.json", canonicalId: "learning-path:a", content: JSON.stringify({ id: "a", title: "Updated" }),
        registryText: text, expectedEntryDigest: sha256Digest({ id: "a", title: "Old baseline" }) }), /changed since the inspected corpus/);
});

test("registry-only preparation writes one protected-tree blob with only the selected change", async () => {
    const blobs = [];
    const trees = [];
    const fetchImpl = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        const response = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
        if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: "1".repeat(40) } });
        if (url.endsWith(`/git/commits/${"1".repeat(40)}`)) return response({ tree: { sha: "2".repeat(40) } });
        if (url.includes("/contents/catalog.json?ref=")) return response({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
        if (url.endsWith("/git/blobs")) { blobs.push(body.content); return response({ sha: "3".repeat(40) }); }
        if (url.endsWith("/git/trees")) { trees.push(body.tree); return response({ sha: "4".repeat(40) }); }
        if (url.endsWith("/git/commits") && options.method === "POST") return response({ sha: "5".repeat(40) });
        throw new Error(`unexpected Git API call ${url}`);
    };
    const draft = JSON.stringify({ id: "a", title: "Updated" });
    const result = await prepareRealCommit({
        repository: "project42dev/project42-content", path: "catalog.json", content: draft,
        materializeContent: (registryText) => applyCatalogueDraft({ path: "catalog.json", canonicalId: "learning-path:a", content: draft, registryText,
            expectedEntryDigest: sha256Digest(registry.paths[0]) }),
        token: "test-token", fetchImpl,
    });
    assert.equal(blobs.length, 1);
    assert.deepEqual(trees[0].map((entry) => entry.path), ["catalog.json"]);
    assert.deepEqual(JSON.parse(blobs[0]).paths[1], registry.paths[1]);
    assert.equal(JSON.parse(blobs[0]).paths[0].title, "Updated");
    assert.equal(result.registeredIn, "catalog.json");
});

test("a catalogue brief asks for one selected entry rather than the entire registry", () => {
    const existing = { required: true, status: "supplied", catalogueEntry: true, canonicalId: "learning-path:a",
        sourcePath: "content/catalog.json", inspectionCommit: "1".repeat(40), content: JSON.stringify(registry.paths[0]), parsed: registry.paths[0] };
    const item = { subject_id: "01930000-0000-7000-8000-000000000001", id: "01930000-0000-7000-8000-000000000001",
        kind: "needs-updating", surface: "learning", title: "Update path A", level: "intermediate",
        recordedTarget: { repository: "project42dev/project42-content", path: "catalog.json" },
        record: { canonical_content_id: "learning-path:a" } };
    const built = briefFor({ item, roles: {}, targets: { surfaces: {} }, evidence: null,
        citations: [], findings: ["Correct the outdated summary"], existing, today: "2026-09-17" });
    assert.ok(built.brief, built.error);
    assert.match(built.brief.prompt, /Return one complete corrected JSON object for this entry only/);
    assert.doesNotMatch(built.brief.prompt, /Return the COMPLETE corrected file/);
    assert.match(built.brief.prompt, /learning-path:a/);
});
