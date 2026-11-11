import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const data = await req.json();
    console.log(">>> [BROWSER LOG]", JSON.stringify(data));
  } catch {}
  return NextResponse.json({ ok: true });
}
