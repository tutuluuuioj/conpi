use near_sdk::env;

pub struct Eip1559Helper;

impl Eip1559Helper {
    fn rlp_encode_uint(val: u128, out: &mut Vec<u8>) {
        if val == 0 {
            out.push(0x80);
            return;
        }
        let bytes = val.to_be_bytes();
        let start = bytes.iter().position(|&b| b != 0).unwrap_or(16);
        let slice = &bytes[start..];
        if slice.len() == 1 && slice[0] < 0x80 {
            out.push(slice[0]);
        } else {
            out.push(0x80 + slice.len() as u8);
            out.extend_from_slice(slice);
        }
    }

    fn rlp_encode_bytes(slice: &[u8], out: &mut Vec<u8>) {
        if slice.len() == 1 && slice[0] < 0x80 {
            out.push(slice[0]);
        } else if slice.len() <= 55 {
            out.push(0x80 + slice.len() as u8);
            out.extend_from_slice(slice);
        } else {
            let len_bytes = (slice.len() as u64).to_be_bytes();
            let start = len_bytes.iter().position(|&b| b != 0).unwrap_or(8);
            let len_slice = &len_bytes[start..];
            out.push(0xb7 + len_slice.len() as u8);
            out.extend_from_slice(len_slice);
            out.extend_from_slice(slice);
        }
    }

    fn rlp_encode_list(items_payload: &[u8], out: &mut Vec<u8>) {
        if items_payload.len() <= 55 {
            out.push(0xc0 + items_payload.len() as u8);
            out.extend_from_slice(items_payload);
        } else {
            let len_bytes = (items_payload.len() as u64).to_be_bytes();
            let start = len_bytes.iter().position(|&b| b != 0).unwrap_or(8);
            let len_slice = &len_bytes[start..];
            out.push(0xf7 + len_slice.len() as u8);
            out.extend_from_slice(len_slice);
            out.extend_from_slice(items_payload);
        }
    }

    fn parse_address(addr_str: &str) -> [u8; 20] {
        let clean = addr_str.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean).expect("Invalid hex address");
        assert_eq!(bytes.len(), 20, "Address must be 20 bytes");
        let mut out = [0u8; 20];
        out.copy_from_slice(&bytes);
        out
    }

    /// Computes the deterministic EIP-1559 sighash for an ERC-20 transfer.
    pub fn compute_erc20_transfer_sighash(
        chain_id: u64,
        nonce: u64,
        token_address: &str,
        recipient: &str,
        amount_atomic: u128,
        max_priority_fee_per_gas: u128,
        max_fee_per_gas: u128,
        gas_limit: u128,
    ) -> [u8; 32] {
        let mut items = Vec::new();

        // 1. chain_id
        Self::rlp_encode_uint(chain_id as u128, &mut items);

        // 2. nonce
        Self::rlp_encode_uint(nonce as u128, &mut items);

        // 3. max_priority_fee_per_gas
        Self::rlp_encode_uint(max_priority_fee_per_gas, &mut items);

        // 4. max_fee_per_gas
        Self::rlp_encode_uint(max_fee_per_gas, &mut items);

        // 5. gas_limit
        Self::rlp_encode_uint(gas_limit, &mut items);

        // 6. to (token address)
        let token_bytes = Self::parse_address(token_address);
        Self::rlp_encode_bytes(&token_bytes, &mut items);

        // 7. value (0)
        Self::rlp_encode_uint(0, &mut items);

        // 8. data: transfer(recipient, amount) -> 68 bytes
        let mut calldata = Vec::with_capacity(68);
        calldata.extend_from_slice(&[0xa9, 0x05, 0x9c, 0xbb]); // transfer(address,uint256) selector
        let recip_bytes = Self::parse_address(recipient);
        calldata.extend_from_slice(&[0u8; 12]); // 12 bytes padding
        calldata.extend_from_slice(&recip_bytes); // 20 bytes recipient
        let amt_be = amount_atomic.to_be_bytes();
        calldata.extend_from_slice(&[0u8; 16]); // 16 bytes padding
        calldata.extend_from_slice(&amt_be); // 16 bytes u128
        Self::rlp_encode_bytes(&calldata, &mut items);

        // 9. access_list: empty list -> 0xc0
        items.push(0xc0);

        // Final payload: 0x02 || rlp(items)
        let mut raw_tx = Vec::with_capacity(items.len() + 4);
        raw_tx.push(0x02);
        Self::rlp_encode_list(&items, &mut raw_tx);

        env::keccak256_array(&raw_tx)
    }

    /// Helper using default standard gas parameters (1.5 gwei max fee, 0.001 gwei priority fee, 65k gas).
    pub fn compute_standard_erc20_transfer_sighash(
        chain_id: u64,
        nonce: u64,
        token_address: &str,
        recipient: &str,
        amount_atomic: u128,
    ) -> [u8; 32] {
        Self::compute_erc20_transfer_sighash(
            chain_id,
            nonce,
            token_address,
            recipient,
            amount_atomic,
            1_000_000,
            1_500_000_000,
            65_000,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eip1559_sighash_matches_viem() {
        let chain_id = 84532;
        let nonce = 0;
        let token_address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
        let recipient = "0x2222222222222222222222222222222222222222";
        let amount = 1_250_000;

        let sighash = Eip1559Helper::compute_standard_erc20_transfer_sighash(
            chain_id,
            nonce,
            token_address,
            recipient,
            amount,
        );
        let hex_sighash = format!("0x{}", hex::encode(sighash));
        assert_eq!(
            hex_sighash,
            "0xcfb936166ad574d4cc53b02a6173967a1cf7944b5cfb6c80ee1c9463d8d0a6fc",
            "Rust EIP-1559 sighash MUST match viem byte-for-byte"
        );
    }
}
