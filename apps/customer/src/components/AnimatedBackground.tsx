// Calm cream backdrop with subtle radial wash. Replaces the prior animated
// gradient + floating fruit, in line with the editorial product-site reference.
export function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 bg-[color:var(--cream)]">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, #fff4dd 0%, transparent 60%), radial-gradient(ellipse 60% 50% at 100% 100%, #f6efdd 0%, transparent 55%)",
        }}
      />
    </div>
  );
}
