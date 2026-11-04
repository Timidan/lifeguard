import type { InternalAction } from '@near-wallet-selector/core';

export type FunctionCall = { receiverId: string; method: string; args: object; gas: string; deposit: string };
export type WalletTransaction = { receiverId: string; actions: InternalAction[] };
export type LifeguardWallet = {
  accountId: () => string | null;
  subscribe: (listener: () => void) => () => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signFunctionCall: (call: FunctionCall) => Promise<string | null>;
  signTransactions: (transactions: WalletTransaction[]) => Promise<string[] | null>;
  addKey: (contract: string, publicKey: string) => Promise<string | null>;
  deleteKey: (publicKey: string) => Promise<string | null>;
};
declare global { interface Window { lifeguardWallet?: LifeguardWallet } }

/** Wallet redirects report a transaction or rejection here; setup itself resumes from chain state. */
export function walletReturn() {
  const url = new URL(window.location.href);
  const hash = url.searchParams.get('transactionHashes')?.split(',')[0] || null;
  const error = url.searchParams.get('errorMessage') || url.searchParams.get('errorCode');
  if (hash || error) {
    for (const key of ['transactionHashes', 'errorMessage', 'errorCode']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  }
  return { hash, error };
}

let instance: Promise<LifeguardWallet> | undefined;
export async function getWallet(): Promise<LifeguardWallet> {
  if (window.lifeguardWallet) return window.lifeguardWallet;
  return instance ??= createWallet().catch(error => { instance = undefined; throw error; });
}

async function createWallet(): Promise<LifeguardWallet> {
  const [{ setupWalletSelector, internalActionToNaj }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
    import('@near-wallet-selector/core'), import('@near-wallet-selector/modal-ui'),
    import('@near-wallet-selector/my-near-wallet'), import('@near-wallet-selector/meteor-wallet'),
    import('@near-wallet-selector/modal-ui/styles.css'),
  ]);
  // Omitting createAccessKeyFor and the modal's contractId signs in without a dApp access key.
  const selector = await setupWalletSelector({ network: 'testnet', modules: [setupMyNearWallet(), setupMeteorWallet()] });
  const modal = setupModal(selector, { theme: 'dark' });
  const accountId = () => selector.store.getState().accounts.find(account => account.active)?.accountId || null;
  async function sign(receiverId: string, action: InternalAction) {
    const signerId = accountId();
    if (!signerId) throw new Error('Connect your NEAR wallet first.');
    const result = await (await selector.wallet()).signAndSendTransaction({
      signerId, receiverId, actions: [internalActionToNaj(action)],
    });
    if (result && typeof result.status === 'object' && 'Failure' in result.status) {
      throw new Error(`NEAR transaction failed: ${JSON.stringify(result.status.Failure)}`);
    }
    return result?.transaction.hash || null;
  }
  return {
    accountId,
    subscribe(listener) { const subscription = selector.store.observable.subscribe(listener); return () => subscription.unsubscribe(); },
    async connect() { modal.show(); },
    async disconnect() { await (await selector.wallet()).signOut(); },
    signFunctionCall: ({ receiverId, method, args, gas, deposit }) => sign(receiverId, { type: 'FunctionCall', params: { methodName: method, args, gas, deposit } }),
    async signTransactions(transactions) {
      const signerId = accountId();
      if (!signerId) throw new Error('Connect your NEAR wallet first.');
      const results = await (await selector.wallet()).signAndSendTransactions({
        transactions: transactions.map(({ receiverId, actions }) => ({ signerId, receiverId, actions: actions.map(internalActionToNaj) })),
      });
      for (const result of results || []) {
        if (typeof result.status === 'object' && 'Failure' in result.status) {
          throw new Error(`NEAR transaction failed: ${JSON.stringify(result.status.Failure)}`);
        }
      }
      return results?.map(result => result.transaction.hash) || null;
    },
    addKey: (contract, publicKey) => sign(accountId() || '', {
      type: 'AddKey', params: { publicKey, accessKey: { permission: {
        receiverId: contract, methodNames: ['request_action', 'confirm'], allowance: '1000000000000000000000000',
      } } },
    }),
    deleteKey: publicKey => sign(accountId() || '', { type: 'DeleteKey', params: { publicKey } }),
  };
}
