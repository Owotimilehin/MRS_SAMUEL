import { Shell } from "../../components/Shell.js";

export function DashboardPage() {
  return (
    <Shell title="Dashboard">
      <p style={{ color: "var(--ms-ink-3)" }}>
        The owner dashboard surfaces are designed in <code>docs/ui-mockups/01-brand-defining/02-owner-dashboard.html</code>.
        Sprint 5 builds it on top of the Phase 5 reporting endpoints. For now,
        use the navigation to drive operations.
      </p>
    </Shell>
  );
}
