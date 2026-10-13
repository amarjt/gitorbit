/**
 * GitOrbit Buffer Shim
 * Obsidian on iOS and Android runs in a WebView environment without Node.js runtime.
 * isomorphic-git and file system operations require Buffer.
 * This shim ensures globalThis.Buffer is available everywhere.
 */
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
