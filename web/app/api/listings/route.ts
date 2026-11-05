import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const STORAGE_FILE = path.join(process.cwd(), ".listings-store.json");

function getStoredListings(): any[] {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Failed to read listings store:", err);
  }
  return [];
}

function saveStoredListings(listings: any[]) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(listings, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write listings store:", err);
  }
}

export async function GET() {
  const listings = getStoredListings();
  return NextResponse.json({ ok: true, listings });
}

export async function POST(req: Request) {
  try {
    const listing = await req.json();
    if (!listing || !listing.id) {
      return NextResponse.json({ ok: false, error: "Invalid listing" }, { status: 400 });
    }
    const current = getStoredListings();
    const updated = [listing, ...current.filter((item: any) => item.id !== listing.id)];
    saveStoredListings(updated);
    return NextResponse.json({ ok: true, listing });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
