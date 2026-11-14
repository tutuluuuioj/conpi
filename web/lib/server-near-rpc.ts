import { CONTRACT_ID } from "./chain";
import { serverNearRpcEndpoints } from "./rpc-endpoints";

function parseNearResult<T>(value: string): T {
  const lossless = value.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(lossless) as T;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Server-side NEAR view with provider failover. Browser code calls a local
 * route backed by this helper, so public dRPC credentials stay private and a
 * single provider's 429 cannot block deal acceptance.
 */
export async function callServerNearView<T>(
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const endpoints = serverNearRpcEndpoints();
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
  const failures: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const rpcUrl of endpoints) {
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `conpi_${methodName}_${Date.now()}_${attempt}`,
            method: "query",
            params: {
              request_type: "call_function",
              finality: "final",
              account_id: CONTRACT_ID,
              method_name: methodName,
              args_base64: argsBase64,
            },
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
        if (!Array.isArray(json?.result?.result)) throw new Error("Missing result bytes");
        const decoded = new TextDecoder().decode(new Uint8Array(json.result.result));
        return parseNearResult<T>(decoded);
      } catch (error) {
        failures.push(`${rpcUrl}: ${errorText(error)}`);
      }
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`All NEAR RPC providers failed for ${methodName}: ${failures.join(" | ")}`);
}
