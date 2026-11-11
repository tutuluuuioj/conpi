import { Buffer } from "buffer";

if (typeof window !== "undefined") {
  (window as any).Buffer = (window as any).Buffer || Buffer;
  (window as any).global = (window as any).global || window;
  (window as any).process = (window as any).process || { env: { NODE_ENV: "production" } };
}

if (typeof globalThis !== "undefined") {
  (globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;
  (globalThis as any).global = (globalThis as any).global || globalThis;
}

export { Buffer };
