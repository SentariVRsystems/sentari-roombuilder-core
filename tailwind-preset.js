/** @type {import('tailwindcss').Config} */
// The Sentari brand system as a Tailwind preset — shared by Sentari Command and
// Build & Breach Builder so the two products can't drift visually.
//
// Keep in sync with theme.ts (raw tokens for gradients / SVG fills / anything
// that can't take a className).
//
// Brand colors are namespaced under `brand-*` to avoid clobbering Tailwind's
// default palette (slate/teal/sky/amber all collide otherwise).
module.exports = {
  theme: {
    extend: {
      colors: {
        // Dark ops-console chrome (neutral slate-grays). Brand identity is
        // carried by the accent colors + Snow text on top of these.
        canvas: "#0C1219",
        surface: "#111A24",
        elevated: "#18232F",
        hairline: "rgba(247,249,251,0.09)",
        brand: {
          charcoal: "#3E3B3C", // darkest brand value (accents on dark)
          slate: "#45505D", // wordmark / brand-dark text
          steel: "#4F5A64", // supporting dark / card surfaces
          snow: "#F7F9FB", // primary light background
          deep: "#1F90DB", // deep end of the gradient
          midblue: "#2EA2EE", // mid gradient — legible accent on light
          teal: "#3DB4FF", // electric-blue signature (token name historical)
          sky: "#00D4FF", // cyan status accent
          amber: "#B5701A", // restricted alert
        },
      },
      fontFamily: {
        sans: ["Inter_400Regular"],
        "sans-medium": ["Inter_500Medium"],
        "sans-semibold": ["Inter_600SemiBold"],
        "sans-bold": ["Inter_700Bold"],
        display: ["Inter_700Bold"], // Nofex stand-in for the wordmark
        mono: ["JetBrainsMono_400Regular"],
        "mono-medium": ["JetBrainsMono_500Medium"],
        "mono-bold": ["JetBrainsMono_700Bold"],
      },
    },
  },
};
