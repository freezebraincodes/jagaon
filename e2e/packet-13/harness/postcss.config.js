// TEST-ONLY: the harness's PostCSS pipeline, equal to the production one (postcss.config.js) except that Tailwind reads the harness's
// tailwind.config.js, whose content globs are the production ones made absolute (the harness builds with its own directory as the
// working directory). isolation.spec.ts checks that the harness stylesheet equals the production stylesheet byte for byte.
const path = require("node:path");

module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, "tailwind.config.js") },
    autoprefixer: {},
  },
};
