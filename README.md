# Conpi — Trust-Minimised Marketplace for Unused Prepaid LLM API Credits

> **Platform:** NEAR Protocol Escrow Contract + Intel TDX Confidential VM (TEE)  
> **Environment:** NEAR Testnet + Phala Network Intel TDX CVM  
> **Deployed Testnet Contract:** [`dev-20261103021728-21839689153509.testnet`](https://testnet.nearblocks.io/address/dev-20261103021728-21839689153509.testnet)  
> **DAO Multisig Owner:** [`dev-20261103021740-59711933581376.testnet`](https://testnet.nearblocks.io/address/dev-20261103021740-59711933581376.testnet) (Real Multisig Contract, 3 Members, 2-of-3 Quorum)  
> **Escrow Access Keys:** `0` (Autonomous Escrow Vault, all keys deleted)  
> **Multisig Access Keys:** 3 Function-Call Access Keys limited to `["add_request", "add_request_and_confirm", "confirm", "delete_request"]` (Deployer Full-Access Key Deleted)  
> **Timelock Delay:** 48 Hours minimum (`172_800_000_000_000` ns enforced in contract constructor)  
> **Reproducible Code Hash:** `E5YED19GaPXvpc8kiVn5kCXB21eWMA5SpCBDn7iV7nG` (Matches on-chain code_hash byte-for-byte)  
> **WASM Binary:** [`contracts/res/conpi_escrow.wasm`](contracts/res/conpi_escrow.wasm) (SHA-256: `0359ae9ef66c6d6418f452ef592eb4ddd86ab2d6ff117e2fb0284c76f6c25209`)  
> **Pinned Toolchain:** [`rust-toolchain.toml`](rust-toolchain.toml) (`channel = "1.99.1"`, `wasm32-unknown-unknown`)  
> **Registered TEE Signer Pubkey:** `[Testnet Placeholder]` `ed25519:Hq4DqffDiM6pHXzwRXzLrjbPGUKkM2WMkpTZB13dZh8G`  
> **Registered Measurement:** `[Testnet Placeholder MRTD]` `c7b60e6e7655074d2e772e737c385b08fb8e15d8628bb9fb3d0ff08b98263ef26e5a40733568c07f45778a4f91ef2c01`  
> **Phase 2 TEE Specification:** [tee/attestation/README.md](tee/attestation/README.md)  
> **Documentation:** [System Design Document v1.1]

---

## 1. Executive Summary

Developers and teams routinely end up with prepaid LLM API credits they will not use (OpenAI, OpenRouter, Anthropic). Conpi makes credit exchange trust-minimised:

> **Note on Anthropic:** The native Anthropic `/v1/messages` proxy path is implemented and format-verified; it is not yet tested with a live key.

1. **Real API Key Isolation:** The real provider key is encrypted directly into a **Phala Network Intel TDX Confidential VM (TEE)** over an attested channel. The real key never leaves the secure enclave.
2. **Drop-in Proxy Key for Buyers:** The buyer receives a temporary proxy key (`cpk_live_...`) and standard base URL (`https://tee.conpi.network/v1`).
3. **NEAR Dual-Collateral Escrow:** A NEAR smart contract holds buyer payment + collateral from both parties.
4. **Staged Payouts (25% / 50% / 75% / 100%):** The TEE precision-meters token usage against locked price tables and triggers on-chain releases via Ed25519-signed attestations.
5. **Automated Dead-Key Settlement & Slashing:** If the key dies mid-deal (revoked, out of quota, or seller self-drain), the TEE detects it, freezes the meter, pays the seller pro-rata for delivered usage, refunds the remaining balance to the buyer, and **slashes the seller's collateral to compensate the buyer**. Zero human arbitrators.

---

## 2. Architecture & Trust Zones

```
                     ┌────────────────────────────────────────┐
                     │          Buyer / Seller Apps           │
                     │  (Wallet Selector, Quote Verify, E2E)  │
                     └───────┬────────────────────────┬───────┘
                             │                        │
       API Calls (Proxy Key) │                        │ Encrypted Terms & Real Key
                             ▼                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      Phala Intel TDX Enclave (TEE)                     │
│  - Remote Attestation (Intel TDX quote + in-enclave Ed25519/X25519)    │
│  - Terms Matcher (canonicalizes & computes SHA-256 terms_hash)         │
│  - Isolated Key Vault (in-memory zeroized storage)                     │
│  - OpenAI / OpenRouter Reverse Proxy & Token Meter                     │
│  - Rate Limit vs. Quota Disambiguation                                 │
│  - Ed25519 Payload Signer (ACTIVATE, STAGE, CHECKPOINT, DEFAULT)       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Signed Borsh Payloads
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      NEAR Escrow Smart Contract                        │
│  - State Machine: CREATED -> FUNDED -> ACTIVE -> COMPLETED / DEFAULTED │
│  - Multi-Asset Support (Native NEAR & NEP-141 USDC)                    │
│  - On-Chain Ed25519 Signature Verification                             │
│  - Multi-Dimensional Anti-Replay Protection                            │
│  - Staged Releases & Deterministic Collateral Slashing                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Settlement Mathematics & Worked Example

### Pilot Deal 2 Reference (40% Revocation Default):
* **Credit Amount:** $80.00
* **Agreed Price:** $60.00
* **Buyer Collateral (10%):** $6.00 (Total Buyer Deposit: $66.00)
* **Seller Collateral (20%):** $12.00
* **Total Escrow Vault:** $78.00

At 25% stage ($20 delivered): **$15.00** released to seller.  
At 40% usage ($32 delivered): Seller revokes the key.  
The TEE catches `invalid_api_key`, freezes the meter at $32.00, and triggers `settle_default`:

| Metric | Formula | Value |
|---|---|---|
| **Fraction Delivered** | $32.00 \div $80.00 | **40%** |
| **Seller Earned for Usage** | 40% \times $60.00 | **$24.00** |
| **Already Released at 25%** | — | **$15.00** |
| **Remaining Price Owed to Seller** | $24.00 - $15.00 | **$9.00** |
| **Unused Price Refunded to Buyer** | $60.00 - $24.00 | **$36.00** |
| **Buyer Collateral Returned** | Full 100% | **$6.00** |
| **Seller Collateral Slashed (80%)** | 80% \times $12.00 | **$9.60** (Paid to Buyer) |
| **Seller Collateral Returned** | $12.00 - $9.60 | **$2.40** (Paid to Seller) |
| **Settlement Tx Transfer to Seller** | $9.00 + $2.40 | **$11.40** |
| **Settlement Tx Transfer to Buyer** | $36.00 + $6.00 + $9.60 | **$51.60** |
| **Total Distributed** | $11.40 + $51.60 | **$63.00** (Exact escrow balance) |

**Final Cash Outcome:**
* **Seller Net Cash:** $+14.40 ($15.00 stage + $11.40 settlement - $12.00 collateral)
* **Buyer Net Cash:** $-14.40 ($51.60 received - $66.00 deposited) $\implies$ Buyer paid only $14.40 net for $32.00 worth of LLM usage (the $9.60 difference is the slashed seller collateral compensating for the broken deal).

---

## 4. Repository Structure

```
confi/
├── contracts/          # NEAR Escrow Smart Contract in Rust (near-sdk v5.30)
│   ├── src/
│   │   ├── lib.rs      # State machine, admin, lifecycle & view methods
│   │   ├── types.rs    # Borsh & Serde data structs, Deal, SignedPayload
│   │   ├── crypto.rs   # Ed25519 signature checks, Borsh canonicalizer, anti-replay
│   │   ├── settlement.rs # Staged release math, pro-rata default & slashing
│   │   ├── events.rs   # NEP-297 event standards for NEAR indexers
│   │   └── tests.rs    # Unit & integration test suite (19 comprehensive tests)
│   └── tests/
│       └── workspaces_tests.rs # near-workspaces sandbox & on-chain multisig simulation (4 tests)
├── web/                # Next.js 14 application
│   ├── app/            # Market, deals, meter, trust, governance, claims
│   └── components/     # Shell, deal flow, and shared UI
├── tee-service/        # Phala Network Intel TDX CVM Service (Phase 2)
└── shared/             # Shared TypeScript & Rust schema definitions
```

---

## 5. Building & Testing

### Smart Contract:
```bash
cd contracts

# Run all unit, settlement math, checkpoint, and governance tests (29 tests)
cargo test

# Run near-workspaces integration tests (6 tests)
cargo test --test workspaces_tests -- --nocapture

# Compile reproducible WASM binary with embedded ABI
cargo near build reproducible-wasm --locked
# Output: target/near/conpi_escrow.wasm (297.1 KB, Hash: E5YED19GaPXvpc8kiVn5kCXB21eWMA5SpCBDn7iV7nG)
```

### Web Application:
```bash
cd web
npm install
npm run build
npm run dev
# Open http://localhost:3000
```

### TEE Service and Automated Settlement:
```bash
cd tee-service
npm ci
npm test
npm run build
```

Phase 4 automatically relays hardware-signed 25/50/75/100 stage releases,
periodic checkpoints, and deterministic defaults. Transactions are serialized
per deal, checked against on-chain state before retry, and remain available for
manual wallet submission if the relayer is temporarily unavailable.

The production CVM expects `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` as
Phala encrypted secrets. The relayer key must be a function-call key restricted
to the escrow contract methods `release_stage`, `checkpoint`, and
`settle_default`. `CHECKPOINT_INTERVAL_MS` defaults to five minutes and must
remain below the deal's TEE liveness timeout.

The optional live proof creates and funds a small NEAR Testnet deal and sends a
locally stored OpenRouter key encrypted to the hard-coded, attested production
CVM. It is deliberately disabled unless the operator reviews the destination
and supplies an explicit confirmation:

```bash
cd tee-service
CONPI_LIVE_PROOF_CONFIRMATION=I_APPROVE_ENCRYPTED_OPENROUTER_KEY_UPLOAD ./node_modules/.bin/tsx scripts/phase4-live-proof.ts
```
