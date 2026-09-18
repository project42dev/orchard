import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// The learner-facing catalogue combines the six inline records in catalog.json
// with separate files under content/modules. Inspecting the registry alone
// falsely calls every reference to a separate module broken.
export function effectivePathContext(item, platformRoot, canonicalSource) {
    if (!item?.stableId?.startsWith('learning-path:') || item.sourcePath !== 'content/catalog.json') return null;
    const catalog = JSON.parse(canonicalSource);
    const pathId = item.stableId.slice('learning-path:'.length);
    const path = catalog.paths?.find((entry) => entry.id === pathId);
    if (!path || !Array.isArray(path.moduleIds)) throw new Error(`catalogue path ${pathId} is missing from its canonical source`);

    const locations = new Map();
    for (const module of catalog.modules ?? []) {
        if (!module?.id || locations.has(module.id)) throw new Error(`duplicate or invalid inline catalogue module ${module?.id}`);
        locations.set(module.id, 'content/catalog.json');
    }
    const moduleRoot = resolve(platformRoot, 'content/modules');
    const visit = (dir) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && entry.name.endsWith('.json')) {
                const module = JSON.parse(readFileSync(file, 'utf8'));
                if (!module?.id || locations.has(module.id)) throw new Error(`duplicate or invalid standalone catalogue module ${module?.id}`);
                locations.set(module.id, relative(platformRoot, file).replaceAll('\\', '/'));
            }
        }
    };
    visit(moduleRoot);
    return {
        path_id: pathId,
        loader: 'content/catalog.json modules plus content/modules/**/*.json',
        effective_module_count: locations.size,
        module_references: path.moduleIds.map((id) => ({ id, source: locations.get(id) ?? null })),
        unresolved_module_ids: path.moduleIds.filter((id) => !locations.has(id)),
    };
}
