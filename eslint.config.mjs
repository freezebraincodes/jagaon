import next from "eslint-config-next";

const eslintConfig = [
  ...next,
  {
    ignores: ["node_modules/", ".next/", "out/", "build/", "coverage/"],
  },
];

export default eslintConfig;
