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

    fn register_foreign_chain_deal_as_seller(
        contract: &mut ConpiEscrow,
        deal_id: u64,
        chain_id: u64,
        vault_address: String,
        token_address: String,
        buyer_address: String,
        seller_address: String,
        foreign_amount: U128,
    ) {
        let seller = contract.get_deal(deal_id).expect("deal exists").seller;
        testing_env!(get_context(seller, NearToken::from_yoctonear(0)).build());
        contract.register_foreign_chain_deal(
            deal_id,
            chain_id,
            vault_address,
            token_address,
            buyer_address,
            seller_address,
            foreign_amount,
        );
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
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1000,
        };
        let act_sig = sign_payload(&tee_sk, &act_payload);
        contract.activate(deal_id, act_payload, act_sig);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Active);

        // Release 25%, 50%, 75%, 100%, with a signed checkpoint between
        // milestones to prove the offline fallback state is persisted.
        let mut nonce = 2u64;
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
                foreign_tx_sighash: None,
                nonce,
                issued_at: 1000 + ((i as u64) + 1) * 1000,
            };
            let sig = sign_payload(&tee_sk, &payload);
            contract.release_stage(deal_id, *stage, payload, sig);
            nonce += 1;

            if *stage == 25 {
                let checkpoint_payload = SignedPayload {
                    domain: "conpi:v1".to_string(),
                    contract_id: contract_id.clone(),
                    chain_id: "testnet".to_string(),
                    deal_id,
                    terms_hash,
                    kind: PayloadKind::Checkpoint,
                    stage: 30,
                    metered_value: U128((credit_amount * 30) / 100),
                    reason: None,
                    foreign_tx_sighash: None,
                    nonce,
                    issued_at: 2500,
                };
                let checkpoint_sig = sign_payload(&tee_sk, &checkpoint_payload);
                contract.checkpoint(deal_id, checkpoint_payload, checkpoint_sig);
                nonce += 1;

                let checkpointed = contract.get_deal(deal_id).unwrap();
                assert_eq!(checkpointed.last_signed.unwrap().metered_value.0, (credit_amount * 30) / 100);
            }
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
            foreign_tx_sighash: None,
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
            foreign_tx_sighash: None,
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
            foreign_tx_sighash: None,
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
            foreign_tx_sighash: None,
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
            foreign_tx_sighash: None,
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
            staged_upgrade_code: None,
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
    fn test_migrate_with_real_live_testnet_state() {
        let b64 = "KQAAAGRldi0yMDI2MTEwMzAyMTc0MC01OTcxMTkzMzU4MTM3Ni50ZXN0bmV0BwAAAHRlc3RuZXQAAgAAAHRpAwAAAAAAAAACAAAAdGsDAAAAAAAAAAIAAAB0dgEAAABkAQAAAGMBAAAAcDIAAAAAAAAAALhk2UUAAAAAACn5DyYCAACguDBGAwAAAABCB2k1CQAAAE+RlE4AANAHECcAAEB7pfBjgZYKAAAAAAAAJgAAAAAAAAACAAAAc2kAAAAAAAAAAAIAAABzawAAAAAAAAAAAgAAAHN2ALhk2UUAAAAIAAAAAa4AAABtcnRkOjdmZTYwNzg3MjIyYmQzOTRjYjUxNmFiY2EyNDM1ZjIyZjAzNWFiMmNjOWMwYTRiNGIzYjE0OGU0NjI5N2YzZDkzMWEyMzdiNzJmMzU5MDUyYzZlNjU3ZDhjMTQwOTE3M3xjb21wb3NlOjNjMDgyMzAzNGMyNWFmMTAxOGQ1OGJiMmQ1OTE3Y2U0ODM0Zjk4ZDk1NWQ4YTkwMWM4MWUyNDdjNWIxNjNkYWQA";
        let bytes = near_sdk::base64::decode(b64).unwrap();
        near_sdk::env::storage_write(b"STATE", &bytes);

        let migrated = ConpiEscrow::migrate();
        assert_eq!(migrated.get_owner().to_string(), "dev-20261103021740-59711933581376.testnet");
        assert_eq!(migrated.get_state_version(), 9);
        assert_eq!(migrated.next_deal_id, 50);
        assert!(migrated.approved_measurement.is_some());
    }

    #[test]
    fn test_real_cvm_deal_49_activate_signature_verification() {
        let terms_hash_hex = "f935eee489ef58652ef04760a8148ff435fce6e7896fd5c753615c19ed7b657f";
        let mut terms_hash = [0u8; 32];
        hex::decode_to_slice(terms_hash_hex, &mut terms_hash).unwrap();

        let sig_hex = "c8568dfb43a414340b487a32b79c39b57f742e4681fc0da28f05a6226b2afdefd8d137c83d61cc45b10374e149918a27d9bf4e949c259585b7c499c827597b06";
        let sig_bytes = hex::decode(sig_hex).unwrap();

        let payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "dev-20261103062448-30583839049419.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id: 49,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            nonce: 3,
            issued_at: 1794188904092000000,
            foreign_tx_sighash: None,
        };

        let tee_pk: PublicKey = "ed25519:CLHhDLsLCCqFeTjz7g31NkfbtN1UqT2mJRmRZgcRPTj3".parse().unwrap();

        let deal = crate::types::Deal {
            id: 49,
            buyer: "looseward2086.testnet".parse().unwrap(),
            seller: "wrongemail508.testnet".parse().unwrap(),
            token: None,
            price: 11111111111000000000000,
            credit_amount: 13888888889000000000000,
            buyer_collateral: 0,
            seller_collateral: 2222222222000000000000,
            terms_hash: Some(terms_hash),
            tee_pubkey: tee_pk.clone(),
            deposit_deadline: 1794275226847908573,
            key_deadline: 1794275226847908573,
            usage_deadline: 0,
            notice_deadline: None,
            tee_liveness_timeout: 3600000000000,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 5000,
            buyer_deposited: 11111111111000000000000,
            seller_deposited: 2222222222000000000000,
            released_to_seller: 0,
            stage_reached: 0,
            last_signed: None,
            last_nonce: 0,
            last_tee_seen: 1794160947808114083,
            status: DealStatus::Funded,
            counterparty_accepted: true,
        };

        let mut builder = get_context("wrongemail508.testnet".parse().unwrap(), NearToken::from_yoctonear(0));
        builder.block_timestamp(1794188904092000000 + 1000);
        testing_env!(builder.build());

        let contract_id: AccountId = "dev-20261103062448-30583839049419.testnet".parse().unwrap();

        CryptoHelper::verify_signed_payload(
            &payload,
            &sig_bytes,
            &tee_pk,
            &deal,
            &contract_id,
            "testnet",
            PayloadKind::Activate,
        );
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

    #[test]
    fn test_cancel_admin_action_clears_staged_upgrade_code() {
        let owner: AccountId = "dao.testnet".parse().unwrap();
        let context = get_context(owner.clone(), NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(owner.clone(), None, None, None, None);
        let dummy_code = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let code_hash = near_sdk::env::sha256_array(&dummy_code);

        // 1. Propose upgrade
        let prop_id = contract.propose_admin_action(AdminAction::Upgrade { code_hash });

        // 2. Stage code
        contract.stage_upgrade_code(dummy_code.clone());
        assert!(contract.has_staged_upgrade_code());

        // 3. Cancel proposal
        contract.cancel_admin_action(prop_id);

        // 4. Staged upgrade code must be cleared
        assert!(!contract.has_staged_upgrade_code());
    }

    #[test]
    fn test_foreign_chain_deal_registration_and_deposit() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let context = get_context(owner.clone(), STORAGE_DEPOSIT);
        testing_env!(context.build());

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        // 1. Create deal as buyer
        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000), // 1 NEAR
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        // 2. Register foreign chain info (Base Sepolia)
        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_custom_addr = "0x3333333333333333333333333333333333333333".to_string();
        let foreign_amount = U128(5_000_000); // 5 USDC

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_custom_addr.clone(),
            foreign_amount,
        );

        let info = contract.get_foreign_deal(deal_id).expect("Foreign info exists");
        assert_eq!(info.chain_id, 84532);
        assert_eq!(info.vault_address, vault_addr);
        assert_eq!(info.evm_nonce, 0);

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        // 3. Record Foreign Deposit verified by TEE
        let payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let sig = sign_payload(&signing_key, &payload);

        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, payload, sig);

        let deal = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal.buyer_deposited, deal.price + deal.buyer_collateral);
    }

    #[test]
    fn test_foreign_chain_release_stage_and_mpc_signing() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        // 1. Create deal as buyer
        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        // 2. Register foreign chain info (Base Sepolia)
        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_addr = "0x2222222222222222222222222222222222222222".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_addr.clone(),
            foreign_amount,
        );

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        // 3. Seller accepts deal & deposits seller collateral
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        // 4. Record foreign deposit
        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let deposit_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let deposit_sig = sign_payload(&signing_key, &deposit_payload);
        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, deposit_payload, deposit_sig);

        let deal = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal.status, DealStatus::Funded);

        // 5. Activate deal via TEE
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 1_000_000_000_000,
        };
        let activate_sig = sign_payload(&signing_key, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        let deal = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal.status, DealStatus::Active);

        // 6. Release Stage 25 with Foreign EVM Tx
        let foreign_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: seller_addr.clone(),
            amount: U128(1_250_000), // 25% of 5 USDC
            sighash: [0x55u8; 32],
        };
        let stage_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(250_000_000_000_000_000_000_000),
            reason: None,
            foreign_tx_sighash: Some([0x55u8; 32]),
            nonce: 3,
            issued_at: 1_000_000_000_000,
        };
        let stage_sig = sign_payload(&signing_key, &stage_payload);
        let _ = contract.release_stage_foreign(deal_id, 25, stage_payload, stage_sig, foreign_tx);

        let deal_after = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal_after.stage_reached, 25);
        assert_eq!(deal_after.released_to_seller, 250_000_000_000_000_000_000_000);

        let foreign_after = contract.get_foreign_deal(deal_id).expect("foreign exists");
        assert_eq!(foreign_after.evm_nonce, 1);

        // 7. Verify MPC Callback
        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        let mpc_sig = crate::types::SignatureResponse {
            scheme: "secp256k1".to_string(),
            big_r: crate::types::AffinePoint {
                affine_point: "021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef".to_string(),
            },
            s: crate::types::Scalar {
                scalar: "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321".to_string(),
            },
            recovery_id: 0,
        };
        let cb_ok = contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Stage { stage: 25 },
            [0x55u8; 32],
            seller_addr.clone(),
            U128(1_250_000),
            0,
            0,
            DealStatus::Active,
            0,
            Ok(mpc_sig),
        );
        assert!(cb_ok);
    }

    #[test]
    fn test_foreign_chain_settle_default_and_mpc_signing() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_addr = "0x2222222222222222222222222222222222222222".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_addr.clone(),
            foreign_amount,
        );

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let deposit_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let deposit_sig = sign_payload(&signing_key, &deposit_payload);
        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, deposit_payload, deposit_sig);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 1_000_000_000_000,
        };
        let activate_sig = sign_payload(&signing_key, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        // Settle default foreign: InvalidKey with 40% delivered
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 0,
            metered_value: U128(400_000_000_000_000_000_000_000), // 40%
            reason: Some(DefaultReason::InvalidKey),
            foreign_tx_sighash: Some([0x77u8; 32]),
            nonce: 3,
            issued_at: 1_000_000_000_000,
        };
        let default_sig = sign_payload(&signing_key, &default_payload);

        let foreign_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: buyer_addr.clone(),
            amount: U128(3_000_000), // 60% refund of 5 USDC
            sighash: [0x77u8; 32],
        };

        let _ = contract.settle_default_foreign(deal_id, default_payload, default_sig, foreign_tx);

        let deal_after = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal_after.status, DealStatus::Defaulted);

        let foreign_after = contract.get_foreign_deal(deal_id).expect("foreign exists");
        assert_eq!(foreign_after.evm_nonce, 1);
    }

    #[test]
    fn test_foreign_chain_timeout_refund() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_addr = "0x2222222222222222222222222222222222222222".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_addr.clone(),
            foreign_amount,
        );

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let deposit_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let deposit_sig = sign_payload(&signing_key, &deposit_payload);
        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, deposit_payload, deposit_sig);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 1_000_000_000_000,
        };
        let activate_sig = sign_payload(&signing_key, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        // Fast-forward past liveness timeout
        testing_env!(get_context(buyer.clone(), NearToken::from_yoctonear(0))
            .block_timestamp(1_000_000_000_000 + 3_600_000_000_001)
            .build());

        let expected_sighash = crate::eip1559::Eip1559Helper::compute_standard_erc20_transfer_sighash(
            84532,
            0,
            &token_addr,
            &buyer_addr,
            5_000_000,
        );
        let foreign_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: buyer_addr.clone(),
            amount: U128(5_000_000), // 100% refund of 5 USDC
            sighash: expected_sighash,
        };

        let _ = contract.timeout_refund_foreign(deal_id, foreign_tx);

        let deal_after = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal_after.status, DealStatus::SettledTimeout);

        let foreign_after = contract.get_foreign_deal(deal_id).expect("foreign exists");
        assert_eq!(foreign_after.evm_nonce, 1);
    }

    #[test]
    fn test_foreign_chain_mpc_rollback_on_failure() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_addr = "0x2222222222222222222222222222222222222222".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_addr.clone(),
            foreign_amount,
        );

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let deposit_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let deposit_sig = sign_payload(&signing_key, &deposit_payload);
        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, deposit_payload, deposit_sig);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 1_000_000_000_000,
        };
        let activate_sig = sign_payload(&signing_key, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        // Release stage 25
        let foreign_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: seller_addr.clone(),
            amount: U128(1_250_000),
            sighash: [0x55u8; 32],
        };
        let stage_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Stage,
            stage: 25,
            metered_value: U128(250_000_000_000_000_000_000_000),
            reason: None,
            foreign_tx_sighash: Some([0x55u8; 32]),
            nonce: 3,
            issued_at: 1_000_000_000_000,
        };
        let stage_sig = sign_payload(&signing_key, &stage_payload);
        let _ = contract.release_stage_foreign(deal_id, 25, stage_payload, stage_sig, foreign_tx);

        // State was tentatively advanced
        let deal_tentative = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal_tentative.stage_reached, 25);
        let foreign_tentative = contract.get_foreign_deal(deal_id).expect("foreign exists");
        assert_eq!(foreign_tentative.evm_nonce, 1);

        // Now simulate MPC signature failure callback from NEAR MPC
        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        let cb_res = contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Stage { stage: 25 },
            [0x55u8; 32],
            seller_addr.clone(),
            U128(1_250_000),
            0, // prev_stage
            0, // prev_released
            DealStatus::Active, // prev_status
            0, // prev_evm_nonce
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!cb_res, "Callback should return false on error");

        // Assert state is ROLLBACK to previous clean state!
        let deal_reverted = contract.get_deal(deal_id).expect("deal exists");
        assert_eq!(deal_reverted.stage_reached, 0, "Stage must be rolled back to 0");
        assert_eq!(deal_reverted.released_to_seller, 0, "Released must be rolled back to 0");
        assert_eq!(deal_reverted.status, DealStatus::Active, "Status must remain Active");

        let foreign_reverted = contract.get_foreign_deal(deal_id).expect("foreign exists");
        assert_eq!(foreign_reverted.evm_nonce, 0, "EVM nonce must be rolled back to 0");
    }

    #[test]
    #[should_panic(expected = "Foreign deals must use timeout_refund_foreign")]
    fn test_native_timeout_refund_rejects_foreign_deal() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string(),
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string(),
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            U128(5_000_000),
        );

        testing_env!(get_context(buyer.clone(), NearToken::from_yoctonear(0))
            .block_timestamp(1_000_000_000_000 + 3_600_000_000_001)
            .build());

        // Calling native timeout_refund must panic and protect treasury!
        contract.timeout_refund(deal_id);
    }

    #[test]
    fn test_claim_seller_foreign_payout_and_seller_address_setting() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_custom_addr = "0x3333333333333333333333333333333333333333".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_custom_addr.clone(),
            foreign_amount,
        );

        // Seller payout address is fixed when the foreign deal is registered.
        let info = contract.get_foreign_deal(deal_id).unwrap();
        assert_eq!(info.seller_address, seller_custom_addr);

        let deal = contract.get_deal(deal_id).expect("deal exists");
        let terms_hash = deal.terms_hash.expect("terms hash exists");

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let deposit_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1_000_000_000_000,
        };
        let deposit_sig = sign_payload(&signing_key, &deposit_payload);
        let tx_hash = "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392".to_string();
        contract.record_foreign_deposit(deal_id, tx_hash, deposit_payload, deposit_sig);

        // Activate
        let activate_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 1_000_000_000_000,
        };
        let activate_sig = sign_payload(&signing_key, &activate_payload);
        contract.activate(deal_id, activate_payload, activate_sig);

        // Default occurs after 40% delivery ($2 USDC earned by seller, $3 refund to buyer)
        let default_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 0,
            metered_value: U128(400_000_000_000_000_000_000_000), // 40%
            reason: Some(DefaultReason::InvalidKey),
            foreign_tx_sighash: Some([0x77u8; 32]),
            nonce: 3,
            issued_at: 1_000_000_000_000,
        };
        let default_sig = sign_payload(&signing_key, &default_payload);

        let buyer_refund_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: buyer_addr.clone(),
            amount: U128(3_000_000), // 60% refund of 5 USDC
            sighash: [0x77u8; 32],
        };
        let _ = contract.settle_default_foreign(deal_id, default_payload, default_sig, buyer_refund_tx);

        // Seller claims their remaining earned $2 USDC (40% of 5 USDC = 2_000_000)
        let expected_seller_sighash = crate::eip1559::Eip1559Helper::compute_standard_erc20_transfer_sighash(
            84532,
            1, // EVM nonce is now 1
            &token_addr,
            &seller_custom_addr,
            2_000_000,
        );
        let seller_claim_tx = crate::types::ForeignTxRequest {
            nonce: 1,
            recipient: seller_custom_addr.clone(),
            amount: U128(2_000_000),
            sighash: expected_seller_sighash,
        };

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0)).build());
        let _ = contract.claim_seller_foreign_payout(deal_id, seller_claim_tx.clone());

        let foreign_after = contract.get_foreign_deal(deal_id).unwrap();
        assert_eq!(foreign_after.evm_nonce, 2);

        // Execute successful MPC callback for SellerClaim
        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        let mpc_sig = crate::types::SignatureResponse {
            scheme: "ecdsa".to_string(),
            big_r: crate::types::AffinePoint { affine_point: "02".to_string() + &"11".repeat(32) },
            s: crate::types::Scalar { scalar: "22".repeat(32) },
            recovery_id: 0,
        };
        contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::SellerClaim,
            expected_seller_sighash,
            seller_custom_addr.clone(),
            U128(2_000_000),
            0,
            0,
            DealStatus::Defaulted,
            1,
            Ok(mpc_sig),
        );

        let foreign_claimed = contract.get_foreign_deal(deal_id).unwrap();
        assert!(foreign_claimed.seller_claimed, "seller_claimed must be true");

        // Subsequent claim attempt MUST be rejected to prevent draining the vault!
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0)).build());
        let seller_claim_tx2 = crate::types::ForeignTxRequest {
            nonce: 2,
            recipient: seller_custom_addr.clone(),
            amount: U128(2_000_000),
            sighash: [0x88u8; 32],
        };
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.claim_seller_foreign_payout(deal_id, seller_claim_tx2);
        }));
        assert!(res.is_err(), "Repeated seller claim MUST panic to prevent vault drain");
    }

    #[test]
    fn test_foreign_default_deferred_collateral_payout_and_rollback() {
        let (signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000_000_000_000_000_000_000_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(200_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let vault_addr = "0x0aA750e83Dae45e4bA17EbAd07A2Fb800988155f".to_string();
        let token_addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string();
        let buyer_addr = "0x1111111111111111111111111111111111111111".to_string();
        let seller_addr = "0x2222222222222222222222222222222222222222".to_string();
        let foreign_amount = U128(5_000_000);

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            vault_addr.clone(),
            token_addr.clone(),
            buyer_addr.clone(),
            seller_addr.clone(),
            foreign_amount,
        );

        let deal = contract.get_deal(deal_id).unwrap();
        let terms_hash = deal.terms_hash.unwrap();
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(200_000_000_000_000_000_000_000)).build());
        contract.accept_deal(deal_id, terms_hash);
        contract.deposit(deal_id);

        testing_env!(get_context(owner.clone(), NearToken::from_yoctonear(0)).build());
        let dep_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::ForeignDeposit,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 1,
            issued_at: 1000,
        };
        let dep_sig = sign_payload(&signing_key, &dep_payload);
        contract.record_foreign_deposit(deal_id, "0x123".to_string(), dep_payload, dep_sig);

        let act_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Activate,
            stage: 0,
            metered_value: U128(0),
            reason: None,
            foreign_tx_sighash: None,
            nonce: 2,
            issued_at: 2000,
        };
        let act_sig = sign_payload(&signing_key, &act_payload);
        contract.activate(deal_id, act_payload, act_sig);

        // Deal is Active with 200_000... yoctoNEAR collateral from seller
        let def_payload = SignedPayload {
            domain: "conpi:v1".to_string(),
            contract_id: "conpi.testnet".parse().unwrap(),
            chain_id: "testnet".to_string(),
            deal_id,
            terms_hash,
            kind: PayloadKind::Default,
            stage: 0,
            metered_value: U128(0),
            reason: Some(DefaultReason::InvalidKey),
            foreign_tx_sighash: Some([0xaa; 32]),
            nonce: 3,
            issued_at: 3000,
        };
        let def_sig = sign_payload(&signing_key, &def_payload);
        let refund_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: buyer_addr.clone(),
            amount: U128(5_000_000),
            sighash: [0xaa; 32],
        };

        let _ = contract.settle_default_foreign(deal_id, def_payload, def_sig, refund_tx);

        // State is tentatively Defaulted, but collateral payout is deferred to on_mpc_signed!
        let deal_tentative = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal_tentative.seller_collateral, 200_000_000_000_000_000_000_000);

        // Simulate MPC failure
        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        let rollback_ok = contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Default {
                seller_slashed: U128(100_000_000_000_000_000_000_000),
                buyer_slashed: U128(0),
                seller_collateral_remaining: U128(100_000_000_000_000_000_000_000),
            },
            [0xaa; 32],
            buyer_addr.clone(),
            U128(5_000_000),
            0,
            0,
            DealStatus::Active,
            0,
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(!rollback_ok);

        // Verify status rolled back to Active and collateral is still 100% intact (zero leakage!)
        let deal_reverted = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal_reverted.status, DealStatus::Active);
        assert_eq!(deal_reverted.seller_collateral, 200_000_000_000_000_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Seller payout address can only be set while the deal is Created")]
    fn test_seller_foreign_address_update_in_active_status_is_rejected() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0)).build());
        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x0000000000000000000000000000000000000000".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        // Advance to Active status
        let mut deal = contract.get_deal(deal_id).unwrap();
        deal.status = DealStatus::Active;
        contract.deals.insert(&deal_id, &deal);

        // Payout destinations are immutable after funding/activation.
        contract.set_foreign_seller_address(deal_id, "0x9999999999999999999999999999999999999999".to_string());
    }

    #[test]
    fn test_timeout_refund_foreign_created_zero_deposit_skips_mpc() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        // Early cancellation by buyer when zero deposit was funded
        let dummy_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: "0x3333333333333333333333333333333333333333".to_string(),
            amount: U128(10_000_000),
            sighash: [0; 32],
        };

        let _ = contract.timeout_refund_foreign(deal_id, dummy_tx);
        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Cancelled);
    }

    #[test]
    fn test_nep297_event_format() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        let mpc_sig = crate::types::SignatureResponse {
            scheme: "ecdsa".to_string(),
            big_r: crate::types::AffinePoint { affine_point: "02".to_string() + &"11".repeat(32) },
            s: crate::types::Scalar { scalar: "22".repeat(32) },
            recovery_id: 0,
        };

        contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Stage { stage: 25 },
            [0x55; 32],
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(2_500_000),
            0,
            0,
            DealStatus::Active,
            0,
            Ok(mpc_sig),
        );

        let logs = near_sdk::test_utils::get_logs();
        let foreign_signed_log = logs.iter().find(|l| l.contains("foreign_tx_signed")).expect("Must emit foreign_tx_signed event");
        assert!(foreign_signed_log.starts_with("EVENT_JSON:"), "Must follow NEP-297 EVENT_JSON prefix");
        assert!(foreign_signed_log.contains("\"standard\":\"conpi\""), "Must have standard: conpi");
        assert!(foreign_signed_log.contains("\"event\":\"foreign_tx_signed\""), "Must have event: foreign_tx_signed");
        assert!(foreign_signed_log.contains("\"data\":["), "Must have data array");
        // Ensure 33-byte affine point 02 prefix was stripped to 64-char scalar!
        assert!(!foreign_signed_log.contains("\"r_hex\":\"02"), "r_hex must not contain 02 point prefix");
    }

    #[test]
    fn test_set_foreign_buyer_address() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x0000000000000000000000000000000000000000".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        // Buyer fills their refund address once, before the deposit is recorded.
        testing_env!(get_context(buyer.clone(), NearToken::from_yoctonear(0)).build());
        contract.set_foreign_buyer_address(deal_id, "0x5555555555555555555555555555555555555555".to_string());
        let info = contract.get_foreign_deal(deal_id).unwrap();
        assert_eq!(info.buyer_address, "0x5555555555555555555555555555555555555555");
    }

    #[test]
    fn test_foreign_chain_finalize_auto_release() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(500_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        let seller_addr = "0x4444444444444444444444444444444444444444".to_string();
        let token_addr = "0x2222222222222222222222222222222222222222".to_string();

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            token_addr.clone(),
            "0x3333333333333333333333333333333333333333".to_string(),
            seller_addr.clone(),
            U128(10_000_000),
        );

        // Advance deal to Active and pass usage deadline
        let mut deal = contract.get_deal(deal_id).unwrap();
        deal.status = DealStatus::Active;
        deal.usage_deadline = 1_000_000_000;
        contract.deals.insert(&deal_id, &deal);

        // Block timestamp past usage deadline
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0))
            .block_timestamp(1_500_000_000)
            .build());

        contract.request_auto_release(deal_id);
        let deal_noticed = contract.get_deal(deal_id).unwrap();
        assert!(deal_noticed.notice_deadline.is_some());

        // Fast forward past notice deadline (24 hours = 86_400_000_000_000 ns)
        let notice_deadline = deal_noticed.notice_deadline.unwrap();
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0))
            .block_timestamp(notice_deadline + 1_000_000)
            .build());

        let expected_sighash = crate::eip1559::Eip1559Helper::compute_standard_erc20_transfer_sighash(
            84532,
            0,
            &token_addr,
            &seller_addr,
            10_000_000,
        );

        let auto_release_tx = crate::types::ForeignTxRequest {
            nonce: 0,
            recipient: seller_addr.clone(),
            amount: U128(10_000_000),
            sighash: expected_sighash,
        };

        let _ = contract.finalize_auto_release_foreign(deal_id, auto_release_tx);

        // Simulate successful MPC signing callback
        let mpc_sig = crate::types::SignatureResponse {
            scheme: "ecdsa".to_string(),
            big_r: crate::types::AffinePoint { affine_point: "11".repeat(32) },
            s: crate::types::Scalar { scalar: "22".repeat(32) },
            recovery_id: 0,
        };

        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        let callback_ok = contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Stage { stage: 100 },
            expected_sighash,
            seller_addr.clone(),
            U128(10_000_000),
            0,
            0,
            DealStatus::Active,
            0,
            Ok(mpc_sig),
        );
        assert!(callback_ok);

        let finalized_deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(finalized_deal.status, DealStatus::Completed);
        assert_eq!(finalized_deal.stage_reached, 100);
        assert_eq!(finalized_deal.seller_collateral, 0);
    }

    #[test]
    fn test_foreign_chain_waives_native_buyer_collateral() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(500_000), // Non-zero native buyer collateral
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.buyer_collateral, 0);
    }

    #[test]
    #[should_panic(expected = "Foreign chain deals must not specify NEP-141 token escrow")]
    fn test_foreign_chain_rejects_nep141_token() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        let usdt: AccountId = "usdt.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: Some(usdt),
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );
    }

    #[test]
    #[should_panic(expected = "Valid non-zero hexadecimal buyer address is required")]
    fn test_foreign_chain_rejects_non_hex_address() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        // Non-hex character 'Z' must panic at validation time
        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );
    }

    #[test]
    #[should_panic(expected = "Buyer deposits for foreign chain deals must be made on the foreign chain")]
    fn test_foreign_chain_rejects_native_buyer_deposit() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        // Buyer attempts to attach native NEAR to foreign deal - must be rejected!
        testing_env!(get_context(buyer.clone(), NearToken::from_near(1)).build());
        contract.deposit(deal_id);
    }

    #[test]
    fn test_foreign_chain_seller_slashing_and_buyer_breach() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(300_000_000_000_000_000_000_000),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );

        let mpc_sig = crate::types::SignatureResponse {
            scheme: "ecdsa".to_string(),
            big_r: crate::types::AffinePoint { affine_point: "11".repeat(32) },
            s: crate::types::Scalar { scalar: "22".repeat(32) },
            recovery_id: 0,
        };

        // Test Default: seller slashed for ProviderBan
        testing_env!(get_context("conpi.testnet".parse().unwrap(), NearToken::from_yoctonear(0)).build());
        contract.on_mpc_signed(
            deal_id,
            crate::types::MpcCallbackAction::Default {
                seller_slashed: U128(150_000_000_000_000_000_000_000),
                buyer_slashed: U128(0),
                seller_collateral_remaining: U128(150_000_000_000_000_000_000_000),
            },
            [0xdd; 32],
            "0x3333333333333333333333333333333333333333".to_string(),
            U128(5_000_000),
            0,
            0,
            DealStatus::Active,
            0,
            Ok(mpc_sig),
        );

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Defaulted);
        assert_eq!(deal.seller_collateral, 0);
    }

    #[test]
    #[should_panic(expected = "Native buyer deposit already made; cannot convert to foreign chain deal")]
    fn test_foreign_chain_rejects_already_deposited_deal() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(2_000_000_000_000_000_000_000_000), // 2 NEAR
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        // Buyer deposits 1 NEAR (partial deposit, deal status remains Created)
        testing_env!(get_context(buyer.clone(), NearToken::from_near(1)).build());
        contract.deposit(deal_id);

        let deal = contract.get_deal(deal_id).unwrap();
        assert_eq!(deal.status, DealStatus::Created);
        assert_eq!(deal.buyer_deposited, 1_000_000_000_000_000_000_000_000);

        // Caller attempts to register foreign chain parameters after native deposit was made
        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000_000),
        );
    }

    #[test]
    fn test_storage_deposit_removed_on_terminal_resolution() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(1_000_000_000_000_000_000_000_000),
            credit_amount: U128(1_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 1000,
        });

        // deal_creators must contain buyer initially
        assert_eq!(contract.deal_creators.get(&deal_id), Some(buyer.clone()));

        // Cancel deal before funding
        testing_env!(get_context(buyer.clone(), NearToken::from_yoctonear(0)).build());
        contract.timeout_refund(deal_id);

        // After cancellation, storage deposit has been refunded and entry removed
        assert!(contract.deal_creators.get(&deal_id).is_none());
    }

    #[test]
    fn test_set_foreign_seller_address_before_registration() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();

        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner.clone(),
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );

        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: None,
            price: U128(10_000_000_000_000_000_000_000),
            credit_amount: U128(10_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk.clone(),
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 5000,
        });

        // 1. Seller sets foreign payout address BEFORE register_foreign_chain_deal has been called
        testing_env!(get_context(seller.clone(), NearToken::from_yoctonear(0)).build());
        let seller_evm = "0x01a4d97CE5419097dAB16817b59bBC1a2Af53404".to_string();
        contract.set_foreign_seller_address(deal_id, seller_evm.clone());

        let info = contract.get_foreign_deal(deal_id).expect("foreign deal initialized");
        assert_eq!(info.seller_address, seller_evm);
        assert_eq!(info.chain_id, 84532);

        // 2. Later, when buyer/relayer registers foreign deal parameters, it must succeed without panic and preserve seller address
        testing_env!(get_context(buyer.clone(), NearToken::from_yoctonear(0)).build());
        register_foreign_chain_deal_as_seller(&mut contract,
            deal_id,
            84532,
            "0x3be5DaDC60292F724D9f9a7203F833816077927F".to_string(),
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string(),
            "0x0000000000000000000000000000000000000000".to_string(),
            seller_evm.clone(),
            U128(40_000), // $0.04 USDC
        );

        let updated_info = contract.get_foreign_deal(deal_id).unwrap();
        assert_eq!(updated_info.vault_address, "0x3be5DaDC60292F724D9f9a7203F833816077927F");
        assert_eq!(updated_info.seller_address, seller_evm);
        assert_eq!(updated_info.foreign_amount, U128(40_000));
    }

    #[test]
    #[should_panic(expected = "Only seller, owner, or active TEE signer can register foreign chain parameters")]
    fn test_buyer_cannot_register_or_rewrite_foreign_settlement_parameters() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner,
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );
        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer: buyer.clone(),
            seller,
            token: None,
            price: U128(10_000),
            credit_amount: U128(10_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 5000,
        });
        contract.register_foreign_chain_deal(
            deal_id,
            84532,
            "0x1111111111111111111111111111111111111111".to_string(),
            "0x2222222222222222222222222222222222222222".to_string(),
            "0x3333333333333333333333333333333333333333".to_string(),
            "0x4444444444444444444444444444444444444444".to_string(),
            U128(10_000),
        );
    }

    #[test]
    #[should_panic(expected = "Foreign amount is locked")]
    fn test_registered_foreign_amount_cannot_be_rewritten() {
        let (_signing_key, tee_pk) = generate_tee_keypair();
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        let seller: AccountId = "seller.testnet".parse().unwrap();
        testing_env!(get_context(owner.clone(), STORAGE_DEPOSIT).build());
        let mut contract = ConpiEscrow::new(
            owner,
            Some("testnet".to_string()),
            None,
            Some((tee_pk.clone(), REAL_CVM_MEASUREMENT.to_string())),
            None,
        );
        testing_env!(get_context(buyer.clone(), STORAGE_DEPOSIT).build());
        let deal_id = contract.create_deal(CreateDealParams {
            buyer,
            seller,
            token: None,
            price: U128(10_000),
            credit_amount: U128(10_000),
            buyer_collateral: U128(0),
            seller_collateral: U128(0),
            tee_pubkey: tee_pk,
            deposit_duration_sec: 3600,
            key_duration_sec: 3600,
            tee_liveness_timeout_sec: 3600,
            slash_bps_provider_ban: 5000,
            slash_bps_revoke: 8000,
            slash_bps_buyer_breach: 5000,
        });
        let vault = "0x1111111111111111111111111111111111111111".to_string();
        let token = "0x2222222222222222222222222222222222222222".to_string();
        let buyer_address = "0x3333333333333333333333333333333333333333".to_string();
        let seller_address = "0x4444444444444444444444444444444444444444".to_string();
        register_foreign_chain_deal_as_seller(
            &mut contract,
            deal_id,
            84532,
            vault.clone(),
            token.clone(),
            buyer_address.clone(),
            seller_address.clone(),
            U128(10_000),
        );
        register_foreign_chain_deal_as_seller(
            &mut contract,
            deal_id,
            84532,
            vault,
            token,
            buyer_address,
            seller_address,
            U128(1),
        );
    }

    #[test]
    fn test_cross_chain_seller_account_ids() {
        use near_sdk::AccountId;

        // 1. Solana 32-byte pubkey hex (64 lowercase hex chars)
        let sol_hex = "bbd65d65de6e15e11d9f887423339a1cedc262ee4ea2581bfbfb39f5492e0273";
        let sol_account = AccountId::try_from(sol_hex.to_string());
        assert!(sol_account.is_ok(), "Solana 64-hex string must be a valid NEAR AccountId: {:?}", sol_account.err());

        // 2. EVM padded 64 hex chars
        let evm_hex = "00000000000000000000000001a4d97ce5419097dab16817b59bbc1a2af53404";
        let evm_account = AccountId::try_from(evm_hex.to_string());
        assert!(evm_account.is_ok(), "EVM 64-hex string must be a valid NEAR AccountId: {:?}", evm_account.err());
    }
}

