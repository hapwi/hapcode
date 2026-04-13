import { defineConfig } from "tsdown";

const shouldBundleDependency = (id: string) =>
  id.startsWith("@t3tools/") ||
  id === "effect" ||
  id.startsWith("effect/") ||
  id.startsWith("@effect/");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: shouldBundleDependency,
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
