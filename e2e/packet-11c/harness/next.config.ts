import path from "node:path";
import type { NextConfig } from "next";

/**
 * TEST-ONLY Next config of the Packet 11C C7 harness (see the README block in harness-app.tsx). The harness imports the real app from
 * the repository's `src/`, so Turbopack and output tracing are rooted at the repository. Build and start it only in a clean copy.
 */
const repositoryRoot = path.resolve(__dirname, "../../..");

const harnessConfig: NextConfig = {
  turbopack: { root: repositoryRoot },
  outputFileTracingRoot: repositoryRoot,
};

export default harnessConfig;
