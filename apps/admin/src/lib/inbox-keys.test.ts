import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { inboxKeys, type ConversationFilters } from "./inbox-api.js";

/**
 * Regression, 23 Nov 2026: the suite's Overview cached one plain page of
 * conversations under the inbox's paged-list key. Opening the Inbox afterwards
 * read that plain page as a paged list and crashed the screen with
 * "Cannot read properties of undefined (reading 'length')".
 */
describe("inbox conversation cache keys", () => {
  const filters: ConversationFilters = { status: "open", view: "all", chatsOnly: true };

  it("keeps a plain first page apart from the paged list, under the same refresh prefix", () => {
    expect(inboxKeys.listFirstPage(filters)).not.toEqual(inboxKeys.list(filters));
    expect(inboxKeys.listFirstPage(filters).slice(0, 2)).toEqual([...inboxKeys.lists]);
  });

  it("opening the inbox after Overview no longer crashes", () => {
    const qc = new QueryClient();
    // What Overview stores: one plain page.
    qc.setQueryData(inboxKeys.listFirstPage(filters), { data: [], next_cursor: "c1" });
    // What the inbox list does on open.
    const open = () =>
      new InfiniteQueryObserver(qc, {
        queryKey: inboxKeys.list(filters),
        queryFn: async () => ({ data: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: (last: { next_cursor: string | null }) => last.next_cursor,
        enabled: false,
      }).getCurrentResult();
    expect(open).not.toThrow();

    // The old shared key really did crash: proves this test would catch it.
    const broken = new QueryClient();
    broken.setQueryData(inboxKeys.list(filters), { data: [], next_cursor: "c1" });
    expect(() =>
      new InfiniteQueryObserver(broken, {
        queryKey: inboxKeys.list(filters),
        queryFn: async () => ({ data: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: (last: { next_cursor: string | null }) => last.next_cursor,
        enabled: false,
      }).getCurrentResult(),
    ).toThrow(/length/);
  });
});
