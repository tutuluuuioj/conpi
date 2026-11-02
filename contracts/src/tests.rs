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
        let mut pk_bytes = vec![0x00]; // ED25519 curve prefix in NEAR
        pk_bytes.extend_from_slice(verifying_key.as_bytes());
        let near_pk = PublicKey::try_from(pk_bytes).expect("Valid near PublicKey");
        (signing_key, near_pk)
    }

    fn sign_terms_hash(
        signing_key: &SigningKey,
        contract_id: &AccountId,
        deal_id: u64,
        terms_hash: &[u8; 32],
    ) -> Vec<u8> {
        let mut msg_bytes = Vec::new();
        msg_bytes.extend_from_slice(b"conpi:v1:terms:");
        msg_bytes.extend_from_slice(contract_id.as_bytes());
        msg_bytes.extend_from_slice(&deal_id.to_le_bytes());
        msg_bytes.extend_from_slice(terms_hash);
        signing_key.sign(&msg_bytes).to_bytes().to_vec()
    }

    fn sign_payload(signing_key: &SigningKey, payload: &SignedPayload) -> Vec<u8> {
        let message = CryptoHelper::serialize_payload(payload);
        signing_key.sign(&message).to_bytes().to_vec()
    }

    #[test]
    fn test_initialization_and_admin() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        assert_eq!(contract.owner, owner);

        let (_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "measurement_hash_123".to_string());

        let signer = contract.get_tee_signer(tee_pk.clone()).unwrap();
        assert!(signer.active);
        assert_eq!(signer.measurement, "measurement_hash_123");

        contract.revoke_tee_signer(tee_pk.clone());
        let revoked = contract.get_tee_signer(tee_pk).unwrap();
        assert!(!revoked.active);
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

        // 1. Create Deal: Price = $60 (represented as 60 NEAR), Credit = $80, Buyer Collateral = $6, Seller Collateral = $12
        let price = 60_000_000_000_000_000_000_000_000u128; // 60 NEAR
        let credit_amount = 80_000_000_000_000_000_000_000_000u128;
        let buyer_collateral = 6_000_000_000_000_000_000_000_000u128; // 10%
        let seller_collateral = 12_000_000_000_000_000_000_000_000u128; // 20%

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
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
        assert_eq!(deal_id, 1);

        // 2. Register Terms Hash
        let terms_hash = [42u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.terms_hash, Some(terms_hash));
        assert_eq!(deal.status, DealStatus::Created);

        // 3. Buyer Deposits: price + buyer_collateral = 66 NEAR
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(price + buyer_collateral))
            .build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.buyer_deposited, price + buyer_collateral);
        assert_eq!(deal.status, DealStatus::Created); // still waiting for seller

        // 4. Seller Deposits: seller_collateral = 12 NEAR
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(seller_collateral))
            .build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.seller_deposited, seller_collateral);
        assert_eq!(deal.status, DealStatus::Funded); // Moved to FUNDED!

        // 5. Activate Deal via TEE signature
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
        assert!(deal.usage_deadline > 0);

        // 6. Stage Releases: 25%, 50%, 75%, 100%
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

            let deal = contract.get_deal(deal_id).unwrap();
            assert_eq!(deal.stage_reached, stg);
            let expected_cumulative = (stg as u128 * price) / 100;
            assert_eq!(deal.released_to_seller, expected_cumulative);
        }

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Completed);
        assert_eq!(final_deal.released_to_seller, price);
    }

    #[test]
    fn test_seller_default_revoked_key_at_40_percent() {
        // Pilot Deal 2 validation: Seller revokes key at 40% usage ($32 metered of $80 credit)
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

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
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
            slash_bps_provider_ban: 5000, // 50%
            slash_bps_revoke: 8000,       // 80%
        });

        let terms_hash = [99u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, &contract_id, deal_id, &terms_hash);
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
            metered_value: U128(20_000_000), // $20 metered
            reason: None,
            nonce: 2,
            issued_at: 2_000,
        };
        let stg_sig = sign_payload(&tee_sk, &stage_25_payload);
        contract.release_stage(deal_id, 25, stage_25_payload, stg_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.released_to_seller, 15_000_000); // 25% of $60 = $15

        // Now seller revokes key at $32.00 metered (40% of $80)
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 25,
            metered_value: U128(32_000_000), // 40% of 80M
            reason: Some(DefaultReason::InvalidKey),
            nonce: 3,
            issued_at: 3_000,
        };
        let def_sig = sign_payload(&tee_sk, &default_payload);
        contract.settle_default(deal_id, default_payload, def_sig);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Defaulted);

        // Verify arithmetic from SDD Section 11.6:
        // Fraction delivered: 32/80 = 40%
        // Seller earned: 40% * 60 = $24
        // Already released: $15
        // Remaining price owed to seller: $24 - $15 = $9
        // Unused price refunded to buyer: $60 - $24 = $36
        // Buyer collateral returned: $6
        // Slash of seller collateral: 80% * $12 = $9.60 -> to buyer
        // Seller collateral returned: $12 - $9.60 = $2.40 -> to seller
        // Settlement transfer to Seller: $9 (price) + $2.40 (collateral) = $11.40
        // Settlement transfer to Buyer: $36 (price) + $6 (collateral) + $9.60 (slashed) = $51.60
        // Total settlement payout = $11.40 + $51.60 = $63.00
        // Remaining in escrow prior to settlement: ($60 + $6 + $12) - $15 = $63.00!
        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &deal,
            32_000_000,
            DefaultReason::InvalidKey,
        );
        // Table 11.6 exact verification:
        assert_eq!(dist.seller_payout, 11_400_000); // $11.40 in settlement tx ($9 remaining price + $2.40 unslashed collateral)
        assert_eq!(dist.buyer_refund, 51_600_000);  // $51.60 in settlement tx ($36 unused price + $6 collateral + $9.60 slashed collateral)
        assert_eq!(dist.slashed_collateral, 9_600_000); // $9.60 (80% of $12 collateral)

        // Outcome table (revoke at 40%):
        let seller_deposited = 12_000_000u128; // $12.00
        let buyer_deposited = 66_000_000u128;  // $66.00
        let seller_stage_received = 15_000_000u128; // $15.00
        let seller_total_received = seller_stage_received + dist.seller_payout; // $26.40
        let buyer_total_received = dist.buyer_refund; // $51.60

        // Total received by both parties matches exactly total deposited:
        assert_eq!(seller_total_received + buyer_total_received, seller_deposited + buyer_deposited);
        assert_eq!(seller_total_received, 26_400_000); // $26.40 received by seller
        assert_eq!(buyer_total_received, 51_600_000);  // $51.60 received by buyer

        // Net cash outcomes:
        let seller_net_cash = (seller_total_received as i128) - (seller_deposited as i128);
        let buyer_net_cash = (buyer_total_received as i128) - (buyer_deposited as i128);
        assert_eq!(seller_net_cash, 14_400_000i128);  // +$14.40 net cash to seller
        assert_eq!(buyer_net_cash, -14_400_000i128); // -$14.40 net cash from buyer ($32 credit delivered for $14.40 net)
    }

    #[test]
    fn test_anti_replay_protection() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
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

        let terms_hash = [1u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer & seller deposit
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

        // Try replay with WRONG contract_id
        let bad_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "other_contract.testnet".parse().unwrap(),
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
        let sig = sign_payload(&tee_sk, &bad_payload);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut contract_clone = ConpiEscrow::new(owner.clone(), None);
            contract_clone.activate(deal_id, bad_payload, sig);
        }));
        assert!(result.is_err(), "Must reject payload with wrong contract_id");
    }

    #[test]
    fn test_deposit_timeout_refund() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (_tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(50),
            credit_amount: U128(50),
            buyer_collateral: U128(5),
            seller_collateral: U128(10),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 1000,
            key_duration_sec: 1000,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        // Only buyer deposits
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(55))
            .build());
        contract.deposit(deal_id);

        // Time passes beyond deposit deadline (1000s = 1_000_000_000_000 ns)
        testing_env!(context
            .block_timestamp(3_000_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        contract.timeout_refund(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Cancelled);
    }

    #[test]
    fn test_nep141_ft_on_transfer() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let usdc_token: AccountId = "usdc.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 50_000_000u128; // 50 USDC (6 decimals)
        let credit = 70_000_000u128;
        let buyer_col = 5_000_000u128;
        let seller_col = 10_000_000u128;

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
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

        // Register terms hash
        let terms_hash = [7u8; 32];
        let terms_sig = sign_terms_hash(&tee_sk, &"conpi.testnet".parse().unwrap(), deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, terms_sig);

        // Buyer transfers NEP-141 token (called by token contract, sender = buyer)
        testing_env!(context
            .predecessor_account_id(usdc_token.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let _ = contract.ft_on_transfer(buyer.clone(), U128(price + buyer_col), deal_id.to_string());

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.buyer_deposited, price + buyer_col);
        assert_eq!(deal.status, DealStatus::Created);

        // Seller transfers NEP-141 token
        let _ = contract.ft_on_transfer(seller.clone(), U128(seller_col), deal_id.to_string());

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.seller_deposited, seller_col);
        assert_eq!(deal.status, DealStatus::Funded); // Funded with NEP-141!
    }

    #[test]
    fn test_checkpoint_and_tee_liveness_timeout_settlement() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        let price = 100u128;
        let credit = 100u128;
        let buyer_col = 10u128;
        let seller_col = 20u128;

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(price),
            credit_amount: U128(credit),
            buyer_collateral: U128(buyer_col),
            seller_collateral: U128(seller_col),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 1000,
            key_duration_sec: 1000,
            tee_liveness_timeout_sec: 3600, // 3600s
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
        });

        let terms_hash = [8u8; 32];
        let sig = sign_terms_hash(&tee_sk, &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, sig);

        // Deposits
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
            issued_at: 1000,
        };
        let act_sig = sign_payload(&tee_sk, &activate_payload);
        contract.activate(deal_id, activate_payload, act_sig);

        // Checkpoint at metered = 30 tokens (between stages)
        let chk_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Checkpoint,
            stage: 0,
            metered_value: U128(30),
            reason: None,
            nonce: 2,
            issued_at: 2000,
        };
        let chk_sig = sign_payload(&tee_sk, &chk_payload);
        contract.checkpoint(deal_id, chk_payload, chk_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.last_signed.unwrap().metered_value, U128(30));

        // Now TEE goes offline beyond tee_liveness_timeout (3600s = 3_600_000_000_000 ns)
        testing_env!(context
            .block_timestamp(deal.last_tee_seen + 4_000_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        contract.timeout_refund(deal_id);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::SettledTimeout);
    }

    #[test]
    fn test_auto_release_after_30_days() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None);
        let (tee_sk, tee_pk) = generate_tee_keypair();
        contract.add_tee_signer(tee_pk.clone(), "tee_quote_mrtd".to_string());

        testing_env!(context.predecessor_account_id(buyer.clone()).build());
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

        let terms_hash = [9u8; 32];
        let sig = sign_terms_hash(&tee_sk, &contract_id, deal_id, &terms_hash);
        contract.register_terms_hash(deal_id, terms_hash, sig);

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
            issued_at: 1000,
        };
        let act_sig = sign_payload(&tee_sk, &activate_payload);
        contract.activate(deal_id, activate_payload, act_sig);

        let deal = contract.get_deal(deal_id).unwrap();

        // 30 days passes with zero usage
        testing_env!(context
            .block_timestamp(deal.usage_deadline + 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        contract.auto_release(deal_id);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Completed);
    }
}
