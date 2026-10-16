// Cursor pagination for the Leads list and a lead's history ("Load more"). Pure state transitions, no fetching, no prefetching.
//
// The server orders leads by (created_at, id) DESCENDING and history newest first, and continues with an OPAQUE cursor that the
// browser passes back unchanged (it is never decoded or built here). These helpers keep the server's order exactly: pages are
// appended in the order they arrive and nothing is re-sorted. A lead that appears twice (a row that moved while pages were being
// read) is kept once, at its first position, with the newer data. A page that was fetched for an older filter set is ignored.

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };

export type ListState<T> = {
  /** Identity of the question these rows answer (filtersKey for leads, the lead id for history). */
  readonly key: string;
  readonly items: readonly T[];
  /** Where "Load more" continues from; null when the end was reached. */
  readonly nextCursor: string | null;
  /** True once a first page has arrived for this key. */
  readonly loaded: boolean;
};

export const emptyList = <T>(key: string): ListState<T> => ({
  key,
  items: [],
  nextCursor: null,
  loaded: false,
});

/** A filter change (a new key) starts from nothing: the old rows and the old cursor belong to another question. */
export const resetFor = <T>(state: ListState<T>, key: string): ListState<T> =>
  state.key === key ? state : emptyList<T>(key);

/** The first page for `key` replaces everything (a refresh, or the first load after a filter change). */
export function firstPage<T extends { readonly id: string }>(
  key: string,
  page: Page<T>,
): ListState<T> {
  return { key, items: dedupe([], page.items), nextCursor: endOf(page), loaded: true };
}

/**
 * Appends the next page, but only if it answers the SAME question (`key`) and was fetched from the CURRENT cursor (`from`): a
 * late answer to an older request is dropped instead of being mixed in.
 */
export function appendPage<T extends { readonly id: string }>(
  state: ListState<T>,
  key: string,
  from: string | null,
  page: Page<T>,
): ListState<T> {
  if (key !== state.key || !state.loaded || from !== state.nextCursor || from === null)
    return state;
  return { key, items: dedupe(state.items, page.items), nextCursor: endOf(page), loaded: true };
}

export const canLoadMore = (state: ListState<unknown>) => state.loaded && state.nextCursor !== null;
export const isEmptyResult = (state: ListState<unknown>) =>
  state.loaded && state.items.length === 0;

/** An empty page cannot be followed further, whatever cursor it carries: that would only repeat the same empty request. */
const endOf = (page: Page<unknown>) => (page.items.length === 0 ? null : page.nextCursor);

function dedupe<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const position = new Map<string, number>();
  const out: T[] = [];
  for (const item of [...existing, ...incoming]) {
    const at = position.get(item.id);
    if (at === undefined) {
      position.set(item.id, out.length);
      out.push(item);
    } else out[at] = item; // seen before: keep its place, take the newer data
  }
  return out;
}
