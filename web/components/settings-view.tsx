"use client";

import { useApp } from "@/lib/store";
import type { Asset, ThemeMode } from "@/lib/types";
import { Button, Card, Overline, fieldClass } from "./ui";

const EVENTS = ["Offer received", "Terms matched", "Deposit", "Key verified", "Stage released", "Default", "Claim available", "Proposal staged"];

export function SettingsView() {
  const app = useApp();
  const live = app.deals.filter((deal) => deal.status === "Active" && (deal.buyer === app.account || deal.seller === app.account));
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Settings</h1>
        <p className="mt-2 text-sm text-muted">Display, alerts, and the proxy keys on your live deals.</p>
      </div>
      <Card>
        <Overline>Theme</Overline>
        <div className="mt-3 flex gap-2">
          {(["dark", "light", "system"] as ThemeMode[]).map((mode) => (
            <button key={mode} type="button" className={`rounded-md border px-3 py-2 text-sm font-semibold capitalize ${app.theme === mode ? "border-brand bg-brand/10 text-brand" : "border-line"}`} onClick={() => app.setTheme(mode)}>{mode}</button>
          ))}
        </div>
      </Card>
      <Card className="space-y-4">
        <FieldLike label="Default token">
          <select className={fieldClass} value={app.defaultToken} onChange={(event) => app.setDefaultToken(event.target.value as Asset)}>
            <option>USDC</option>
            <option>USDT</option>
            <option>NEAR</option>
          </select>
        </FieldLike>
        <FieldLike label="Display currency">
          <input className={fieldClass} value={app.currency} readOnly />
        </FieldLike>
        <FieldLike label="Timezone">
          <input className={fieldClass} value={Intl.DateTimeFormat().resolvedOptions().timeZone} readOnly />
        </FieldLike>
      </Card>
      <Card>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <ul className="mt-3 divide-y divide-line text-sm">
          {EVENTS.map((event) => (
            <li key={event} className="flex items-center justify-between gap-3 py-2">
              <span>{event}</span>
              <span className="text-xs text-muted">In app</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">Email and browser push stay off until a delivery service is connected.</p>
      </Card>
      <Card>
        <h2 className="text-lg font-semibold">Proxy keys</h2>
        {live.length === 0 ? <p className="mt-2 text-sm text-muted">No live deals.</p> : (
          <ul className="mt-3 space-y-3">
            {live.map((deal) => (
              <li key={deal.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3">
                <div>
                  <div className="font-semibold">Deal {deal.id}</div>
                  <div className="font-mono text-xs text-muted">{deal.proxyRevoked ? "Revoked" : deal.proxyKey}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => app.ask({ title: "Rotate proxy key", body: `Deal ${deal.id}. The old key stops working after the enclave issues the new one.`, confirm: "Rotate", run: () => app.rotateKey(deal.id) })}>Rotate</Button>
                  <Button size="sm" variant="danger" onClick={() => app.ask({ title: "Revoke proxy key", body: `Deal ${deal.id}. Calls with this key will be refused. This does not settle the escrow.`, confirm: "Revoke", danger: true, run: () => app.revokeKey(deal.id) })}>Revoke</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="text-lg font-semibold">Wallet</h2>
        <p className="mt-2 text-sm">{app.wallet ?? "Not connected"} · <span className="font-mono">{app.account ?? "—"}</span></p>
      </Card>
      <Card>
        <h2 className="text-lg font-semibold text-danger">Danger zone</h2>
        <p className="mt-2 text-sm text-muted">Cancels every sell listing signed by this wallet. Open deals are left alone.</p>
        <Button className="mt-3" variant="danger" onClick={() => app.ask({
          title: "Cancel open listings",
          body: "This removes your sell listings from the market.",
          confirm: "Cancel listings",
          danger: true,
          run: () => app.cancelMyListings(),
        })}>Cancel open listings</Button>
      </Card>
    </div>
  );
}

function FieldLike({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[13px] font-medium">{label}<div className="mt-1.5">{children}</div></label>;
}
