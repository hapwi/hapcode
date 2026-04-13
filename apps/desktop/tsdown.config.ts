import { defineConfig } from "tsdown";

const shouldBundleDependency = (id: string) =>
  id.startsWith("@t3tools/") ||
  id === "effect" ||
  id.startsWith("effect/") ||
  id.startsWith("@effect/");

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: shouldBundleDependency,
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    ...shared,
    entry: ["src/browser-preload.ts"],
  },
]);
