import esbuild from "esbuild";
import { rm } from "node:fs/promises";

// One bundled extension.js instead of 64 tsc output files. `vscode` is the only
// external module; everything else (including the C/C++ clangd modules) is
// inlined. Production mode drops the source map and minifies; the VSIX then
// contains a single JS file plus resources/l10n.
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

await rm("out", { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "out/extension.js",
  external: ["vscode"],
  sourcemap: production ? false : "linked",
  minify: production,
  legalComments: "none",
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("esbuild: watching src/extension.ts -> out/extension.js");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
