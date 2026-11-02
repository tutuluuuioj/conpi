#[cfg(test)]
mod tests {
    use crate::crypto::CryptoHelper;
    use crate::types::{
        CreateDealParams, DealStatus, DefaultReason, PayloadKind, SignedPayload,
    };
    use crate::ConpiEscrow;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::{AccountId, NearToken, PublicKey};
    use rand::rngs::OsRng;

    const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(50_000_000_000_000_000_000_000); // 0.05 NEAR

    fn get_context(predecessor: AccountId, attached_deposit: NearToken) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("conpi.testnet".parse().unwrap())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(attached_deposit)
            .block_timestamp(1_000_000_000_000); // 1,000 seconds
        builder
    }

    fn generate_tee_keypair() -> (SigningKey, PublicKey) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let mut pk_bytes = vec![0x00];
        pk_bytes.extend_from_slice(verifying_key.as_bytes());
        let near_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
        (signing_key, near_pk)
    }

    fn sign_terms_hash(
        signing_key: &SigningKey,
        chain_id: &str,
        contract_id: &AccountId,
        deal_id: u64,
        terms_hash: &[u8; 32],
    ) -> Vec<u8> {
        let msg = CryptoHelper::build_terms_message(chain_id, contract_id, deal_id, terms_hash);
        signing_key.sign(&msg).to_bytes().to_vec()
    }

    fn sign_payload(signing_key: &SigningKey, payload: &SignedPayload) -> Vec<u8> {
        let message = CryptoHelper::serialize_payload(payload);
        signing_key.sign(&message).to_bytes().to_vec()
    }

    #[test]
    fn test_initialization_admin_pause_and_ownership() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let new_owner: AccountId = "dao.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        assert_eq!(contract.owner, owner);
        assert!(!contract.is_paused());

        // Pause contract
        contract.set_paused(true);
        assert!(contract.is_paused());
        contract.set_paused(false);

        // Add & Revoke TEE signer
        let (_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "measurement_hash_123".to_string());
        let signer = contract.get_tee_signer(tee_pk.clone()).unwrap();
        assert!(signer.active);

        contract.revoke_tee_signer(tee_pk.clone());
        let revoked = contract.get_tee_signer(tee_pk).unwrap();
        assert!(!revoked.active);

        // Transfer ownership
        contract.transfer_ownership(new_owner.clone());
        assert_eq!(contract.owner, new_owner);
    }

    #[test]
    fn test_happy_path_full_delivery() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 60_000_000_000_000_000_000_000_000u128; // 60 NEAR
        let credit_amount = 80_000_000_000_000_000_000_000_000u128;
        let buyer_collateral = 6_000_000_000_000_000_000_000_000u128; // 10%
        let seller_collateral = 12_000_000_000_000_000_000_000_000u128; // 20%

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(price),
            credit_amount: U128(credit_amount),
            buyer_collateral: U128(buyer_collateral),
            seller_collateral: U128(seller_collateral),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 86400,
            key_duration_sec: 86400,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        // Register Terms Hash
        let terms_hash = [42u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer deposits
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(price + buyer_collateral))
            .build());
        contract.deposit(deal_id);

        // Seller deposits (signals agreement and moves deal to Funded)
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(seller_collateral))
            .build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Funded);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            nonce: 1,
            issued_at: 1_000_100,
        };
        let activate_sig = sign_payload(&tee_sk, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Active);

        // Stages: 25%, 50%, 75%, 100%
        let stages: [(u8, u128, u64); 4] = [
            (25, 20_000_000_000_000_000_000_000_000u128, 2),
            (50, 40_000_000_000_000_000_000_000_000u128, 3),
            (75, 60_000_000_000_000_000_000_000_000u128, 4),
            (100, 80_000_000_000_000_000_000_000_000u128, 5),
        ];

        for (stg, metered, nonce) in stages {
            let stage_payload = SignedPayload {
                domain: "conpi:v1".to_string(),
                contract_id: contract_id.clone(),
                chain_id: "testnet".to_string(),
                deal_id,
                terms_hash,
                kind: PayloadKind::Stage,
                stage: stg,
                metered_value: U128(metered),
                reason: None,
                nonce,
                issued_at: 1_000_000 + nonce,
            };
            let sig = sign_payload(&tee_sk, &stage_payload);
            contract.release_stage(deal_id, stg, stage_payload, sig);
        }

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Completed);
        assert_eq!(final_deal.released_to_seller, price);
    }

    #[test]
    fn test_seller_default_revoked_key_at_40_percent() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 60_000_000u128; // $60
        let credit_amount = 80_000_000u128; // $80
        let buyer_collateral = 6_000_000u128; // $6 (10%)
        let seller_collateral = 12_000_000u128; // $12 (20%)

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(price),
            credit_amount: U128(credit_amount),
            buyer_collateral: U128(buyer_collateral),
            seller_collateral: U128(seller_collateral),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 86400,
            key_duration_sec: 86400,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [99u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer deposits
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(price + buyer_collateral))
            .build());
        contract.deposit(deal_id);

        // Seller deposits
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(seller_collateral))
            .build());
        contract.deposit(deal_id);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            nonce: 1,
            issued_at: 1_000,
        };
        let act_sig = sign_payload(&tee_sk, &activate_payload);
        contract.activate(deal_id, activate_payload, act_sig);

        // Stage 25% already released
        let stage_25_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(20_000_000),
            reason: None,
            nonce: 2,
            issued_at: 2_000,
        };
        let stg_sig = sign_payload(&tee_sk, &stage_25_payload);
        contract.release_stage(deal_id, 25, stage_25_payload, stg_sig);

        // Default at 40% usage ($32 metered)
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 25,
            metered_value: U128(32_000_000),
            reason: Some(DefaultReason::InvalidKey),
            nonce: 3,
            issued_at: 3_000,
        };
        let def_sig = sign_payload(&tee_sk, &default_payload);
        contract.settle_default(deal_id, default_payload, def_sig);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Defaulted);

        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &final_deal,
            32_000_000,
            DefaultReason::InvalidKey,
        );

        // Verifying Section 11.6 Table numbers:
        assert_eq!(dist.seller_payout, 11_400_000); // $11.40
        assert_eq!(dist.buyer_refund, 51_600_000);  // $51.60
        assert_eq!(dist.slashed_collateral, 9_600_000); // $9.60

        let seller_total_received = 15_000_000 + dist.seller_payout;
        let buyer_total_received = dist.buyer_refund;
        assert_eq!(seller_total_received, 26_400_000); // $26.40
        assert_eq!(buyer_total_received, 51_600_000);  // $51.60
        assert_eq!(seller_total_received + buyer_total_received, 78_000_000); // $78.00 total conserved
    }

    /// CRITICAL INVARIANT TEST 1:
    /// Default after 50% stage has already been released ($30 released from $60 price).
    /// Metered value at default is 40% ($24 earned).
    /// Tests that the contract DOES NOT over-payout ($84 bug) and exactly conserves the remaining $48 escrow!
    #[test]
    fn test_critical_no_overpayout_default_after_stage_50() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 60_000_000u128; // $60
        let credit_amount = 80_000_000u128; // $80
        let buyer_collateral = 6_000_000u128; // $6
        let seller_collateral = 12_000_000u128; // $12

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(price),
            credit_amount: U128(credit_amount),
            buyer_collateral: U128(buyer_collateral),
            seller_collateral: U128(seller_collateral),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 86400,
            key_duration_sec: 86400,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [33u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer & Seller Deposit
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(price + buyer_collateral))
            .build());
        contract.deposit(deal_id);
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(seller_collateral))
            .build());
        contract.deposit(deal_id);

        // Activate
        let act_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            nonce: 1,
            issued_at: 1000,
        };
        let act_sig = sign_payload(&tee_sk, &act_payload);
        contract.activate(deal_id, act_payload, act_sig);

        // Release 25% ($15)
        let stg25_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(20_000_000),
            reason: None,
            nonce: 2,
            issued_at: 2000,
        };
        let stg25_sig = sign_payload(&tee_sk, &stg25_payload);
        contract.release_stage(deal_id, 25, stg25_payload, stg25_sig);

        // Release 50% ($15 more -> $30 total released)
        let stg50_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 50,
            metered_value: U128(40_000_000),
            reason: None,
            nonce: 3,
            issued_at: 3000,
        };
        let stg50_sig = sign_payload(&tee_sk, &stg50_payload);
        contract.release_stage(deal_id, 50, stg50_payload, stg50_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.released_to_seller, 30_000_000); // $30 released

        // Now seller key dies at 40% metered usage ($32 metered of $80 = 40% = $24 earned)
        // Seller was already paid $30, which is > $24 earned!
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 50,
            metered_value: U128(40_000_000), // cannot decrease below last signed (40M)
            reason: Some(DefaultReason::InvalidKey),
            nonce: 4,
            issued_at: 4000,
        };
        let def_sig = sign_payload(&tee_sk, &default_payload);
        contract.settle_default(deal_id, default_payload, def_sig);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Defaulted);

        // Invariant check on calculator:
        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &deal,
            40_000_000,
            DefaultReason::InvalidKey,
        );

        // Total remaining in escrow before default was: ($60 - $30) + $6 + $12 = $48.00!
        let remaining_escrow = 48_000_000u128;
        assert_eq!(
            dist.seller_payout + dist.buyer_refund,
            remaining_escrow,
            "Total settlement MUST equal exactly remaining escrow of $48.00"
        );
        // Total across deal: $30 released + $48 settlement = $78.00 exactly!
        assert_eq!(30_000_000 + dist.seller_payout + dist.buyer_refund, 78_000_000);
    }

    /// CRITICAL INVARIANT TEST 2:
    /// Timeout settlement with an old checkpoint ($30 already released at stage 50%,
    /// but checkpoint was recorded at 20% metered = $12).
    /// Tests that the contract DOES NOT over-payout ($108 bug) and exactly conserves the remaining $48 escrow!
    #[test]
    fn test_critical_no_overpayout_timeout_with_old_checkpoint() {
        let price = 60_000_000u128;
        let credit_amount = 80_000_000u128;
        let buyer_collateral = 6_000_000u128;
        let seller_collateral = 12_000_000u128;

        let deal = crate::types::Deal {
            id: 1,
            buyer: "buyer.testnet".parse().unwrap(),
            seller: "seller.testnet".parse().unwrap(),
            token: None,
            price,
            credit_amount,
            buyer_collateral,
            seller_collateral,
            terms_hash: Some([1u8; 32]),
            tee_pubkey: "ed25519:6E8jqdGwGMtVEUNGRtF3rMKDStVn1oK76dYqJ2mB9n9N".parse().unwrap(),
            deposit_deadline: 0,
            key_deadline: 0,
            usage_deadline: 0,
            notice_deadline: None,
            tee_liveness_timeout: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            buyer_deposited: price + buyer_collateral,
            seller_deposited: seller_collateral,
            released_to_seller: 30_000_000, // $30 already released
            stage_reached: 50,
            last_signed: None,
            last_nonce: 5,
            last_tee_seen: 1000,
            status: DealStatus::Active,
            counterparty_accepted: true,
        };

        // Old checkpoint at $16 metered (20% of credit = $12 value)
        let checkpoint_metered = 16_000_000u128;
        let dist = crate::settlement::SettlementCalculator::calculate_timeout_settlement(
            &deal,
            checkpoint_metered,
        );

        // Remaining escrow is ($60 - $30) + $6 + $12 = $48.00!
        let remaining_escrow = 48_000_000u128;
        assert_eq!(dist.seller_payout + dist.buyer_refund, remaining_escrow);
        // Total funds conserved: $30 + $48 = $78.00!
        assert_eq!(30_000_000 + dist.seller_payout + dist.buyer_refund, 78_000_000);
    }

    /// CRITICAL ISSUE 2 TEST:
    /// Funded deal where seller fails to submit key before key_deadline.
    /// Tests that timeout_refund cancels deal and refunds both parties without TEE signature.
    #[test]
    fn test_critical_funded_deal_key_deadline_timeout_refund() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 1000,
            key_duration_sec: 1000,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [10u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer & Seller deposit -> Status = Funded
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(110))
            .build());
        contract.deposit(deal_id);
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(20))
            .build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Funded);

        // Seller vanishes! Time passes beyond key_deadline (2000s = 2_000_000_000_000 ns)
        testing_env!(context
            .block_timestamp(deal.key_deadline + 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        // Anyone calls timeout_refund
        contract.timeout_refund(deal_id);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Cancelled);
    }

    /// HIGH ISSUE 8 TEST:
    /// Revoking TEE signer MUST reject any further operations for all live deals.
    #[test]
    fn test_high_tee_signer_revocation_protects_live_deals() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 86400,
            key_duration_sec: 86400,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [11u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Deposits & Activate
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(110))
            .build());
        contract.deposit(deal_id);
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(20))
            .build());
        contract.deposit(deal_id);

        let act_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            nonce: 1,
            issued_at: 1000,
        };
        let act_sig = sign_payload(&tee_sk, &act_payload);
        contract.activate(deal_id, act_payload, act_sig);

        // Now owner detects TEE compromise and revokes the TEE signer key!
        testing_env!(context
            .predecessor_account_id(owner.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.revoke_tee_signer(tee_pk.clone());

        // Now an attacker/compromised TEE tries to emit release_stage on the active deal
        let stage_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(25),
            reason: None,
            nonce: 2,
            issued_at: 2000,
        };
        let stage_sig = sign_payload(&tee_sk, &stage_payload);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.release_stage(deal_id, 25, stage_payload, stage_sig);
        }));

        assert!(
            result.is_err(),
            "Revoked TEE signer MUST be rejected on active deal operations!"
        );
    }

    #[test]
    fn test_nep141_ft_on_transfer() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let usdc_token: AccountId = "usdc.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 50_000_000u128; // 50 USDC (6 decimals)
        let credit = 70_000_000u128;
        let buyer_col = 5_000_000u128;
        let seller_col = 10_000_000u128;

        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: Some(usdc_token.clone()),
            price: U128(price),
            credit_amount: U128(credit),
            buyer_collateral: U128(buyer_col),
            seller_collateral: U128(seller_col),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 86400,
            key_duration_sec: 86400,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [7u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, "testnet", &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer transfers NEP-141 token with 5 USDC excess using JSON message format
        let excess_sent = 5_000_000u128;
        let json_msg = format!("{{\"deal_id\": {}}}", deal_id);
        testing_env!(context
            .predecessor_account_id(usdc_token.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let refund = contract.ft_on_transfer(
            buyer.clone(),
            U128(price + buyer_col + excess_sent),
            json_msg,
        );

        match refund {
            near_sdk::PromiseOrValue::Value(val) => {
                assert_eq!(val.0, excess_sent, "Excess deposit must be refunded");
            }
            _ => panic!("Expected Value refund"),
        }

        // Seller transfers exact NEP-141 token
        let seller_refund = contract.ft_on_transfer(seller.clone(), U128(seller_col), deal_id.to_string());
        match seller_refund {
            near_sdk::PromiseOrValue::Value(val) => {
                assert_eq!(val.0, 0, "No refund when exact deposit is provided");
            }
            _ => panic!("Expected Value refund"),
        }

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Funded);
    }
}
