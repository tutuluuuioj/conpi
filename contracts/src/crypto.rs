use crate::types::{Balance, Deal, PayloadKind, SignedPayload};
use near_sdk::{env, near, AccountId, CurveType, Duration, PublicKey};

#[near]
pub struct CryptoHelper;

impl CryptoHelper {
    /// Extracts the raw 32-byte Ed25519 public key bytes from a near_sdk::PublicKey.
    pub fn extract_ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
        let pk_bytes = pk.as_bytes();
        assert_eq!(
            pk.curve_type(),
            CurveType::ED25519,
            "Only ED25519 keys are supported"
        );
        assert_eq!(pk_bytes.len(), 33, "Invalid ED25519 public key length");
        let mut raw = [0u8; 32];
        raw.copy_from_slice(&pk_bytes[1..33]);
        raw
    }

    /// Computes canonical terms_hash on-chain from the agreed deal parameters.
    pub fn compute_terms_hash(
        deal_id: u64,
        buyer: &AccountId,
        seller: &AccountId,
        token: &Option<AccountId>,
        price: Balance,
        credit_amount: Balance,
        buyer_collateral: Balance,
        seller_collateral: Balance,
        tee_pubkey: &PublicKey,
        deposit_duration: Duration,
        key_duration: Duration,
        tee_liveness_timeout: Duration,
        slash_bps_provider_ban: u16,
        slash_bps_revoke: u16,
        slash_bps_buyer_breach: u16,
    ) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(b"conpi:v1:terms_hash:");
        data.extend_from_slice(&deal_id.to_le_bytes());
        data.extend_from_slice(buyer.as_bytes());
        data.extend_from_slice(b":");
        data.extend_from_slice(seller.as_bytes());
        data.extend_from_slice(b":");
        if let Some(tok) = token {
            data.extend_from_slice(tok.as_bytes());
        } else {
            data.extend_from_slice(b"native_near");
        }
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&credit_amount.to_le_bytes());
        data.extend_from_slice(&buyer_collateral.to_le_bytes());
        data.extend_from_slice(&seller_collateral.to_le_bytes());
        data.extend_from_slice(tee_pubkey.as_bytes());
        data.extend_from_slice(&deposit_duration.to_le_bytes());
        data.extend_from_slice(&key_duration.to_le_bytes());
        data.extend_from_slice(&tee_liveness_timeout.to_le_bytes());
        data.extend_from_slice(&slash_bps_provider_ban.to_le_bytes());
        data.extend_from_slice(&slash_bps_revoke.to_le_bytes());
        data.extend_from_slice(&slash_bps_buyer_breach.to_le_bytes());
        env::sha256_array(&data)
    }

    /// Serializes a SignedPayload canonically into Borsh bytes.
    pub fn serialize_payload(payload: &SignedPayload) -> Vec<u8> {
        borsh::to_vec(payload).expect("Failed to serialize SignedPayload")
    }

    /// Constructs the canonical message for register_terms_hash.
    /// Binds domain separator, chain_id, contract_id, deal_id, and terms_hash.
    pub fn build_terms_message(
        chain_id: &str,
        contract_id: &AccountId,
        deal_id: u64,
        terms_hash: &[u8; 32],
    ) -> Vec<u8> {
        let mut msg_bytes = Vec::new();
        msg_bytes.extend_from_slice(b"conpi:v1:terms:");
        msg_bytes.extend_from_slice(chain_id.as_bytes());
        msg_bytes.extend_from_slice(b":");
        msg_bytes.extend_from_slice(contract_id.as_bytes());
        msg_bytes.extend_from_slice(b":");
        msg_bytes.extend_from_slice(&deal_id.to_le_bytes());
        msg_bytes.extend_from_slice(terms_hash);
        msg_bytes
    }

    /// Verifies that a SignedPayload is valid against deal parameters and replay constraints,
    /// then verifies the Ed25519 signature against the authorized TEE public key.
    pub fn verify_signed_payload(
        payload: &SignedPayload,
        sig_bytes: &[u8],
        expected_tee_pk: &PublicKey,
        deal: &Deal,
        expected_contract_id: &AccountId,
        expected_chain_id: &str,
        expected_kind: PayloadKind,
    ) {
        // 1. Replay Protection & Parameter Validation
        assert_eq!(payload.domain, "conpi:v1", "Invalid domain separator");
        assert_eq!(
            payload.chain_id, expected_chain_id,
            "chain_id mismatch (expected {}, got {})",
            expected_chain_id, payload.chain_id
        );
        assert_eq!(
            &payload.contract_id, expected_contract_id,
            "contract_id mismatch"
        );
        assert_eq!(payload.deal_id, deal.id, "deal_id mismatch");
        assert_eq!(payload.kind, expected_kind, "Unexpected payload kind");

        // If terms_hash has already been set, payload must match it
        if let Some(terms_hash) = deal.terms_hash {
            assert_eq!(
                payload.terms_hash, terms_hash,
                "terms_hash does not match agreed terms"
            );
        }

        // Strictly increasing nonce per deal
        assert!(
            payload.nonce > deal.last_nonce,
            "Nonce must be strictly greater than last_nonce ({} vs {})",
            payload.nonce,
            deal.last_nonce
        );

        // Block timestamp verification: issued_at must not be in the future (> 5 min tolerance)
        let now = env::block_timestamp();
        assert!(
            payload.issued_at <= now + 300_000_000_000,
            "issued_at cannot be in the future (issued_at: {}, block_timestamp: {})",
            payload.issued_at,
            now
        );

        // Metered value must never decrease
        if let Some(ref last_signed) = deal.last_signed {
            assert!(
                payload.metered_value.0 >= last_signed.metered_value.0,
                "Metered value cannot decrease ({} vs {})",
                payload.metered_value.0,
                last_signed.metered_value.0
            );
            assert!(
                payload.issued_at >= last_signed.issued_at,
                "issued_at cannot go backwards in time"
            );
        }

        // 2. Validate signature format
        assert_eq!(sig_bytes.len(), 64, "Signature must be 64 bytes");
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);

        // 3. Serialize canonical message
        let message = Self::serialize_payload(payload);

        // 4. Extract 32-byte raw ED25519 public key
        let raw_pk = Self::extract_ed25519_bytes(expected_tee_pk);

        // 5. Verify Ed25519 signature using near_sdk host function
        let is_valid = env::ed25519_verify(&sig_arr, &message, &raw_pk);
        assert!(is_valid, "Invalid TEE signature on payload");
    }

    /// Signature verification for arbitrary bytes against a TEE public key.
    pub fn verify_signature_raw(message: &[u8], sig_bytes: &[u8], pk: &PublicKey) -> bool {
        if sig_bytes.len() != 64 {
            return false;
        }
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);
        let raw_pk = Self::extract_ed25519_bytes(pk);
        env::ed25519_verify(&sig_arr, message, &raw_pk)
    }
}
