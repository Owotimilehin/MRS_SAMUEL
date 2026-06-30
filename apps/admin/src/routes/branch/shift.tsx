import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { InlineLoader } from "../../components/Spinner.js";

export function BranchShiftResolverPage({ branchId }: { branchId: string }): JSX.Element {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const isOpen = await hasOpenShift(branchId);
      if (cancelled) return;
      void navigate({ to: isOpen ? "/branch/close" : "/branch/shift-start", replace: true });
    })();
    return () => { cancelled = true; };
  }, [branchId, navigate]);
  return <InlineLoader label="Opening shift…" />;
}
