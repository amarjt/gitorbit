/**
 * GitOrbit Buffer Shim
 * Obsidian on iOS and Android runs in a WebView environment without Node.js runtime.
 * isomorphic-git and file system operations require Buffer.
 * This shim ensures globalThis.Buffer is available everywhere.
 */
import { Buffer } from "buffer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = typeof globalThis !== "undefined" ? (globalThis as any) : (window as any);


if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
if (typeof window !== "undefined" && typeof (window as any).Buffer === "undefined") {
  (window as any).Buffer = Buffer;
}

if (typeof g.process === "undefined") {
  g.process = { env: {}, browser: true, platform: "browser" };
}

export { Buffer };

