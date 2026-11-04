#[cfg(test)]
mod tests {
    use crate::crypto::CryptoHelper;
    use crate::types::{
        AdminAction, CreateDealParams, DealStatus, DefaultReason, PayloadKind, SignedPayload,
    };
    use crate::ConpiEscrow;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::{AccountId, NearToken, PublicKey};
    use rand::rngs::OsRng;

    const REAL_CVM_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:c847677bcdbe7d532fa96beabe82cb19e5c7ae44feed9e2c0d941660257d4ed0";
    const OUTDATED_CVM_MEASUREMENT: &str = "mrtd:7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173|compose:outdated_compose_a1f7be33";

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

    fn sign_payload(signing_key: &SigningKey, payload: &SignedPayload) -> Vec<u8> {
        let message = CryptoHelper::serialize_payload(payload);
        signing_key.sign(&message).to_bytes().to_vec()
    }

    // -------------------------------------------------------------------------
    // 1. Initialisation, Pause, and Timelocked Governance
    // -------------------------------------------------------------------------

    #[test]
    fn test_initialization_admin_pause_and_timelocked_governance() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let new_owner: AccountId = "dao.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );
        assert_eq!(contract.get_owner(), owner);
        assert_eq!(contract.get_state_version(), 1);
        assert_eq!(contract.get_timelock_duration(), 300_000_000_000);
        assert!(!contract.is_paused());
        assert_eq!(contract.get_chain_id(), "testnet");

        // Emergency pause: instant
        contract.set_paused(true);
        assert!(contract.is_paused());

