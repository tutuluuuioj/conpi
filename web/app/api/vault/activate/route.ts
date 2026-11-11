export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

// Local activation used to persist plaintext provider keys and mint proxy keys
// outside the enclave. That path is intentionally retired: activation must go
// through /v1/deals/:id/key on the attested TEE.
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "Local activation is disabled. Submit the encrypted provider key to the attested TEE.",
      code: "tee_activation_required",
    },
    { status: 410 }
  );
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "Local activation registry is disabled", code: "tee_activation_required" },
    { status: 410 }
  );
}
