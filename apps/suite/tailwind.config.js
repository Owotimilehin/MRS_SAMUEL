import admin from "../admin/tailwind.config.js";

/**
 * The suite uses the admin app's design tokens (colours, type, radii) so the
 * two look like one family. Styles are generated for the suite's own files and
 * for the admin screens it reuses.
 * @type {import('tailwindcss').Config}
 */
export default {
  ...admin,
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../admin/src/**/*.{ts,tsx}"],
};
