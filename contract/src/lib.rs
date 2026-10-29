//! Lifeguard: an AI agent that can rescue your loan on any chain but can never put it at risk,
//! enforced by NEAR.
//!
//! A position is an Aave V3 account on an EVM chain at an address derived by NEAR chain signatures
//! from this contract. The owner hands an agent a function-call access key that may call only
//! `request_action` and `confirm`. `request_action` accepts a fixed set of actions (supply, repay,
//! capped approve) and builds every transaction byte itself, so nothing that can lower the health
//! factor ever reaches the MPC signer. `owner_action` can sign anything, and the agent's key cannot
//! reach it. A signed transaction counts only after NEAR Read MPC proves it succeeded on the chain.

mod evm;

use evm::{hex_decode, hex_encode, parse_address, Eip1559};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const SIGN_GAS: Gas = Gas::from_tgas(50);
const VERIFY_GAS: Gas = Gas::from_tgas(50);
const DERIVE_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MPC_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const POSITION_DEPOSIT: NearToken = NearToken::from_millinear(50);
const HISTORY_LIMIT: usize = 50;
const DAY_NS: u64 = 86_400_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Asset {
    pub address: String,
    pub approve_cap: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    /// MPC signer contract, e.g. `v1.signer-prod.testnet`.
    pub mpc: AccountId,
    /// Read MPC chain name, e.g. `Base` (Base Sepolia on testnet).
    pub foreign_chain: String,
    /// MPC domain for Read MPC (purpose `ForeignTx`; 3 on testnet).
    pub foreign_tx_domain: u32,
    pub chain_id: U64,
    pub pool: String,
    pub assets: Vec<Asset>,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub max_gas_limit: U64,
    pub max_actions_per_day: u32,
}

