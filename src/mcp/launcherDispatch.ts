// Keep the user's selected order while allowing independent views to prepare concurrently.
export async function runUniqueInParallel<T extends string, R>(
    values: readonly T[],
    run: (value: T) => Promise<R>,
): Promise<R[]> {
    return Promise.all([...new Set(values)].map(run));
}
