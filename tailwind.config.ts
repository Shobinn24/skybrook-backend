import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        status: {
          healthy: "#16a34a",
          watch: "#eab308",
          atRisk: "#dc2626",
          overstock: "#64748b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
