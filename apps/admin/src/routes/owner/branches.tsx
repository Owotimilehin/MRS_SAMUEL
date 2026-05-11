import { useQuery } from "@tanstack/react-query";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";

interface Branch {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  deliveryZones: { name: string; fee_ngn: number }[];
  isActive: boolean;
}

export function BranchesPage() {
  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<{ data: Branch[] }>("/branches").then((r) => r.data),
  });

  return (
    <Shell title="Branches">
      <p style={{ color: "var(--ms-ink-3)" }} className="mb-6">
        {branches.data?.length ?? 0} active branch{(branches.data?.length ?? 0) === 1 ? "" : "es"}
      </p>

      <div className="grid grid-cols-2 gap-4">
        {branches.data?.map((b) => (
          <div
            key={b.id}
            className="p-5"
            style={{
              background: "var(--ms-surface)",
              border: "1px solid var(--ms-border)",
              borderRadius: 14,
            }}
          >
            <div className="font-display text-lg font-bold mb-1">{b.name}</div>
            <div className="text-xs font-mono mb-3" style={{ color: "var(--ms-ink-3)" }}>
              {b.code}
            </div>
            {b.address && (
              <div className="text-sm mb-1" style={{ color: "var(--ms-ink-2)" }}>
                📍 {b.address}
              </div>
            )}
            {b.phone && (
              <div className="text-sm mb-3" style={{ color: "var(--ms-ink-2)" }}>
                📞 {b.phone}
              </div>
            )}
            {b.deliveryZones.length > 0 && (
              <div>
                <div
                  className="text-xs uppercase tracking-wide font-semibold mb-2"
                  style={{ color: "var(--ms-ink-3)" }}
                >
                  Delivery zones
                </div>
                <div className="flex flex-wrap gap-2">
                  {b.deliveryZones.map((z, i) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-1 rounded-full"
                      style={{
                        background: "var(--ms-green-100)",
                        color: "var(--ms-green-900)",
                      }}
                    >
                      {z.name} · ₦{z.fee_ngn.toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Shell>
  );
}
