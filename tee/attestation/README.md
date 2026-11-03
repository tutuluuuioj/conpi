# Conpi TEE Remote Attestation Specification (Phase 2 Roadmap)

> **IMPORTANT NOTICE:** All TEE signer keys and measurements registered in Phase 1 on NEAR Testnet are **testnet placeholders** used to verify the on-chain escrow, settlement mathematics, Borsh serialization, and signature verification logic. No real Intel TDX hardware attestation quote exists in Phase 1. Real enclave keys and attestation quotes will be generated inside a live Phala Network Intel TDX Confidential VM (CVM) during Phase 2.

---

## 1. Phase 2 Intel TDX Attestation Architecture

In Phase 2, the TEE proxy runs inside a **Phala Network dstack CVM (Confidential Virtual Machine)** powered by Intel TDX (Trust Domain Extensions).

```
┌─────────────────────────────────────────────────────────────┐
│                 Phala Intel TDX CVM (dstack)                │
│                                                             │
│ 1. Ephemeral In-Enclave Key Generation:                     │
│    - ed25519_sk is generated in volatile RAM               │
│    - Private key NEVER leaves memory / NEVER touches disk   │
│    - report_data = SHA256(ed25519_pk)                       │
│                                                             │
│ 2. Hardware Quote Retrieval:                                │
│    - Unix Socket: /var/run/tappd.sock                       │
│    - Requests TDX Report with report_data                   │
│    - Intel TDX Quote Generation via PCK & QE3               │
│                                                             │
│ 3. Quote Payload Published to NEAR:                         │
│    - Raw TDX Quote (v4 binary)                              │
│    - Intel PCK Certificate Chain                            │
│    - Signed TEE Public Key                                  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                Quote Verification on NEAR                   │
│                                                             │
│ Option A: On-Chain Intel TDX Quote Verifier Contract        │
│   - Verifies ECDSA signature using Intel Root CA cert       │
│   - Validates TCB status (UpToDate / SwHardeningNeeded)     │
│   - Verifies report_data == SHA256(ed25519_pk)              │
│   - Extracts and verifies MRTD, RTMR0, RTMR1, RTMR2         │
│                                                             │
│ Option B: SputnikDAO / Multisig Attested Registry           │
│   - Quote and cert chain submitted to DAO proposal          │
│   - Council members independently verify TDX quote against   │
│     Intel PCS (Provisioning Certification Service) API      │
│   - DAO executes propose_admin_action(AddTeeSigner)         │
│   - 48-hour timelock elapses before signer becomes active   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. How the Contract Trusts the Measurement

In the Conpi Escrow contract:
1. **On-Chain Representation:** The contract stores registered signers in `tee_signers: UnorderedMap<PublicKey, TeeSigner>`.
2. **Measurement Verification:** 
   - A measurement represents the exact hash of the enclave's initial memory and kernel configuration (MRTD: Measurement of the Root Trust Domain).
   - In Phase 1, registration is guarded by the DAO owner through the 48-hour timelocked governance method `propose_admin_action(AdminAction::AddTeeSigner { public_key, measurement })`.
   - In Phase 2, the `measurement` registered must strictly match the deterministic build hash of the open-source Conpi proxy Docker container produced by Phala dstack's reproducible build pipeline.
   - Any modification to the TEE proxy source code changes the MRTD, rendering unauthorized enclave instances unable to produce valid signatures recognized by the contract.
