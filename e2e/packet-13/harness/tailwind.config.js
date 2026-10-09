// TEST-ONLY: the production tailwind.config.ts with its content globs made absolute (see postcss.config.js in this directory).
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");

module.exports = {
  content: [path.join(repositoryRoot, "src/app/**/*.{js,ts,jsx,tsx,mdx}"), path.join(repositoryRoot, "src/components/**/*.{js,ts,jsx,tsx,mdx}")],
  theme: {
    extend: {},
  },
  plugins: [],
};
