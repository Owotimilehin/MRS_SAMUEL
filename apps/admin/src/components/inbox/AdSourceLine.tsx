/**
 * One line on the contact panel when the chat started from an advert (suite
 * spec 12, 7.8). Shows nothing while loading, when there is no advert, and on
 * any error: see lib/ad-source.ts.
 */
import { useQuery } from "@tanstack/react-query";
import { adSourceText, fetchAdSource } from "../../lib/ad-source.js";

export function AdSourceLine({ conversationId }: { conversationId: string }): JSX.Element | null {
  const q = useQuery({
    queryKey: ["ads", "source", conversationId],
    queryFn: () => fetchAdSource(conversationId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  if (!q.data) return null;
  return (
    <div style={{ fontSize: 13, color: "var(--ink-soft)" }} title={q.data.ad_name ?? undefined}>
      {adSourceText(q.data)}
    </div>
  );
}
