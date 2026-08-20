const REQUIRED_METHODS = Object.freeze(["acquire", "renew", "release", "assertCurrent", "readState", "publishState", "replicateBackup"]);

export function assertCoordinationAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") throw new TypeError("coordination adapter is required");
    for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") throw new TypeError(`coordination adapter needs ${method}()`);
    return adapter;
}

export async function withFencedState(adapter, options, operation) {
    assertCoordinationAdapter(adapter);
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const handle = await adapter.acquire(options.scope, options.owner);
    if (!handle) throw new Error(`state lease is unavailable: ${options.scope}`);
    let renewalFailure = null;
    let consecutiveFailures = 0;
    const renewEveryMs = options.renewEveryMs ?? 20_000;
    const timer = setInterval(async () => {
        try {
            await adapter.renew(handle);
            consecutiveFailures = 0;
            renewalFailure = null;
        } catch (error) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) {
                renewalFailure = error;
            }
        }
    }, renewEveryMs);
    timer.unref?.();
    try {
        const state = await adapter.readState(handle);
        const result = await operation({
            handle, state, assertCurrent: async () => {
                if (renewalFailure) throw new Error(`state lease renewal failed: ${renewalFailure.message}`);
                await adapter.assertCurrent(handle);
            }
        });
        if (renewalFailure) throw new Error(`state lease renewal failed: ${renewalFailure.message}`);
        await adapter.assertCurrent(handle);
        const published = await adapter.publishState(handle, result.statePath, state);
        await adapter.assertCurrent(handle);
        await adapter.replicateBackup(handle, published);
        return { result: result.value, published };
    } finally {
        clearInterval(timer);
        await adapter.release(handle).catch(() => { });
    }
}

