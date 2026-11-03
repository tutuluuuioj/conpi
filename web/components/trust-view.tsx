"use client";

import { ShieldCheck } from "lucide-react";
import { CODE_HASH, CONTRACT_ID, DAO_ID, MEMBERS, MRTD, TEE_SIGNER, explorerAccount } from "@/lib/chain";
import { useApp } from "@/lib/store";
import { Badge, Card, HashChip, Overline } from "./ui";

const QUOTE = {
  notice: "Testnet placeholder schema only. This is not a hardware quote.",
  tee: "Phala Intel TDX (dstack)",
  mrtd: MRTD,
};

export function TrustView() {
  const app = useApp();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Trust</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">The enclave meters usage and signs releases. The NEAR contract checks those signatures and holds the money.</p>
      </div>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-warning" />
            <h2 className="text-lg font-semibold">Enclave</h2>
          </div>
          <Badge tone="warning">Testnet placeholder signer</Badge>
        </div>
        <p className="mt-3 text-sm text-muted">Phala Intel TDX (dstack). Heartbeat is a local stand-in until a real quote is registered.</p>
        <dl className="mt-4 grid gap-4 text-sm md:grid-cols-2">
          <div><dt className="text-muted">Status</dt><dd className="mt-1 inline-flex items-center gap-2 font-medium"><span className="h-2 w-2 rounded-full bg-warning" /> Placeholder</dd></div>
          <div>
            <dt className="text-muted">Signer public key</dt>
            <dd className="mt-2"><HashChip value={TEE_SIGNER} onCopy={app.copy} /></dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-muted">Measurement (MRTD)</dt>
            <dd className="mt-2 break-all font-mono text-[13px]">{MRTD}</dd>
            <button type="button" className="mt-2 text-sm font-semibold text-brand" onClick={() => app.copy(MRTD)}>Copy measurement</button>
          </div>
        </dl>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Overline>Attestation quote</Overline>
          <p className="mt-3 text-sm">{QUOTE.notice}</p>
          <a className="mt-3 inline-block text-sm font-semibold text-brand" href={`data:application/json,${encodeURIComponent(JSON.stringify(QUOTE, null, 2))}`} download="conpi-attestation-quote.json">Download raw quote</a>
          <p className="mt-2 text-xs text-muted">Verification result: not a hardware quote. Checked against the placeholder schema.</p>
        </Card>
        <Card id="verify">
          <Overline>Escrow contract</Overline>
          <div className="mt-3 space-y-3">
            <HashChip value={CONTRACT_ID} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} />
            <div>
              <div className="text-xs text-muted">Code hash</div>
              <div className="mt-1"><HashChip value={CODE_HASH} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} /></div>
            </div>
          </div>
          <ol className="mt-4 list-decimal space-y-1 pl-4 text-sm text-muted">
            <li>Build with <span className="font-mono text-ink">cargo near build non-reproducible-wasm --locked</span>.</li>
            <li>Compare the wasm hash with the code hash above.</li>
            <li>Confirm the signer key on this page matches the key stored on the contract.</li>
          </ol>
        </Card>
      </div>
      <Card>
        <Overline>Owner</Overline>
        <p className="mt-2 text-sm">DAO {DAO_ID}. Threshold 2 of 3. Timelock 48 hours.</p>
        <ul className="mt-3 divide-y divide-line text-sm">
          {MEMBERS.map((member) => (
            <li key={member.account} className="flex justify-between py-2"><span className="font-mono">{member.account}</span><span className="text-muted">{member.role}</span></li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
