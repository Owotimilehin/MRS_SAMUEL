/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#14181F",
          soft: "#6B7280",
        },
        line: "#EEF0F3",
        surface: {
          DEFAULT: "#FFFFFF",
          soft: "#F5F6F8",
          sunken: "#F9FAFB",
        },
        accent: {
          DEFAULT: "#F15A24",
          2: "#E63946",
          3: "#FCBF49",
        },
        success: "#10B981",
        warning: "#F59E0B",
        danger: "#DC2626",
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: {
        pill: "999px",
        card: "22px",
        shell: "28px",
        input: "12px",
      },
      backgroundImage: {
        sunrise: "linear-gradient(135deg, #E63946 0%, #F15A24 50%, #FCBF49 100%)",
      },
      boxShadow: {
        card: "0 18px 40px -22px rgba(20,24,31,0.18)",
        float: "0 24px 40px -18px rgba(20,24,31,0.35)",
        cta: "0 12px 28px -10px rgba(241,90,36,0.55)",
      },
    },
  },
  plugins: [],
};
