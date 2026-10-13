import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

// Desktop Electron provides Node builtins; mobile WebViews do not.
// Polyfilled 'buffer' is bundled and injected globally via src/buffer-shim.ts.
const externalBuiltins = builtinModules.filter(
  (mod) => mod !== "buffer" && mod !== "node:buffer"
);

const buildOptions = {
  banner: { js: "/* GitOrbit Obsidian Plugin - Pure-JS Git Sync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...externalBuiltins,
  ],
  inject: ["src/buffer-shim.ts"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("GitOrbit: Watching for changes...");
}
