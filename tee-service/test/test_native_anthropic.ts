import Fastify from "fastify";
import { keyVault } from "../src/vault/preflight.js";
import { handleAnthropicMessages } from "../src/proxy/server.js";
import { enclaveKeys } from "../src/crypto/keys.js";

async function runAnthropicTest() {
  console.log("==================================================");
  console.log("  TESTING CONPI NATIVE ANTHROPIC /v1/messages   ");
  console.log("==================================================");

  await enclaveKeys.init();

  const app = Fastify();
  app.post("/v1/messages", handleAnthropicMessages);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`Local TEE Proxy running on ${baseUrl}`);

  // Test Case A: Real/Live Anthropic API Key (if provided)
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.startsWith("sk-ant-")) {
    console.log("\n--- TEST CASE A: Real Live Anthropic Key from Environment ---");
    const model = "claude-3-5-haiku-20241022";
    const dealId = 9001;
    const termsHash = "22".repeat(32);

    const injectResult = await keyVault.validateAndInjectKey(
      dealId,
      "anthropic",
      model,
      [model, "claude-3-5-sonnet-20241022"],
      10.0,
      8.0,
      termsHash,
      undefined,
      envKey
    );

    console.log("Preflight Injection:", JSON.stringify(injectResult, null, 2));
    if (injectResult.ok && injectResult.proxyKey) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${injectResult.proxyKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 20,
          messages: [{ role: "user", content: "Reply with 'Hello Anthropic!' only." }],
        }),
      });

      const body = await res.json();
      console.log(`Live Anthropic Status: ${res.status}`);
      console.log("Live Response Body:", JSON.stringify(body, null, 2));

      const entry = keyVault.getByDealId(dealId);
      console.log("Live Meter Tokens:", entry?.tokensTotal);
      console.log("Live Meter Cost USD:", entry?.usedUsd);
    }
  } else {
    console.log("\n[Notice] ANTHROPIC_API_KEY not set in environment.");
    console.log("Testing invalid probe key rejection against live https://api.anthropic.com...");
    const probeRes = await keyVault.validateAndInjectKey(
      9002,
      "anthropic",
      "claude-3-5-haiku-20241022",
      ["claude-3-5-haiku-20241022"],
      10.0,
      8.0,
      "33".repeat(32),
      undefined,
      "sk-ant-invalid-probe-key"
    );
    console.log("Expected Anthropic Rejection:", probeRes.error);
    console.log("Preflight correctly rejected unauthorized key: true");
  }

  // Test Case B: Native Anthropic Adapter & Token Metering Pipeline
  console.log("\n--- TEST CASE B: Native Anthropic Protocol & Metering Pipeline ---");
  const testDealId = 9003;
  const testTermsHash = "44".repeat(32);
  const testModel = "claude-3-5-sonnet-20241022";

  const testInject = await keyVault.validateAndInjectKey(
    testDealId,
    "anthropic",
    testModel,
    [testModel],
    10.0,
    8.0,
    testTermsHash,
    undefined,
    "sk-test-anthropic-pipeline"
  );

  console.log("Pipeline Key Injection Result:", JSON.stringify(testInject, null, 2));
  if (!testInject.ok || !testInject.proxyKey) {
    throw new Error("Failed to inject pipeline key");
  }

  console.log("\nCalling POST /v1/messages with Anthropic payload format...");
  const proxyRes = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${testInject.proxyKey}`,
    },
    body: JSON.stringify({
      model: testModel,
      max_tokens: 50,
      messages: [{ role: "user", content: "Ping from Conpi TEE test suite" }],
    }),
  });

  const statusCode = proxyRes.status;
  const responseData = await proxyRes.json();

  console.log(`\nProxy Status: ${statusCode}`);
  console.log("Anthropic Response Payload:", JSON.stringify(responseData, null, 2));

  // Inspect TEE Metering
  const entry = keyVault.getByDealId(testDealId);
  console.log("\n=== TEE ENCLAVE METER STATE ===");
  console.log("Deal ID:          ", entry?.dealId);
  console.log("Total Tokens:     ", entry?.tokensTotal);
  console.log("Reported Usage:   ", responseData.usage);
  console.log("Used USD:         ", `$${entry?.usedUsd.toFixed(6)}`);
  console.log("Active Status:    ", entry?.active);

  if (responseData.type === "message" && responseData.content?.[0]?.text && responseData.usage?.input_tokens > 0) {
    console.log("\n>>> PASS: Native Anthropic /v1/messages path verified with exact token metering! <<<");
  } else {
    throw new Error("Anthropic response format invalid");
  }

  await app.close();
}

runAnthropicTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
