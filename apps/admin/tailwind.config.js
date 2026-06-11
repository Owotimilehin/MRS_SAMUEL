/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Customer design system — green primary, orange secondary, cream surfaces
        brand: {
          DEFAULT: "#0e3f1f",
          orange: "#e85d1c",
        },
        cream: "#fff8ed",
        ink: {
          DEFAULT: "oklch(0.22 0.05 145)",
          soft: "oklch(0.45 0.03 145)",
        },
        line: "oklch(0.9 0.02 90)",
        surface: {
          DEFAULT: "#FFFFFF",
          soft: "oklch(0.95 0.03 90)",
          sunken: "#fff8ed",
        },
        accent: {
          DEFAULT: "oklch(0.32 0.10 150)", // brand green (primary)
          2: "#e85d1c", // brand orange (secondary)
          3: "#FCBF49", // warm gold
        },
        success: "#10B981",
        warning: "#F59E0B",
        danger: "#DC2626",
      },
      fontFamily: {
        sans: ["Plus Jakarta Sans", "Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["Fraunces", "Cormorant Garamond", "Georgia", "serif"],
      },
      borderRadius: {
        pill: "999px",
        card: "22px",
        shell: "28px",
        input: "12px",
      },
      backgroundImage: {
        sunrise: "linear-gradient(135deg, #14502b 0%, #1f7a44 100%)",
      },
      boxShadow: {
        card: "0 18px 40px -22px rgba(20,24,31,0.18)",
        float: "0 24px 40px -18px rgba(20,24,31,0.35)",
        cta: "0 12px 28px -10px rgba(20,80,43,0.45)",
      },
    },
  },
  plugins: [],
};
