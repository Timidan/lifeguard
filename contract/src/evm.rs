//! EVM transaction building done inside the contract: RLP, EIP-1559 hashing, Aave calldata.
//! The agent never supplies bytes; everything that reaches the MPC signer is built here.

use near_sdk::env;

pub type Address = [u8; 20];

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [DIGITS[(b >> 4) as usize] as char, DIGITS[(b & 15) as usize] as char]).collect()
}

pub fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        env::panic_str("odd-length hex");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| env::panic_str("invalid hex")))
        .collect()
}

pub fn parse_address(s: &str) -> Address {
    hex_decode(s).try_into().unwrap_or_else(|_| env::panic_str("address must be 20 bytes"))
}

pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    env::keccak256_array(bytes)
}

/// The Ethereum address of a NEAR MPC derived key (`secp256k1:<base58 of the 64-byte point>`).
pub fn address_from_mpc_key(key: &str) -> Address {
    let b58 = key.strip_prefix("secp256k1:").unwrap_or_else(|| env::panic_str("expected a secp256k1 key"));
    let point = bs58::decode(b58).into_vec().unwrap_or_else(|_| env::panic_str("invalid base58"));
    if point.len() != 64 {
        env::panic_str("expected a 64-byte uncompressed point");
    }
    keccak(&point)[12..].try_into().unwrap()
}

// --- RLP -------------------------------------------------------------------

fn trim(bytes: &[u8]) -> &[u8] {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[first..]
}

fn rlp_len_prefix(out: &mut Vec<u8>, len: usize, short: u8, long: u8) {
    if len <= 55 {
        out.push(short + len as u8);
    } else {
        let len_bytes = trim(&(len as u64).to_be_bytes()).to_vec();
        out.push(long + len_bytes.len() as u8);
        out.extend(len_bytes);
    }
}

fn rlp_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        out.push(bytes[0]);
    } else {
        rlp_len_prefix(out, bytes.len(), 0x80, 0xb7);
        out.extend_from_slice(bytes);
    }
}

/// Integers are big-endian with no leading zeros; zero is the empty string.
fn rlp_uint(out: &mut Vec<u8>, be_bytes: &[u8]) {
    rlp_bytes(out, trim(be_bytes));
}

fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    rlp_len_prefix(&mut out, payload.len(), 0xc0, 0xf7);
    out.extend_from_slice(payload);
    out
}

// --- EIP-1559 --------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Eip1559 {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: Address,
    pub value: u128,
    pub data: Vec<u8>,
}

impl Eip1559 {
    fn fields(&self) -> Vec<u8> {
        let mut out = Vec::new();
        rlp_uint(&mut out, &self.chain_id.to_be_bytes());
        rlp_uint(&mut out, &self.nonce.to_be_bytes());
        rlp_uint(&mut out, &self.max_priority_fee_per_gas.to_be_bytes());
        rlp_uint(&mut out, &self.max_fee_per_gas.to_be_bytes());
        rlp_uint(&mut out, &self.gas_limit.to_be_bytes());
        rlp_bytes(&mut out, &self.to);
        rlp_uint(&mut out, &self.value.to_be_bytes());
        rlp_bytes(&mut out, &self.data);
        out.extend(rlp_list(&[])); // empty access list
        out
    }

    fn typed(list: Vec<u8>) -> Vec<u8> {
        let mut out = vec![0x02];
        out.extend(rlp_list(&list));
        out
    }

    /// The hash the MPC network signs.
    pub fn signing_hash(&self) -> [u8; 32] {
        keccak(&Self::typed(self.fields()))
    }

    /// The raw signed transaction a relayer broadcasts; its keccak is the transaction hash.
    pub fn signed(&self, y_parity: u8, r: &[u8], s: &[u8]) -> Vec<u8> {
        let mut list = self.fields();
        rlp_uint(&mut list, &[y_parity]);
        rlp_uint(&mut list, r);
        rlp_uint(&mut list, s);
        Self::typed(list)
    }
}

// --- Aave V3 calldata ------------------------------------------------------

fn word_address(out: &mut Vec<u8>, a: &Address) {
    out.extend([0u8; 12]);
    out.extend_from_slice(a);
}

fn word_uint(out: &mut Vec<u8>, v: u128) {
    out.extend([0u8; 16]);
    out.extend(v.to_be_bytes());
}

/// `Pool.supply(asset, amount, onBehalfOf, 0)`
pub fn supply(asset: &Address, amount: u128, on_behalf_of: &Address) -> Vec<u8> {
    let mut d = vec![0x61, 0x7b, 0xa0, 0x37];
    word_address(&mut d, asset);
    word_uint(&mut d, amount);
    word_address(&mut d, on_behalf_of);
    word_uint(&mut d, 0);
    d
}