/// The only things an agent can ask for. None of them can lower an Aave health factor.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Supply { asset: String, amount: U128 },
    Repay { asset: String, amount: U128 },
    Approve { asset: String, amount: U128 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Fees {
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Signed {
    pub nonce: U64,
    pub tx_hash: String,
    /// Raw signed transaction, ready to broadcast.
    pub raw: String,
    pub kind: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Entry {
    pub nonce: U64,
    pub tx_hash: String,
    pub kind: String,
    pub by: AccountId,
    pub at_ms: U64,
    pub proven: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Position {
    pub owner: AccountId,
    pub path: String,
    /// EVM address derived by the MPC network for (this contract, path); set by `on_derived`.
    pub address: Option<String>,
    /// Next EVM nonce; advances only on a Read MPC proof.
    pub nonce: U64,
    pub day: U64,
    pub actions_today: u32,
    /// Transactions signed at the current nonce. Each is safe; at most one can be mined.
    pub pending: Vec<Signed>,
    pub history: Vec<Entry>,
}

/// Fields of an unsigned transaction, carried to the signing callback.
#[near(serializers = [json])]
pub struct TxArgs {
    pub nonce: U64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: U64,
    pub to: String,
    pub value: U128,
    pub data: String,
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

/// MPC `sign` response for a secp256k1 domain.
#[near(serializers = [json])]
pub struct SignatureResponse {
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Lifeguard {
    config: Config,
    positions: LookupMap<u64, Position>,
    next_id: u64,
}

#[near]
impl Lifeguard {
    #[init]
    pub fn new(config: Config) -> Self {
        parse_address(&config.pool);
        config.assets.iter().for_each(|a| {
            parse_address(&a.address);
        });
        Self { config, positions: LookupMap::new(b"p"), next_id: 0 }
    }

    // --- positions ---------------------------------------------------------

    /// Opens a position for the caller and asks the MPC network for its EVM address.
    #[payable]
    pub fn create_position(&mut self) -> Promise {
        require!(env::attached_deposit() >= POSITION_DEPOSIT, "Attach 0.05 NEAR for storage");
        let id = self.next_id;
        self.next_id += 1;
        let path = format!("pos/{id}");
        self.positions.insert(
            id,
            Position {
                owner: env::predecessor_account_id(),
                path: path.clone(),
                address: None,
                nonce: U64(0),
                day: U64(0),
                actions_today: 0,
                pending: vec![],
                history: vec![],
            },
        );
        let args = json!({ "path": path, "predecessor": env::current_account_id(), "domain_id": 0 });
        Promise::new(self.config.mpc.clone())
            .function_call("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), DERIVE_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_derived(id))
    }

    #[private]
    pub fn on_derived(&mut self, id: u64, #[callback_result] key: Result<String, PromiseError>) -> String {
        let key = key.unwrap_or_else(|_| env::panic_str("derived_public_key failed"));
        let address = format!("0x{}", hex_encode(&evm::address_from_mpc_key(&key)));
        let position = self.positions.get_mut(&id).unwrap();
        position.address = Some(address.clone());
        address
    }

    // --- signing -----------------------------------------------------------

    /// What the agent's key can call. Builds a loan-safe transaction and has the MPC network sign it.
    pub fn request_action(&mut self, id: u64, action: Action, fees: Fees) -> Promise {
        let position = self.owned(id);
        let address = position_address(&position);
        let pool = parse_address(&self.config.pool);
        let (to, data, kind) = match &action {
            Action::Supply { asset, amount } => {
                (pool, evm::supply(&self.asset(asset), amount.0, &address), format!("supply {} of {asset}", amount.0))
            }
            Action::Repay { asset, amount } => {
                (pool, evm::repay(&self.asset(asset), amount.0, &address), format!("repay {} of {asset}", amount.0))
            }
            Action::Approve { asset, amount } => {
                let cap = self.config.assets.iter().find(|a| a.address.eq_ignore_ascii_case(asset)).map(|a| a.approve_cap.0);
                require!(amount.0 <= cap.unwrap_or(0), "Approve amount above the cap");
                (self.asset(asset), evm::approve(&pool, amount.0), format!("approve {} of {asset} to the pool", amount.0))
            }
        };
        require!(amount_of(&action) > 0, "Amount must be positive");
        self.count_action(id);
        self.sign(id, to, 0, data, fees, kind)
    }

    /// Signs any call. The agent's function-call key does not list this method, so NEAR rejects it.
    pub fn owner_action(&mut self, id: u64, to: String, value: U128, data: String, fees: Fees) -> Promise {
        self.owned(id);
        let data = hex_decode(&data);
        let selector = hex_encode(&data[..data.len().min(4)]);
        self.sign(id, parse_address(&to), value.0, data, fees, format!("owner call 0x{selector} to {to}"))
    }

    #[private]
    pub fn on_signed(
        &mut self,
        id: u64,
        tx: TxArgs,
        kind: String,
        by: AccountId,
        #[callback_result] signature: Result<SignatureResponse, PromiseError>,
    ) -> Signed {
        let signature = signature.unwrap_or_else(|_| env::panic_str("MPC sign failed"));
        let r = hex_decode(&signature.big_r.affine_point);
        require!(r.len() == 33, "Unexpected big_r encoding");
        let raw = self.build(&tx).signed(signature.recovery_id, &r[1..], &hex_decode(&signature.s.scalar));
        let signed = Signed {
            nonce: tx.nonce,
            tx_hash: format!("0x{}", hex_encode(&evm::keccak(&raw))),
            raw: format!("0x{}", hex_encode(&raw)),
            kind: kind.clone(),
        };
        let position = self.positions.get_mut(&id).unwrap();
        if position.nonce == tx.nonce {
            position.pending.push(signed.clone());
        }
        position.history.push(Entry {
            nonce: tx.nonce,
            tx_hash: signed.tx_hash.clone(),
            kind,
            by,
            at_ms: U64(env::block_timestamp_ms()),
            proven: false,
        });
        if position.history.len() > HISTORY_LIMIT {
            position.history.remove(0);
        }
        signed
    }

    // --- proof -------------------------------------------------------------

    /// Anyone may ask Read MPC to prove that a transaction signed at the current nonce succeeded.
    /// Read MPC refuses reverted transactions, so a proof means the action took effect.
    pub fn confirm(&mut self, id: u64, tx_hash: String) -> Promise {
        let position = self.positions.get(&id).unwrap_or_else(|| env::panic_str("No such position"));
        require!(position.pending.iter().any(|s| s.tx_hash == tx_hash), "Not a transaction signed at the current nonce");
        let tx_id = tx_hash.trim_start_matches("0x");
        let args = json!({ "request": {
            "request": { self.config.foreign_chain.as_str(): { "tx_id": tx_id, "extractors": ["BlockHash"], "finality": "Safe" } },
            "domain_id": self.config.foreign_tx_domain,
            "payload_version": 1,
        }});
        let nonce = position.nonce;
        Promise::new(self.config.mpc.clone())
            .function_call("verify_foreign_transaction", args.to_string().into_bytes(), MPC_DEPOSIT, VERIFY_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_confirmed(id, nonce, tx_hash))
    }

    #[private]
    pub fn on_confirmed(
        &mut self,
        id: u64,
        nonce: U64,
        tx_hash: String,
        #[callback_result] proof: Result<near_sdk::serde_json::Value, PromiseError>,
    ) -> bool {
        if proof.is_err() {
            return false; // a timeout is not a proof
        }
        let position = self.positions.get_mut(&id).unwrap();
        if position.nonce == nonce {
            position.nonce = U64(nonce.0 + 1);
            position.pending.clear();
        }
        if let Some(entry) = position.history.iter_mut().rev().find(|e| e.tx_hash == tx_hash) {
            entry.proven = true;
        }
        true
    }

    /// Liveness escape for a reverted transaction, which Read MPC never proves. Owner key only.
    pub fn reset_nonce(&mut self, id: u64, nonce: U64) {
        self.owned(id);
        let position = self.positions.get_mut(&id).unwrap();
        position.nonce = nonce;
        position.pending.clear();
    }

    // --- views -------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_position(&self, id: u64) -> Option<Position> {
        self.positions.get(&id).cloned()
    }

    // --- internal ----------------------------------------------------------

    fn owned(&self, id: u64) -> Position {
        let position = self.positions.get(&id).unwrap_or_else(|| env::panic_str("No such position")).clone();
        require!(position.owner == env::predecessor_account_id(), "Only the position owner");
        position
    }

    fn asset(&self, asset: &str) -> evm::Address {
        require!(self.config.assets.iter().any(|a| a.address.eq_ignore_ascii_case(asset)), "Asset not allowed");
        parse_address(asset)
    }

    fn count_action(&mut self, id: u64) {
        let max = self.config.max_actions_per_day;
        let position = self.positions.get_mut(&id).unwrap();
        let today = env::block_timestamp() / DAY_NS;
        if position.day.0 != today {
            position.day = U64(today);
            position.actions_today = 0;
        }
        require!(position.actions_today < max, "Daily action limit reached");
        position.actions_today += 1;
    }

    fn build(&self, tx: &TxArgs) -> Eip1559 {
        Eip1559 {
            chain_id: self.config.chain_id.0,
            nonce: tx.nonce.0,
            max_priority_fee_per_gas: tx.max_priority_fee_per_gas.0,
            max_fee_per_gas: tx.max_fee_per_gas.0,
            gas_limit: tx.gas_limit.0,
            to: parse_address(&tx.to),
            value: tx.value.0,
            data: hex_decode(&tx.data),
        }
    }

    fn sign(&mut self, id: u64, to: evm::Address, value: u128, data: Vec<u8>, fees: Fees, kind: String) -> Promise {
        let c = &self.config;
        require!(fees.max_fee_per_gas.0 <= c.max_fee_per_gas.0, "Max fee above the cap");
        require!(fees.max_priority_fee_per_gas.0 <= c.max_priority_fee_per_gas.0, "Priority fee above the cap");
        require!(fees.max_priority_fee_per_gas.0 <= fees.max_fee_per_gas.0, "Priority fee above max fee");
        require!(fees.gas_limit.0 <= c.max_gas_limit.0, "Gas limit above the cap");
        let position = self.positions.get(&id).unwrap();
        let tx = TxArgs {
            nonce: position.nonce,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
            max_fee_per_gas: fees.max_fee_per_gas,
            gas_limit: fees.gas_limit,
            to: format!("0x{}", hex_encode(&to)),
            value: U128(value),
            data: hex_encode(&data),
        };
        let hash = self.build(&tx).signing_hash();
        let args = json!({ "request": { "path": position.path, "payload_v2": { "Ecdsa": hex_encode(&hash) }, "domain_id": 0 } });
        Promise::new(c.mpc.clone())
            .function_call("sign", args.to_string().into_bytes(), MPC_DEPOSIT, SIGN_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(id, tx, kind, env::predecessor_account_id()),
            )
    }
}

fn position_address(position: &Position) -> evm::Address {
    parse_address(position.address.as_deref().unwrap_or_else(|| env::panic_str("Position address not derived yet")))
}

fn amount_of(action: &Action) -> u128 {
    match action {
        Action::Supply { amount, .. } | Action::Repay { amount, .. } | Action::Approve { amount, .. } => amount.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const USDC: &str = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";

    fn config() -> Config {
        Config {
            mpc: "v1.signer-prod.testnet".parse().unwrap(),
            foreign_chain: "Base".into(),
            foreign_tx_domain: 3,
            chain_id: U64(84532),
            pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27".into(),
            assets: vec![Asset { address: USDC.into(), approve_cap: U128(1_000_000_000) }],
            max_fee_per_gas: U128(10_000_000_000),
            max_priority_fee_per_gas: U128(2_000_000_000),
            max_gas_limit: U64(500_000),
            max_actions_per_day: 2,
        }
    }

    fn fees() -> Fees {
        Fees { max_fee_per_gas: U128(1_000_000_000), max_priority_fee_per_gas: U128(1_000_000), gas_limit: U64(300_000) }
    }

    fn as_account(account: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account.parse().unwrap())
            .attached_deposit(POSITION_DEPOSIT)
            .build());
    }

    /// A contract with position 0 owned by alice and its address already derived.
    fn setup() -> Lifeguard {
        as_account("alice.testnet");
        let mut c = Lifeguard::new(config());
        let _ = c.create_position();
        c.on_derived(0, Ok("secp256k1:Aq39m4MkDNzxbjxjPdZDwHtbZaZiDtmdKHVfZMyjrHUN6itVishZ6BoizuvtXUJnF5peSPmfN21K9xYptcCccWL".into()));
        c
    }

    fn repay(amount: u128) -> Action {
        Action::Repay { asset: USDC.into(), amount: U128(amount) }
    }

    #[test]
    fn allowed_action_reaches_the_signer() {
        let mut c = setup();
        let _ = c.request_action(0, repay(1_000_000), fees());
        assert_eq!(c.get_position(0).unwrap().actions_today, 1);
    }

    #[test]
    #[should_panic(expected = "Only the position owner")]
    fn rejects_other_accounts() {
        let mut c = setup();
        as_account("mallory.testnet");
        let _ = c.request_action(0, repay(1), fees());
    }

    #[test]
    #[should_panic(expected = "Asset not allowed")]
    fn rejects_unlisted_asset() {
        let mut c = setup();
        let _ = c.request_action(0, Action::Supply { asset: "0x0000000000000000000000000000000000000bad".into(), amount: U128(1) }, fees());
    }

    #[test]
    #[should_panic(expected = "Approve amount above the cap")]
    fn rejects_approve_over_cap() {
        let mut c = setup();
        let _ = c.request_action(0, Action::Approve { asset: USDC.into(), amount: U128(1_000_000_001) }, fees());
    }

    #[test]
    #[should_panic(expected = "Max fee above the cap")]
    fn rejects_fee_over_cap() {
        let mut c = setup();
        let mut f = fees();
        f.max_fee_per_gas = U128(10_000_000_001);
        let _ = c.request_action(0, repay(1), f);
    }

    #[test]
    #[should_panic(expected = "Daily action limit reached")]
    fn rejects_past_daily_limit() {
        let mut c = setup();
        for _ in 0..3 {
            let _ = c.request_action(0, repay(1), fees());
        }
    }

    #[test]
    fn agent_actions_cannot_express_borrow_or_withdraw() {
        // The action set is closed: anything else fails to deserialize before any code runs.
        let borrow = near_sdk::serde_json::from_str::<Action>(r#"{"Borrow":{"asset":"0x00","amount":"1"}}"#);
        let withdraw = near_sdk::serde_json::from_str::<Action>(r#"{"Withdraw":{"asset":"0x00","amount":"1"}}"#);
        assert!(borrow.is_err() && withdraw.is_err());
    }

    #[test]
    fn signed_callback_records_hash_and_proof_advances_nonce() {
        let mut c = setup();
        let tx = TxArgs {
            nonce: U64(0),
            max_priority_fee_per_gas: U128(1_000_000),
            max_fee_per_gas: U128(1_000_000_000),
            gas_limit: U64(300_000),
            to: config().pool,
            value: U128(0),
            data: hex_encode(&evm::repay(&parse_address(USDC), 1, &parse_address("0x541B49b3b3F4a20455b3674130030b4072bd210C"))),
        };
        let sig = SignatureResponse {
            big_r: AffinePoint { affine_point: format!("02{}", "11".repeat(32)) },
            s: Scalar { scalar: "22".repeat(32) },
            recovery_id: 1,
        };
        let signed = c.on_signed(0, tx, "repay".into(), "alice.testnet".parse().unwrap(), Ok(sig));
        assert_eq!(c.get_position(0).unwrap().pending.len(), 1);

        assert!(!c.on_confirmed(0, U64(0), signed.tx_hash.clone(), Err(PromiseError::Failed)));
        assert_eq!(c.get_position(0).unwrap().nonce, U64(0));

        assert!(c.on_confirmed(0, U64(0), signed.tx_hash, Ok(json!({}))));
        let p = c.get_position(0).unwrap();
        assert_eq!((p.nonce, p.pending.len(), p.history[0].proven), (U64(1), 0, true));
    }
}
