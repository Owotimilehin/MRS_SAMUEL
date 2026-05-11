import { useQuery } from "@tanstack/react-query";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";

interface Transfer {
  id: string;
  transferNumber: string;
  branchId: string;
  factoryId: string;
  receivedAt: string | null;
}
interface ReviewResponse { data: { transfer_variances: Transfer[] } }

export function ReviewPage() {
  const review = useQuery({
    queryKey: ["review"],
    queryFn: () => api<ReviewResponse>("/review").then((r) => r.data),
  });
  const items = review.data?.transfer_variances ?? [];

  return (
    <Shell title="Needs review">
      <p className="mb-6" style={{ color: "var(--ms-ink-3)" }}>
        {items.length} variance transfer{items.length === 1 ? "" : "s"} pending your decision.
      </p>

      {items.length === 0 ? (
        <div
          className="p-8 text-center"
          style={{
            background: "var(--ms-surface)",
            border: "1px solid var(--ms-border)",
            borderRadius: 14,
            color: "var(--ms-ink-3)",
          }}
        >
          ✓ Nothing to review right now. New variance receipts will appear here.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((t) => (
            <a
              key={t.id}
              href={`/transfers?open=${t.id}`}
              className="p-4 flex items-center gap-4 transition"
              style={{
                background: "var(--ms-surface)",
                border: "1px solid var(--ms-border)",
                borderRadius: 14,
                textDecoration: "none",
                color: "var(--ms-ink)",
              }}
            >
              <div
                className="grid place-items-center rounded-md"
                style={{
                  width: 40,
                  height: 40,
                  background: "rgba(255,196,52,0.18)",
                  color: "var(--ms-warn)",
                }}
              >
                ⚠
              </div>
              <div className="flex-1">
                <div className="font-semibold">{t.transferNumber}</div>
                <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
                  Variance recorded · received {formatDateTime(t.receivedAt)}
                </div>
              </div>
              <span style={{ color: "var(--ms-green-700)" }}>Open →</span>
            </a>
          ))}
        </div>
      )}
    </Shell>
  );
}