/// `Pool.repay(asset, amount, 2 /* variable */, onBehalfOf)`
pub fn repay(asset: &Address, amount: u128, on_behalf_of: &Address) -> Vec<u8> {
    let mut d = vec![0x57, 0x3a, 0xde, 0x81];
    word_address(&mut d, asset);
    word_uint(&mut d, amount);
    word_uint(&mut d, 2);
    word_address(&mut d, on_behalf_of);
    d
}

/// `ERC20.approve(spender, amount)`
pub fn approve(spender: &Address, amount: u128) -> Vec<u8> {
    let mut d = vec![0x09, 0x5e, 0xa7, 0xb3];
    word_address(&mut d, spender);
    word_uint(&mut d, amount);
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h32(s: &str) -> [u8; 32] {
        hex_decode(s).try_into().unwrap()
    }

    // Two transactions signed by NEAR chain signatures and mined on Ethereum Sepolia (killtests/readmpc).
    fn self_transfer() -> Eip1559 {
        Eip1559 {
            chain_id: 11155111,
            nonce: 0,
            max_priority_fee_per_gas: 0x33,
            max_fee_per_gas: 0xa2,
            gas_limit: 21000,
            to: parse_address("0x541b49b3b3f4a20455b3674130030b4072bd210c"),
            value: 0,
            data: vec![],
        }
    }

    fn bridge_deposit() -> Eip1559 {
        Eip1559 {
            chain_id: 11155111,
            nonce: 2,
            max_priority_fee_per_gas: 0x33,
            max_fee_per_gas: 0xa2,
            gas_limit: 0xdbba0,
            to: parse_address("0xfd0bf71f60660e2f608ed56e1659c450eb113120"),
            value: 0x6a94d74f430000,
            data: hex_decode("0xb1a1a8820000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000"),
        }
    }

    #[test]
    fn signing_and_tx_hashes_match_mined_transactions() {
        let tx = self_transfer();
        assert_eq!(tx.signing_hash(), h32("3a2db0b0407c3617771ab98e7bfff98c07b7eeda8e912ce7104f06904fa65ee0"));
        let raw = tx.signed(
            1,
            &hex_decode("1224473f7e17ee8a97017ffc03141a676826fad8c9648b2dbaa8728deaba165c"),
            &hex_decode("3d17fc56b1038b94f90846b6d618e42eed8f0d557f348d9c0a0677aff9630482"),
        );
        assert_eq!(keccak(&raw), h32("f218c7e209d8db20b7b9ad8c49828e040fce5ae97a3a62d2ede6cddb9a08bde9"));

        let tx = bridge_deposit();
        assert_eq!(tx.signing_hash(), h32("591ae3f5aa2e35a2d73d12bd2fb8876fbdabf2636a7100a098969966bb3d2176"));
        let raw = tx.signed(
            0,
            &hex_decode("2385f3ce40bdc47e83570e875d6e51c9243e140e2f6eec7f46f438ab6556d9ed"),
            &hex_decode("4e40036912346ed9fb8518d89cfa3547711eccb79cd5608e7989ad00a1164456"),
        );
        assert_eq!(keccak(&raw), h32("9f6af8cee07d3a8b829855b20e50f7b32da8258580b8280fecf84e0c85e6f271"));
    }

    #[test]
    fn calldata_matches_cast() {
        let usdc = parse_address("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f");
        let me = parse_address("0x541B49b3b3F4a20455b3674130030b4072bd210C");
        let pool = parse_address("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27");
        assert_eq!(hex_encode(&supply(&usdc, 1_000_000, &me)), "617ba037000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000541b49b3b3f4a20455b3674130030b4072bd210c0000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(hex_encode(&repay(&usdc, 1_000_000, &me)), "573ade81000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000541b49b3b3f4a20455b3674130030b4072bd210c");
        assert_eq!(hex_encode(&approve(&pool, 1_000_000)), "095ea7b30000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae2700000000000000000000000000000000000000000000000000000000000f4240");
    }

    #[test]
    fn address_from_mpc_key_matches_derived_address() {
        let key = "secp256k1:Aq39m4MkDNzxbjxjPdZDwHtbZaZiDtmdKHVfZMyjrHUN6itVishZ6BoizuvtXUJnF5peSPmfN21K9xYptcCccWL";
        assert_eq!(address_from_mpc_key(key), parse_address("0x541B49b3b3F4a20455b3674130030b4072bd210C"));
    }
}
