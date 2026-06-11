import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface Props {
  eyebrow: string;
  title: ReactNode;
  subtitle?: string;
  decor?: string;
  accent?: string;
}

export function PageHero({ eyebrow, title, subtitle, decor, accent }: Props) {
  return (
    <section className="relative pt-32 sm:pt-40 pb-12 sm:pb-16 px-5 sm:px-10 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-10 items-center">
        <div className="relative z-10">
          <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">
            <span className="h-px w-6 bg-[color:var(--brand)]/40" /> {eyebrow}
          </div>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mt-4 font-display text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[1.02] tracking-[-0.03em] text-[color:var(--brand)]"
          >
            {title}
          </motion.h1>
          {subtitle && (
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-[color:var(--brand)]/70">
              {subtitle}
            </p>
          )}
        </div>
        {decor && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8 }}
            className="relative h-[260px] sm:h-[340px]"
          >
            <div
              className="absolute inset-0 rounded-full blur-3xl opacity-60"
              style={{
                background: `radial-gradient(circle at 50% 50%, ${accent ?? "#ffb142"} 0%, transparent 65%)`,
              }}
            />
            <img src={decor} alt="" aria-hidden className="absolute inset-0 m-auto h-full w-auto object-contain drop-shadow-[0_20px_24px_rgba(40,20,10,0.18)]" />
          </motion.div>
        )}
      </div>
    </section>
  );
}
