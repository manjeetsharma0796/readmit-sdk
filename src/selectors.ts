// 4-byte selector names from the Sourcify signature database. Optional: it tells Sourcify which selectors you looked up.
const cache = new Map<string, string | null>()

/** Resolves selectors (`0x12345678`) to function signatures. Unknown or failed lookups map to null. Cached per process. */
export async function lookupSelectors(selectors: string[], endpoint = 'https://api.4byte.sourcify.dev/signature-database/v1/lookup'): Promise<Map<string, string | null>> {
  const todo = [...new Set(selectors.map((s) => s.toLowerCase()))].filter((s) => /^0x[0-9a-f]{8}$/.test(s) && !cache.has(s))
  if (todo.length) {
    try {
      const r = await fetch(`${endpoint}?function=${todo.join(',')}&filter=true`).then((x) => x.json())
      for (const s of todo) cache.set(s, r?.result?.function?.[s]?.[0]?.name ?? null)
    } catch {
      // A nicety: callers still have the raw selector.
    }
  }
  return new Map(selectors.map((s) => [s, cache.get(s.toLowerCase()) ?? null]))
}