        // Instant unpause is strictly forbidden (must go through timelock)
        let unpause_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.set_paused(false);
        }));
        assert!(unpause_res.is_err(), "Instant unpause must be rejected");

        // Propose unpause via timelocked governance
        let unpause_prop = contract.propose_admin_action(AdminAction::Unpause);

        // Immediate execution must fail
        let early_unpause = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(unpause_prop, None);
        }));
        assert!(early_unpause.is_err(), "Early unpause must fail 5min timelock");

        // Advance time past 5 min
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 300_000_000_001)
            .build());
        let _ = contract.execute_admin_action(unpause_prop, None);
        assert!(!contract.is_paused(), "Contract unpaused after timelock elapses");

        // Propose ownership transfer
        let prop_id = contract.propose_admin_action(AdminAction::TransferOwnership {
            new_owner: new_owner.clone(),
        });
        assert_eq!(prop_id, 2);

        // Advance time past 5 min
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 300_000_000_001 * 2)
            .build());

        let _ = contract.execute_admin_action(prop_id, None);
        assert_eq!(contract.get_owner(), new_owner);
    }

    #[test]
    fn test_timelocked_signer_and_config_governance() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);

        // Propose AddTeeSigner
        let prop_add = contract.propose_admin_action(AdminAction::AddTeeSigner {
            public_key: tee_pk.clone(),
            measurement: REAL_CVM_MEASUREMENT.to_string(),
        });

        // Advance 48 hours and execute
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 172_800_000_000_001)
            .build());
        let _ = contract.execute_admin_action(prop_add, None);

        let signer = contract.get_tee_signer(tee_pk.clone()).unwrap();
        assert!(signer.active);
        assert_eq!(signer.measurement, REAL_CVM_MEASUREMENT);

        // Propose RevokeTeeSigner
        let prop_revoke = contract.propose_admin_action(AdminAction::RevokeTeeSigner {
            public_key: tee_pk.clone(),
        });

        // Advance 48 hours and execute
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 172_800_000_000_001 * 2)
            .build());
        let _ = contract.execute_admin_action(prop_revoke, None);

        let signer_revoked = contract.get_tee_signer(tee_pk).unwrap();
        assert!(!signer_revoked.active);
    }

    // -------------------------------------------------------------------------
    // 2. Full Happy Path Delivery
    // -------------------------------------------------------------------------

    #[test]
    fn test_happy_path_full_delivery() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        let price = 60_000_000_000_000_000_000_000_000u128; // 60 NEAR
        let credit_amount = 80_000_000_000_000_000_000_000_000u128; // $80
        let buyer_collateral = 6_000_000_000_000_000_000_000_000u128; // 6 NEAR
        let seller_collateral = 12_000_000_000_000_000_000_000_000u128; // 12 NEAR

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
            slash_bps_buyer_breach: 5000,
        });

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();

        // Seller accepts deal with exact computed terms hash
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.accept_deal(deal_id, terms_hash);

        // Buyer deposits price + collateral (66 NEAR)
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(NearToken::from_yoctonear(price + buyer_collateral))
            .build());
        contract.deposit(deal_id);

        // Seller deposits collateral (12 NEAR)
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(seller_collateral))
            .build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Funded);

        // TEE activates deal
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

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Active);

        // Release 25%, 50%, 75%, 100%
        for (i, stage) in [25, 50, 75, 100].iter().enumerate() {
            let metered = (credit_amount * (*stage as u128)) / 100;
            let payload = SignedPayload {
                domain: "conpi:v1".to_string(),
                contract_id: contract_id.clone(),
                chain_id: "testnet".to_string(),
                deal_id,
                terms_hash,
                kind: PayloadKind::Stage,
                stage: *stage,
                metered_value: U128(metered),
                reason: None,
                nonce: (i as u64) + 2,
                issued_at: 1000 + ((i as u64) + 1) * 1000,
            };
            let sig = sign_payload(&tee_sk, &payload);
            contract.release_stage(deal_id, *stage, payload, sig);
        }

        let completed = contract.get_deal(deal_id).unwrap();
        assert_eq!(completed.status, DealStatus::Completed);
        assert_eq!(completed.released_to_seller, price);
        assert_eq!(completed.stage_reached, 100);
    }

    // -------------------------------------------------------------------------
    // 3. Pilot Deal 2 Reference: 40% Revocation Default
    // -------------------------------------------------------------------------

    #[test]
    fn test_seller_default_revoked_key_at_40_percent() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        let price = 60_000_000u128; // $60.00
        let credit_amount = 80_000_000u128; // $80.00
        let buyer_collateral = 6_000_000u128; // $6.00
        let seller_collateral = 12_000_000u128; // $12.00

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
            slash_bps_revoke: 8000, // 80% slash
            slash_bps_buyer_breach: 5000,
        });

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();

        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.accept_deal(deal_id, terms_hash);

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

        // Release 25% stage ($15.00)
        let stg25_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(20_000_000), // $20 delivered
            reason: None,
            nonce: 2,
            issued_at: 2000,
        };
        let stg25_sig = sign_payload(&tee_sk, &stg25_payload);
        contract.release_stage(deal_id, 25, stg25_payload, stg25_sig);

        let deal_after_stage = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal_after_stage.released_to_seller, 15_000_000);

        // At 40% usage ($32 delivered), seller key is revoked
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: contract_id.clone(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 25,
            metered_value: U128(32_000_000), // $32.00 metered usage
            reason: Some(DefaultReason::InvalidKey),
            nonce: 3,
            issued_at: 3000,
        };
        let def_sig = sign_payload(&tee_sk, &default_payload);
        contract.settle_default(deal_id, default_payload, def_sig);

        let defaulted = contract.get_deal(deal_id).unwrap();
        assert_eq!(defaulted.status, DealStatus::Defaulted);

        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &deal_after_stage,
            32_000_000,
            DefaultReason::InvalidKey,
        );

        assert_eq!(dist.seller_payout, 11_400_000, "Seller receives remaining $9 usage + $2.40 collateral");
        assert_eq!(dist.buyer_refund, 51_600_000, "Buyer receives $36 unused + $6 collateral + $9.60 slashed");
        assert_eq!(dist.slashed_collateral, 9_600_000, "80% of $12 collateral = $9.60");

        // Exact escrow conservation: $11.40 + $51.60 = $63.00 (Total remaining after $15 stage release)
        assert_eq!(dist.seller_payout + dist.buyer_refund, 63_000_000);
        assert_eq!(15_000_000 + dist.seller_payout + dist.buyer_refund, 78_000_000);
    }

    // -------------------------------------------------------------------------
    // 4. Overpayout Prevention Checks (Critical Review Items)
    // -------------------------------------------------------------------------

    #[test]
    fn test_critical_no_overpayout_default_after_stage_50() {
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
            slash_bps_buyer_breach: 5000,
            buyer_deposited: price + buyer_collateral,
            seller_deposited: seller_collateral,
            released_to_seller: 30_000_000, // $30 already released
            stage_reached: 50,
            last_signed: None,
            last_nonce: 3,
            last_tee_seen: 1000,
            status: DealStatus::Active,
            counterparty_accepted: true,
        };

        // Key dies at 40% usage ($32 metered) after $30 was already released
        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &deal,
            32_000_000,
            DefaultReason::InvalidKey,
        );

        let remaining_escrow = 48_000_000u128; // $78 - $30
        assert_eq!(
            dist.seller_payout + dist.buyer_refund,
            remaining_escrow,
            "Total settlement MUST equal exactly remaining escrow of $48.00"
        );
        assert_eq!(30_000_000 + dist.seller_payout + dist.buyer_refund, 78_000_000);
    }

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
            slash_bps_buyer_breach: 5000,
            buyer_deposited: price + buyer_collateral,
            seller_deposited: seller_collateral,
            released_to_seller: 30_000_000,
            stage_reached: 50,
            last_signed: None,
            last_nonce: 5,
            last_tee_seen: 1000,
            status: DealStatus::Active,
            counterparty_accepted: true,
        };

        let checkpoint_metered = 16_000_000u128; // old checkpoint
        let dist = crate::settlement::SettlementCalculator::calculate_timeout_settlement(
            &deal,
            checkpoint_metered,
        );

        let remaining_escrow = 48_000_000u128;
        assert_eq!(dist.seller_payout + dist.buyer_refund, remaining_escrow);
        assert_eq!(30_000_000 + dist.seller_payout + dist.buyer_refund, 78_000_000);
    }

    // -------------------------------------------------------------------------
    // 5. Funded Deal Timeout Refund (Critical Review Item)
    // -------------------------------------------------------------------------

    #[test]
    fn test_critical_funded_deal_key_deadline_timeout_refund() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

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
            slash_bps_buyer_breach: 5000,
        });

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();

        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.accept_deal(deal_id, terms_hash);

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

        // Seller vanishes! Time passes beyond key_deadline
        testing_env!(context
            .block_timestamp(deal.key_deadline + 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        contract.timeout_refund(deal_id);

        let final_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(final_deal.status, DealStatus::Cancelled);
    }

    // -------------------------------------------------------------------------
    // 6. TEE Signer Revocation Protects Live Deals
    // -------------------------------------------------------------------------

    #[test]
    fn test_high_tee_signer_revocation_protects_live_deals() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let contract_id: AccountId = "conpi.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

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
            slash_bps_buyer_breach: 5000,
        });

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();

        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.accept_deal(deal_id, terms_hash);

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

        // Revoke TEE signer key via timelocked governance
        testing_env!(context
            .predecessor_account_id(owner.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let prop_id = contract.propose_admin_action(AdminAction::RevokeTeeSigner {
            public_key: tee_pk.clone(),
        });
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 172_800_000_000_001)
            .build());
        let _ = contract.execute_admin_action(prop_id, None);

        // Compromised TEE tries to emit release_stage
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

        // Verify signer is strictly recorded as revoked
        let signer = contract.get_tee_signer(tee_pk).unwrap();
        assert!(!signer.active, "Signer active flag must be false");
        assert_eq!(signer.measurement, REAL_CVM_MEASUREMENT);

        // Verify deal remains active and safe from unauthorized stage release
        let live_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(live_deal.status, DealStatus::Active);
        assert_eq!(live_deal.stage_reached, 0);
        assert_eq!(live_deal.released_to_seller, 0);
    }

    // -------------------------------------------------------------------------
    // 7. NEP-141 Token Support
    // -------------------------------------------------------------------------

    #[test]
    fn test_nep141_ft_on_transfer() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let usdc_token: AccountId = "usdc.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

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
            slash_bps_buyer_breach: 5000,
        });

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();

        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.accept_deal(deal_id, terms_hash);

        // Buyer transfers NEP-141 token with 5 USDC excess
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

    #[test]
    fn test_ft_on_transfer_paused_refunds_tokens() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let usdc_token: AccountId = "usdc.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        assert!(!contract.is_paused(), "Contract must initially not be paused");

        contract.set_paused(true);
        assert!(contract.is_paused(), "Contract must be paused");

        testing_env!(context
            .predecessor_account_id(usdc_token.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());

        let refund = contract.ft_on_transfer(buyer.clone(), U128(10_000_000), "1".to_string());
        match refund {
            near_sdk::PromiseOrValue::Value(val) => {
                assert_eq!(val.0, 10_000_000, "All tokens must be refunded when contract paused");
            }
            _ => panic!("Expected Value refund"),
        }

        // Verify state is unaltered and no phantom pending payouts exist
        assert_eq!(contract.get_pending_payout(buyer.clone(), Some(usdc_token.clone())).0, 0);
        assert_eq!(contract.next_deal_id, 1);
        assert!(contract.get_deal(1).is_none());
    }

    // -------------------------------------------------------------------------
    // 8. Pull-Claim Recovery & Pause Permissions
    // -------------------------------------------------------------------------

    #[test]
    fn test_failed_transfer_credits_pending_payout_and_claim_pull() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let usdc_token: AccountId = "usdc.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);

        // Initially no pending payouts
        assert_eq!(contract.get_pending_payout(seller.clone(), Some(usdc_token.clone())).0, 0);

        // Simulate failed ft_transfer callback
        testing_env!(context
            .predecessor_account_id("conpi.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let res = contract.on_transfer_resolved(seller.clone(), U128(10_000_000), Some(usdc_token.clone()));
        assert!(!res);

        // Funds credited to pending_payouts
        let pending = contract.get_pending_payout(seller.clone(), Some(usdc_token.clone()));
        assert_eq!(pending.0, 10_000_000);

        // Seller claims pending payout
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let claim_res = contract.claim(Some(usdc_token.clone()));
        match claim_res {
            near_sdk::PromiseOrValue::Promise(_) => {}
            _ => panic!("Expected Promise returned for cross-contract claim"),
        }

        // Cleared from state
        assert_eq!(contract.get_pending_payout(seller.clone(), Some(usdc_token.clone())).0, 0);
    }

    #[test]
    fn test_pause_allows_claim_and_timeout_refund() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

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
            slash_bps_buyer_breach: 5000,
        });

        // Pause contract
        testing_env!(context
            .predecessor_account_id(owner.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        contract.set_paused(true);
        assert!(contract.is_paused());

        // New deal creation is blocked
        testing_env!(context
            .predecessor_account_id(buyer.clone())
            .attached_deposit(STORAGE_DEPOSIT)
            .build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.create_deal(CreateDealParams {
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
                slash_bps_buyer_breach: 5000,
            });
        }));
        assert!(res.is_err(), "create_deal must be blocked while paused");

        // BUT timeout_refund is NOT blocked by pause!
        let deal = contract.get_deal(deal_id).unwrap();
        testing_env!(context
            .block_timestamp(deal.deposit_deadline + 1000)
            .build());
        contract.timeout_refund(deal_id);
        let cancelled = contract.get_deal(deal_id).unwrap();
        assert_eq!(cancelled.status, DealStatus::Cancelled);
    }

    // -------------------------------------------------------------------------
    // 9. Terms Hash Rejection on Mismatch
    // -------------------------------------------------------------------------

    #[test]
    fn test_terms_hash_rejection_on_mismatch() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_tee_sk, tee_pk) = generate_tee_keypair();
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

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
            slash_bps_buyer_breach: 5000,
        });

        // Counterparty calls accept_deal with wrong expected hash
        let bad_hash = [0xEE; 32];
        testing_env!(context
            .predecessor_account_id(seller.clone())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.accept_deal(deal_id, bad_hash);
        }));
        assert!(res.is_err(), "Wrong terms_hash must be rejected");

        // Verify deal state is preserved after rejection
        let deal = contract.get_deal(deal_id).unwrap();
        assert!(!deal.counterparty_accepted, "Counterparty acceptance must remain false");
        assert_eq!(deal.status, DealStatus::Created);

        // Now call accept_deal with the genuine matching terms_hash -> must succeed
        let good_hash = deal.terms_hash.unwrap();
        contract.accept_deal(deal_id, good_hash);

        let accepted_deal = contract.get_deal(deal_id).unwrap();
        assert!(accepted_deal.counterparty_accepted, "Counterparty accepted must now be true");
        assert_eq!(accepted_deal.status, DealStatus::Created);
    }

    // -------------------------------------------------------------------------
    // 10. Dedicated Buyer Breach Rate
    // -------------------------------------------------------------------------

    #[test]
    fn test_buyer_collateral_slashed_with_dedicated_buyer_breach_rate() {
        let price = 60_000_000u128;
        let credit_amount = 80_000_000u128;
        let buyer_collateral = 10_000_000u128;
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
            slash_bps_buyer_breach: 6000, // 60% dedicated breach rate
            buyer_deposited: price + buyer_collateral,
            seller_deposited: seller_collateral,
            released_to_seller: 0,
            stage_reached: 0,
            last_signed: None,
            last_nonce: 1,
            last_tee_seen: 1000,
            status: DealStatus::Active,
            counterparty_accepted: true,
        };

        let dist = crate::settlement::SettlementCalculator::calculate_default_settlement(
            &deal,
            0,
            DefaultReason::BuyerBreach,
        );

        // Buyer collateral ($10) slashed at 60% = $6.00 slashed to seller
        assert_eq!(dist.slashed_collateral, 6_000_000);
        // Seller gets full seller collateral ($12) + slashed buyer collateral ($6) = $18
        assert_eq!(dist.seller_payout, 18_000_000);
        // Buyer gets price refunded ($60) + unslashed buyer collateral ($4) = $64
        assert_eq!(dist.buyer_refund, 64_000_000);
        // Total conserved: $18 + $64 = $82
        assert_eq!(dist.seller_payout + dist.buyer_refund, 82_000_000);
    }

    // -------------------------------------------------------------------------
    // 11. Timelocked Upgrade with Migrate and State Version
    // -------------------------------------------------------------------------

    #[test]
    fn test_timelocked_upgrade_with_migrate() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        assert_eq!(contract.get_state_version(), 1);
        assert_eq!(contract.get_owner(), owner);
        assert_eq!(contract.get_timelock_duration(), 300_000_000_000);

        let mock_code = b"new_wasm_binary_bytes".to_vec();
        let code_hash = near_sdk::env::sha256_array(&mock_code);

        let prop_id = contract.propose_admin_action(AdminAction::Upgrade { code_hash });
        assert_eq!(prop_id, 1);

        let staged = contract.get_staged_proposal(prop_id).expect("Proposal must be staged");
        assert_eq!(staged.action, AdminAction::Upgrade { code_hash });
        assert_eq!(staged.ready_at, 1_000_000_000_000 + 300_000_000_000);

        // Immediate apply must fail due to 5-minute timelock
        let fail_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(prop_id, Some(mock_code.clone()));
        }));
        assert!(fail_res.is_err(), "Upgrade before timelock elapses must fail");

        // Code hash mismatch must also fail even after timelock
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 300_000_000_001)
            .build());
        let bad_code = b"tampered_code".to_vec();
        let bad_hash_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(prop_id, Some(bad_code));
        }));
        assert!(bad_hash_res.is_err(), "Upgrade with mismatched code hash must fail");

        let _prom = contract.execute_admin_action(prop_id, Some(mock_code));
        assert!(contract.get_staged_proposal(prop_id).is_none());
    }

    // -------------------------------------------------------------------------
    // 12. Update Config Bounds
    // -------------------------------------------------------------------------

    #[test]
    fn test_update_config_bounds() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);

        // Zero storage deposit fee must be rejected
        let mut bad_config = contract.get_config();
        bad_config.storage_deposit_fee = 0;
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.propose_admin_action(AdminAction::UpdateConfig { config: bad_config });
        }));
        assert!(res.is_err(), "Zero storage deposit fee must be rejected");

        // Zero min_slash_bps must be rejected
        let mut bad_slash_config = contract.get_config();
        bad_slash_config.min_slash_bps = 0;
        let res2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.propose_admin_action(AdminAction::UpdateConfig { config: bad_slash_config });
        }));
        assert!(res2.is_err(), "Zero min_slash_bps must be rejected");

        // max_slash_bps > 10_000 must be rejected
        let mut bad_max_slash = contract.get_config();
        bad_max_slash.max_slash_bps = 10_001;
        let res3 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.propose_admin_action(AdminAction::UpdateConfig { config: bad_max_slash });
        }));
        assert!(res3.is_err(), "max_slash_bps > 10_000 must be rejected");

        // min_slash_bps > max_slash_bps must be rejected
        let mut inverted_slash = contract.get_config();
        inverted_slash.min_slash_bps = 5_000;
        inverted_slash.max_slash_bps = 4_000;
        let res4 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.propose_admin_action(AdminAction::UpdateConfig { config: inverted_slash });
        }));
        assert!(res4.is_err(), "min_slash_bps > max_slash_bps must be rejected");

        // Valid updated config is accepted and staged with exact 48h delay
        let mut valid_config = contract.get_config();
        valid_config.min_slash_bps = 2_000;
        valid_config.notice_period_duration = 172_800_000_000_000;
        let prop_id = contract.propose_admin_action(AdminAction::UpdateConfig { config: valid_config.clone() });
        let staged = contract.get_staged_proposal(prop_id).expect("Valid config proposal must be staged");
        assert_eq!(staged.action, AdminAction::UpdateConfig { config: valid_config });
        assert_eq!(staged.ready_at, 1_000_000_000_000 + 300_000_000_000);
    }

    // -------------------------------------------------------------------------
    // 13. Enforce 5-Minute Minimum Timelock Duration
    // -------------------------------------------------------------------------

    #[test]
    fn test_timelock_duration_enforces_5min_minimum() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        // Sub-5min timelock values must be strictly rejected
        let invalid_durations = [0u64, 1_000_000_000, 30_000_000_000, 299_999_999_999];
        for dur in invalid_durations {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ConpiEscrow::new(owner.clone(), None, None, None, Some(dur));
            }));
            assert!(
                res.is_err(),
                "Initialization with timelock {} ns (< 5min) must fail",
                dur
            );
        }

        // None defaults to 5 minutes (300,000,000,000 ns)
        let default_contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        assert_eq!(
            default_contract.get_timelock_duration(),
            300_000_000_000,
            "Default timelock must be exactly 5min"
        );

        // Exactly 5 minutes is accepted
        let exact_5min = ConpiEscrow::new(owner.clone(), None, None, None, Some(300_000_000_000));
        assert_eq!(
            exact_5min.get_timelock_duration(),
            300_000_000_000,
            "5min timelock must be accepted"
        );

        // > 5 minutes (e.g. 48 hours) is accepted
        let custom_48h = ConpiEscrow::new(owner.clone(), None, None, None, Some(172_800_000_000_000));
        assert_eq!(
            custom_48h.get_timelock_duration(),
            172_800_000_000_000,
            "48h timelock must be accepted"
        );
    }

    #[test]
    fn test_update_timelock_via_governance() {
        let owner: AccountId = "owner.near".parse().unwrap();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        context.block_timestamp(1_000_000_000_000);
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, Some(300_000_000_000));
        assert_eq!(contract.get_timelock_duration(), 300_000_000_000);

        // Propose changing timelock to 48 hours (172_800_000_000_000 ns)
        let new_timelock = 172_800_000_000_000u64;
        let proposal_id = contract.propose_admin_action(AdminAction::UpdateTimelock {
            timelock_duration: new_timelock,
        });

        // Attempting to execute immediately before timelock passes must fail
        let early_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(proposal_id, None);
        }));
        assert!(early_res.is_err(), "Early execution before timelock must fail");

        // Advance past timelock (5 minutes = 300_000_000_000 ns)
        context.block_timestamp(1_000_000_000_000 + 300_000_000_001);
        testing_env!(context.build());

        // Execute admin action
        let res = contract.execute_admin_action(proposal_id, None);
        match res {
            near_sdk::PromiseOrValue::Value(v) => assert!(v, "Execution should succeed"),
            _ => panic!("Expected value result"),
        }

        // Verify updated timelock duration is now 48h
        assert_eq!(contract.get_timelock_duration(), new_timelock);
    }

    // -------------------------------------------------------------------------
    // 14. Multisig Owner Governance Cycle with UpdateConfig (Owner Retained)
    // -------------------------------------------------------------------------

    #[test]
    fn test_multisig_governance_cycle_with_update_config_retains_owner() {
        let multisig_dao: AccountId = "multisig-dao.testnet".parse().unwrap();
        let rogue: AccountId = "rogue.testnet".parse().unwrap();
        let mut context = get_context(multisig_dao.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(multisig_dao.clone(), None, None, None, None);
        assert_eq!(contract.get_owner(), multisig_dao);

        // Multisig proposes UpdateConfig
        let mut new_config = contract.get_config();
        new_config.notice_period_duration = 172_800_000_000_000; // 48h notice
        new_config.min_slash_bps = 2_000;                       // 20%
        let prop_id = contract.propose_admin_action(AdminAction::UpdateConfig {
            config: new_config.clone(),
        });
        assert_eq!(prop_id, 1);

        // Immediate execution before 5min timelock fails
        let early_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(prop_id, None);
        }));
        assert!(early_res.is_err(), "Execution before 5min timelock must fail");

        // Execution by non-owner fails
        testing_env!(context.predecessor_account_id(rogue).build());
        let rogue_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.execute_admin_action(prop_id, None);
        }));
        assert!(rogue_res.is_err(), "Execution by non-multisig must fail");

        // Advance timestamp past 5min timelock
        testing_env!(context
            .predecessor_account_id(multisig_dao.clone())
            .block_timestamp(1_000_000_000_000 + 300_000_000_001)
            .build());

        // Execute UpdateConfig proposal
        let exec_res = contract.execute_admin_action(prop_id, None);
        match exec_res {
            near_sdk::PromiseOrValue::Value(success) => assert!(success),
            _ => panic!("Expected Value(true) for UpdateConfig"),
        }

        // CRITICAL: Multisig MUST remain the escrow owner!
        assert_eq!(
            contract.get_owner(),
            multisig_dao,
            "Escrow owner MUST remain the Multisig DAO contract"
        );

        // Config was updated
        assert_eq!(contract.get_config(), new_config);
        assert_eq!(contract.get_config().min_slash_bps, 2_000);
        assert_eq!(contract.get_config().notice_period_duration, 172_800_000_000_000);

        // Proposal consumed
        assert!(contract.get_staged_proposal(prop_id).is_none());
    }

    // -------------------------------------------------------------------------
    // 15. Versioned State Migration with ConpiEscrowV1
    // -------------------------------------------------------------------------

    #[test]
    fn test_versioned_state_migration_with_conpi_escrow_v1() {
        let owner: AccountId = "dao.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_sk, tee_pk) = generate_tee_keypair();
        let mut tee_signers = near_sdk::collections::UnorderedMap::new(b"t");
        tee_signers.insert(
            &tee_pk,
            &crate::types::TeeSigner {
                measurement: REAL_CVM_MEASUREMENT.to_string(),
                registered_at: 1_000_000_000_000,
                active: true,
            },
        );

        let v1 = crate::ConpiEscrowV1 {
            owner: owner.clone(),
            chain_id: "testnet".to_string(),
            paused: false,
            tee_signers,
            deals: near_sdk::collections::LookupMap::new(b"d"),
            deal_creators: near_sdk::collections::LookupMap::new(b"c"),
            pending_payouts: near_sdk::collections::LookupMap::new(b"p"),
            next_deal_id: 1,
            config: crate::types::Config::default(),
            next_proposal_id: 1,
            staged_proposals: near_sdk::collections::UnorderedMap::new(b"s"),
            timelock_duration: 300_000_000_000,
            state_version: 1,
        };

        // Write contract state to simulate pre-upgrade on-chain state
        near_sdk::env::state_write(&v1);

        // Execute migration reading versioned ConpiEscrowV1
        let migrated = ConpiEscrow::migrate();

        // State version incremented to 2
        assert_eq!(migrated.get_state_version(), 2);
        // Owner and timelock duration preserved perfectly
        assert_eq!(migrated.get_owner(), owner);
        assert_eq!(migrated.get_timelock_duration(), 300_000_000_000);
        assert!(!migrated.is_paused());
        assert_eq!(migrated.get_chain_id(), "testnet");
        assert_eq!(
            migrated.get_approved_measurement(),
            Some(REAL_CVM_MEASUREMENT.to_string())
        );
    }

    #[test]
    fn test_versioned_state_migration_with_conpi_escrow_v2() {
        let owner: AccountId = "dao.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let (_sk, tee_pk) = generate_tee_keypair();
        let mut tee_signers = near_sdk::collections::UnorderedMap::new(b"t");
        tee_signers.insert(
            &tee_pk,
            &crate::types::TeeSigner {
                measurement: REAL_CVM_MEASUREMENT.to_string(),
                registered_at: 1_000_000_000_000,
                active: true,
            },
        );

        let v2 = crate::ConpiEscrowV2 {
            owner: owner.clone(),
            chain_id: "testnet".to_string(),
            paused: false,
            tee_signers,
            deals: near_sdk::collections::LookupMap::new(b"d"),
            deal_creators: near_sdk::collections::LookupMap::new(b"c"),
            pending_payouts: near_sdk::collections::LookupMap::new(b"p"),
            next_deal_id: 1,
            config: crate::types::Config::default(),
            next_proposal_id: 1,
            staged_proposals: near_sdk::collections::UnorderedMap::new(b"s"),
            timelock_duration: 300_000_000_000,
            state_version: 4,
            approved_measurement: Some(REAL_CVM_MEASUREMENT.to_string()),
        };

        near_sdk::env::state_write(&v2);

        let migrated = ConpiEscrow::migrate();
        assert_eq!(migrated.get_state_version(), 5);
        assert_eq!(migrated.get_owner(), owner);
        assert_eq!(
            migrated.get_approved_measurement(),
            Some(REAL_CVM_MEASUREMENT.to_string())
        );
        assert_eq!(migrated.staged_upgrade_code, None);
    }

    #[test]
    #[should_panic(expected = "Measurement cannot be empty")]
    fn test_propose_add_tee_signer_rejects_empty_measurement() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner, None, None, None, None);
        contract.propose_admin_action(AdminAction::AddTeeSigner {
            public_key: tee_pk,
            measurement: "".to_string(),
        });
    }

    #[test]
    #[should_panic(expected = "TEE signer measurement cannot be empty")]
    fn test_active_tee_signer_with_empty_measurement_rejected_on_deal_creation() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner,
            None,
            None,
            Some((tee_pk.clone(), "".to_string())),
            None,
        );

        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let context = get_context(buyer.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let params = CreateDealParams {
            buyer,
            seller,
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_revoke: 8000,
            slash_bps_provider_ban: 5000,
            slash_bps_buyer_breach: 5000,
        };

        contract.create_deal(params);
    }

    #[test]
    #[should_panic(expected = "TEE signer measurement does not match approved live CVM measurement")]
    fn test_active_tee_signer_with_mismatched_measurement_rejected_on_deal_creation() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner,
            None,
            None,
            Some((tee_pk.clone(), OUTDATED_CVM_MEASUREMENT.to_string())),
            None,
        );
        // DAO updates approved measurement to the real live CVM measurement
        contract.approved_measurement = Some(REAL_CVM_MEASUREMENT.to_string());

        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let context = get_context(buyer.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let params = CreateDealParams {
            buyer,
            seller,
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_revoke: 8000,
            slash_bps_provider_ban: 5000,
            slash_bps_buyer_breach: 5000,
        };

        contract.create_deal(params);
    }

    #[test]
    fn test_dao_registration_updates_approved_measurement() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        assert_eq!(contract.get_approved_measurement(), None);

        // Stage proposal to add TEE signer with real CVM measurement
        let prop_id = contract.propose_admin_action(AdminAction::AddTeeSigner {
            public_key: tee_pk.clone(),
            measurement: REAL_CVM_MEASUREMENT.to_string(),
        });
        assert_eq!(prop_id, 1);

        // Fast forward past timelock
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 301_000_000_000)
            .build());

        let _ = contract.execute_admin_action(prop_id, None);
        assert_eq!(
            contract.get_approved_measurement(),
            Some(REAL_CVM_MEASUREMENT.to_string())
        );

        let signer = contract.get_tee_signer(tee_pk).expect("signer registered");
        assert_eq!(signer.measurement, REAL_CVM_MEASUREMENT);
        assert!(signer.active);
    }

    #[test]
    fn test_active_tee_signer_with_valid_live_measurement_accepted() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner,
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let context = get_context(buyer.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let params = CreateDealParams {
            buyer,
            seller,
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_revoke: 8000,
            slash_bps_provider_ban: 5000,
            slash_bps_buyer_breach: 5000,
        };

        let deal_id = contract.create_deal(params);
        assert_eq!(deal_id, 1);
    }

    #[test]
    #[should_panic(expected = "Approved CVM measurement is not set")]
    fn test_assert_active_tee_signer_fails_when_approved_measurement_is_none() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let (_sk, tee_pk) = generate_tee_keypair();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner,
            None,
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );
        contract.approved_measurement = None;

        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let context = get_context(buyer.clone(), NearToken::from_yoctonear(50_000_000_000_000_000_000_000));
        testing_env!(context.build());

        let params = CreateDealParams {
            buyer,
            seller,
            token: None,
            price: U128(100),
            credit_amount: U128(100),
            buyer_collateral: U128(10),
            seller_collateral: U128(20),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_revoke: 8000,
            slash_bps_provider_ban: 5000,
            slash_bps_buyer_breach: 5000,
        };

        contract.create_deal(params);
    }

    #[test]
    fn test_direct_dao_upgrade_via_staged_code_without_transfer() {
        let owner: AccountId = "dao.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        let dummy_code = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let code_hash = near_sdk::env::sha256_array(&dummy_code);

        // 1. DAO stages Upgrade proposal
        let prop_id = contract.propose_admin_action(AdminAction::Upgrade { code_hash });

        // 2. Someone stages matching upgrade bytecode
        contract.stage_upgrade_code(dummy_code.clone());
        assert!(contract.has_staged_upgrade_code());

        // 3. Timelock matures
        testing_env!(context
            .block_timestamp(1_000_000_000_000 + 301_000_000_000)
            .build());

        // 4. DAO executes proposal passing None for code (zero bytes in transaction call!)
        let _ = contract.execute_admin_action(prop_id, None);
        assert!(!contract.has_staged_upgrade_code());
        assert_eq!(contract.get_owner(), owner);
    }
}

