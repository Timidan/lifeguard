import { useCallback, useEffect, useRef, useState } from 'react';
import evidence from './evidence.json';
import { Mark } from './Logos';
import { LoanPicture } from './LoanPicture';
import { getWallet, walletReturn, type FunctionCall, type LifeguardWallet, type WalletTransaction } from './wallet';

type Entry = { nonce: string; tx_hash: string; kind: string; by: string; at_ms: string; proven: boolean };
type Relay = { state: 'starting' | 'mining' | 'safe' | 'confirming' | 'done' | 'reverted' | 'failed'; tx: string | null; error?: string | null; nearProof?: string };
type Setup = { state: 'working' | 'waiting' | 'done' | 'failed'; step: 'gas' | 'mint' | 'approveCollateral' | 'supply' | 'confirm' | 'approveRepay' | 'borrow' | null; error: string | null };
type OwnerPositions = { positions: number[]; keeperKey: boolean; keeperPublicKey: string; contract: string };
export type Position = {
  contract: string; owner: string; position: number; address: string; agentPublicKey: string; nonce: string; pending: string[]; history: Entry[];
  config: { mpc: string; chain_id: string; pool: string; assets: { address: string; approve_cap: string }[]; max_fee_per_gas: string; max_priority_fee_per_gas: string; max_gas_limit: string; max_actions_per_day: number };
  key: { receiver_id: string; method_names: string[]; allowance: string | null } | 'FullAccess';
  agents: { publicKey: string; methods: string[]; allowance: string | null; keeper: boolean }[];
  loan: { healthFactor: number | null; debtUsd: number; collateralUsd: number; eth: number; usdc: number; usdcAllowance: number; cbeth: number; cbethAllowance: number };
  relay: Relay | null;
  setup: Setup | null;
  attacks: { name: string; short: string; detail: string }[];
  feed: { sent: number; refused: number; recent?: { name: string; refused: boolean; layer: string | null; tx: string | null }[] };
  readAt: string;
};
type LoanPosition = Omit<Position, 'loan'> & { loan: Position['loan'] | null };
export type Result = { refused: boolean; layer: string | null; error: string | null; tx: string | null } | { failed: string };

async function api<T>(url: string, method = 'GET'): Promise<T> {
  const response = await fetch(url, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `The server answered ${response.status}.`);
  return body;
}
const message = (error: unknown) => error instanceof Error ? error.message : "Can't reach Lifeguard. Try again.";

/** Kept for the landing page's interactive illustration. */
export async function sendAttack(i: number): Promise<Result> {
  try { return await api<Result>(`/api/attack/${i}`, 'POST'); }
  catch (error) { return { failed: message(error) }; }
}
export const NEAR_TX = 'https://testnet.nearblocks.io/txns/';
export const NEAR_ACCOUNT = 'https://testnet.nearblocks.io/address/';
export const BASE_TX = 'https://sepolia.basescan.org/tx/';
export const BASE_ADDRESS = 'https://sepolia.basescan.org/address/';
export const rescue = evidence.rescue;
export const num = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const units = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const ASSETS: Record<string, [string, number]> = {
  '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f': ['USDC', 6],
  '0xd171b9694f7a2597ed006d41f7509aad4b485c4b': ['cbETH', 18],
};
function describe(kind: string) {
  const match = kind.match(/^(approve|supply|repay) (\d+) of (0x[0-9a-fA-F]{40})( to the pool)?$/);
  if (match) {
    const [symbol, decimals] = ASSETS[match[3].toLowerCase()] ?? [short(match[3]), 0];
    return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${num(units(match[2], decimals), 0)} ${symbol}${match[4] ? ' for Aave' : ''}`;
  }
  if (kind.startsWith('owner call 0xc6c3bbe6 ')) return 'Get test tokens';
  if (kind.startsWith('owner call 0xa415bcad ')) return 'Borrow USDC';
  if (kind.startsWith('owner call 0x to ')) return 'Send Base ETH';
  if (kind.startsWith('owner call ')) return 'Owner transaction';
  return kind;
}

function useLoanPosition(id: number | null, interval = 5000) {
  const [data, setData] = useState<LoanPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentId = useRef(id); currentId.current = id;
  const load = useCallback(async () => {
    if (id === null) return;
    try {
      const next = await api<LoanPosition>(`/api/position?id=${id}`);
      if (currentId.current === id) { setData(next); setError(null); }
    } catch (error) { if (currentId.current === id) setError(message(error)); }
  }, [id]);
  useEffect(() => { setData(null); setError(null); void load(); const timer = setInterval(load, interval); return () => clearInterval(timer); }, [load, interval]);
  return { p: data?.position === id ? data : null, error, load };
}
/** The landing page reads the test loan without needing a wallet. */
export function usePosition() {
  const { p, ...rest } = useLoanPosition(0, 30000);
  return { ...rest, p: p?.loan ? { ...p, loan: p.loan } : null };
}

export function ExternalLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 underline decoration-input underline-offset-4 hover:decoration-foreground ${className}`}>
    {children}<svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden><path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
  </a>;
}
const button = 'tap inline-flex min-h-11 items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primary = 'tap flex min-h-13 w-full items-center justify-between gap-3 rounded-sm bg-safe px-4 py-3 text-left font-medium text-background hover:bg-safe/85 disabled:cursor-not-allowed disabled:opacity-50';
function Header({ account, disconnect }: { account?: string | null; disconnect?: () => void }) {
  return <header className="border-b">
    <div className="mx-auto flex min-h-16 max-w-[69rem] items-center justify-between gap-3 px-4 py-2">
      <a href="/" className="flex min-h-11 shrink-0 items-center gap-2.5 font-semibold"><Mark />Lifeguard</a>
      {account && <div className="flex min-w-0 items-center gap-3 text-sm"><span className="hidden truncate text-muted-foreground sm:block">{account}</span><button className={button} onClick={disconnect}>Disconnect</button></div>}
    </div>
  </header>;
}
function Command({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return <div className="mt-2 border-l-2 border-input pl-3">
    {value ? <><code className="block [overflow-wrap:anywhere] font-mono text-[0.8125rem] leading-relaxed text-ink-2">{value}</code>
      <button className="tap mt-1 min-h-11 px-2 text-sm underline decoration-input underline-offset-4" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); } catch { setError(true); }
      }}>{copied ? 'Copied' : 'Copy command'}</button>{error && <p role="alert" className="text-sm text-danger">Copy the command above manually.</p>}</>
      : <p className="py-2 text-sm text-muted-foreground">Open your position to get this command.</p>}
  </div>;
}
const STEPS = ['Connect wallet', 'Open loan', 'Add collateral', 'Borrow USDC', 'Turn on repayments'];
const setupWords = {
  gas: ['Sending Base gas', 'Base gas funding failed', 8],
  mint: ['Getting 1 test cbETH', 'Getting test cbETH failed', 7],
  approveCollateral: ['Approving cbETH for Aave', 'cbETH approval failed', 6],
  supply: ['Supplying 1 cbETH', 'Supplying cbETH failed', 3],
  confirm: ['Waiting for Read MPC to confirm', 'Read MPC confirmation failed', 3],
  approveRepay: ['Approving USDC for repayments', 'USDC approval failed', 2],
  borrow: ['Sending your borrow to Base', 'Borrowing failed', 5],
} as const;
function relayWords(relay: Relay | null | undefined) {
  switch (relay?.state) {
    case 'starting': case 'mining': return 'Sending to Base';
    case 'safe': return 'Waiting for Base to finalise';
    case 'confirming': return 'Read MPC is confirming';
    case 'reverted': return `Transaction reverted${relay.error ? `: ${relay.error}` : ' on Base.'}`;
    case 'failed': return `Transaction failed: ${relay.error || 'The relay could not finish.'}`;
    default: return null;
  }
}
function Activity({ p }: { p: LoanPosition | null }) {
  return <ul className="mt-4 divide-y border-y" aria-label="Loan activity">
    {p?.history.length ? [...p.history].reverse().map(entry => <li key={entry.tx_hash} className="grid gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-8">
      <p>{describe(entry.kind)}</p>
      <div className="flex flex-wrap gap-x-4 text-sm text-muted-foreground"><span className={entry.proven ? 'text-safe' : ''}>{entry.proven ? 'Verified by Read MPC' : 'Not verified by Read MPC'}</span><time dateTime={new Date(Number(entry.at_ms)).toISOString()}>{new Date(Number(entry.at_ms)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><ExternalLink href={BASE_TX + entry.tx_hash} className="min-h-11 text-sm sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:self-center">Base transaction</ExternalLink>
    </li>) : <li className="py-5 text-muted-foreground">{p ? 'No transactions signed for this loan yet.' : 'Finding the loan.'}</li>}
  </ul>;
}
function Health({ loan }: { loan: Position['loan'] | null | undefined }) {
  const hf = loan?.healthFactor ?? null;
  return <>
    <p data-health className={`tnum font-serif text-7xl tracking-tight ${!loan ? 'text-muted-foreground' : hf !== null && hf < 1.25 ? 'text-wait' : 'text-safe'}`}>{!loan ? '—' : hf === null ? 'No debt' : num(hf)}</p>
    <dl className="mt-5 grid gap-3">
      <div className="flex justify-between gap-3"><dt className="text-ink-2">Debt</dt><dd data-debt className="tnum">{loan ? `$${num(loan.debtUsd)}` : '—'}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-ink-2">Collateral</dt><dd className="tnum">{loan ? `$${num(loan.collateralUsd)}` : '—'}</dd></div>
    </dl>
  </>;
}
const arrow = <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M4 12h15m-6-6 6 6-6 6" /></svg>;
const card = 'relative mx-auto w-full max-w-[32rem] border bg-card px-6 pt-9 pb-7 sm:px-8';
const sideBySide = 'mt-8 grid items-center gap-8 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:gap-16';

function AttackRow({ attack, i }: { attack: { name: string; detail: string }; i: number }) {
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  const send = async () => { setSending(true); setResult(await sendAttack(i)); setSending(false); };
  return <li className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-8">
    <div><p>{attack.name}</p><p className="mt-1 text-sm text-muted-foreground">{attack.detail}</p>
      {result && <div aria-live="polite" className="mt-2 text-sm">{'failed' in result ? <p className="text-danger">Not sent: {result.failed}</p> : <>
        <p className={result.refused ? 'text-safe' : 'text-danger'}>{result.refused ? `Refused by the ${result.layer === 'NEAR access key' ? 'access key' : 'contract'}` : 'The contract signed it. This should never happen.'}</p>
        {result.error && <p className="mt-1 font-mono text-xs leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{result.error}</p>}
        {result.tx && <ExternalLink href={NEAR_TX + result.tx} className="min-h-11 text-muted-foreground">Failed transaction on NEAR</ExternalLink>}</>}</div>}
    </div>
    <button className={button + ' self-start'} disabled={sending} onClick={() => void send()}>{sending ? 'Sending…' : result ? 'Send again' : "Send with the agent's key"}</button>
  </li>;
}
function TestLoan() {
  const { p, error, load } = useLoanPosition(0);
  return <><Header /><main className="mx-auto max-w-[74rem] px-4 pb-10 sm:px-6">
    <section aria-labelledby="loan-heading" className="py-10 sm:py-14">
      <h1 id="loan-heading" className="text-4xl">Lifeguard's test loan</h1>
      <div className={sideBySide}>
        <section aria-labelledby="step-name" className={card}>
          <h2 id="step-name" className="font-sans text-base tracking-normal text-ink-2">Health factor</h2>
          {error && <p role="alert" className="mt-3 [overflow-wrap:anywhere] text-danger">{error}</p>}
          <Health loan={p?.loan} />
          <div className="mt-9">
            {error ? <button className={primary} onClick={() => void load()}>Try again{arrow}</button>
              : <a href="/app" className={primary}>Set up your own loan{arrow}</a>}
          </div>
        </section>
        <div className="mx-auto w-full max-w-[36rem] lg:max-w-none"><LoanPicture step={5} failed={false} debt={p?.loan?.debtUsd ?? null} wallet="Owner" /></div>
      </div>
    </section>
    <section aria-labelledby="attacks-heading" className="border-t py-10 sm:py-14"><h2 id="attacks-heading" className="text-3xl sm:text-4xl">What its agent can't do</h2><ul aria-label="Eight attacks" className="mt-6 divide-y border-y">{p?.attacks.map((attack, i) => <AttackRow key={attack.name} attack={attack} i={i} />)}</ul></section>
    <section aria-labelledby="activity-heading" className="border-t py-10 sm:py-14"><h2 id="activity-heading" className="text-3xl sm:text-4xl">Activity</h2><Activity p={p} /></section>
  </main></>;
}

function OwnerApp() {
  const [wallet, setWallet] = useState<LifeguardWallet | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [ownerPositions, setOwnerPositions] = useState<(OwnerPositions & { owner: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [startingSetup, setStartingSetup] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [ownKey, setOwnKey] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [localRelay, setLocalRelay] = useState<Relay | null>(null);
  const relayAttempt = useRef('');
  const setupAttempt = useRef('');
  const returnedStep = useRef<{ account: string; step: number } | null>(null);
  const lock = useRef(false);
  const owner = ownerPositions?.owner === account ? ownerPositions : null;
  const id = owner?.positions.at(-1) ?? null;
  const { p: position, error: readError, load } = useLoanPosition(id);
  const p = position?.owner === account ? position : null;
  const looking = !!account && (!owner || (id !== null && !p));
  const step = !account ? 1 : !p ? 2 : !p.loan?.collateralUsd ? 3 : !p.loan.debtUsd ? 4 : !p.loan.usdcAllowance ? 5 : 6;
  const ready = step === 6;
  const setup = p?.setup;
  const setupWorking = setup?.state === 'working' || startingSetup;
  const setupFailed = setup?.state === 'failed' || !!setupError;
  const relay = localRelay || p?.relay;
  const relayActive = !!relay && !['done', 'failed', 'reverted'].includes(relay.state);
  const inFlight = !!p?.pending.length || relayActive || waiting !== null;
  const own = p?.agents.filter(agent => !agent.keeper && agent.publicKey !== p.agentPublicKey) ?? []; // Lifeguard's agent has its own card
  const keeperGiven = p ? p.agents.some(agent => agent.keeper || agent.publicKey === p.agentPublicKey) : !!owner?.keeperKey;
  const actionsDisabled = !p || !!busy || !!readError || looking;
  const ownKeyGiven = !!p?.agents.some(agent => agent.publicKey === ownKey.trim());

  useEffect(() => {
    let active = true, unsubscribe: (() => void) | undefined;
    const returned = walletReturn();
    if (returned.error) setError(`Wallet declined the transaction: ${returned.error}`);
    if (returned.hash) returnedStep.current = JSON.parse(sessionStorage.getItem('lifeguard:step') || 'null');
    sessionStorage.removeItem('lifeguard:step');
    getWallet().then(adapter => {
      if (!active) return;
      setWallet(adapter); setAccount(adapter.accountId());
      unsubscribe = adapter.subscribe(() => setAccount(adapter.accountId()));
    }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    setOwnerPositions(null); setLocalRelay(null); setSetupError(null); setLookupError(null);
    relayAttempt.current = ''; setupAttempt.current = '';
    setWaiting(returnedStep.current?.account === account ? returnedStep.current.step : null);
    if (account) returnedStep.current = null;
  }, [account]);
  useEffect(() => {
    let active = true;
    if (!account) return;
    const lookup = async () => {
      try {
        const result = await api<OwnerPositions>(`/api/positions?owner=${encodeURIComponent(account)}`);
        if (active) { setOwnerPositions({ ...result, owner: account }); setLookupError(null); }
      } catch (error) { if (active) setLookupError(message(error)); }
    };
    void lookup(); const timer = setInterval(lookup, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [account, refresh]);
  useEffect(() => {
    if (p?.relay && (localRelay?.state !== 'failed' || !['done', 'failed', 'reverted'].includes(p.relay.state))) setLocalRelay(null);
    if ((waiting === 1 && p) || (waiting === 6 && p?.loan?.debtUsd) ||
      (waiting === 8 && p?.relay?.state === 'done' && !p.pending.length)) setWaiting(null);
  }, [p, waiting]);

  async function startSetup() {
    if (id === null) return;
    setSetupError(null); setStartingSetup(true);
    try { await api<Setup>(`/api/setup/${id}`, 'POST'); await load(); }
    catch (error) { setSetupError(message(error)); }
    finally { setStartingSetup(false); }
  }
  useEffect(() => {
    if (!p?.loan || ready || busy || readError || lookupError || setupWorking || setupFailed) return;
    // Resume once per chain state, including after a reload or wallet redirect.
    const token = `${p.position}:${step}:${p.nonce}:${p.pending.join(',')}`;
    if (setupAttempt.current === token) return;
    setupAttempt.current = token;
    void startSetup();
  }, [p, ready, busy, readError, lookupError, setupWorking, setupFailed]);

  async function startRelay() {
    if (id === null) return;
    setLocalRelay(await api<Relay>(`/api/relay/${id}`, 'POST'));
    await load();
  }
  useEffect(() => {
    if (!ready || !p?.pending.length || relayActive || ['failed', 'reverted'].includes(relay?.state || '')) return;
    const token = `${p.position}:${p.pending[0]}`;
    if (relayAttempt.current === token) return;
    relayAttempt.current = token;
    void startRelay().catch(error => setLocalRelay({ state: 'failed', tx: p.pending[0], error: message(error) }));
  }, [p, ready, relayActive]);

  async function act(name: string, run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(name); setError(null);
    try { await run(); } catch (error) { setError(message(error)); setWaiting(null); }
    finally { lock.current = false; setBusy(null); }
  }
  async function signStep(step: 1 | 6 | 8) {
    if (!wallet || !account || !owner || (step !== 1 && !p)) return;
    const call = await api<FunctionCall>(`/api/step/${step === 1 ? 'new/open' : `${id}/${step === 8 ? 'risk' : 'borrow?usdc=1000'}`}`);
    sessionStorage.setItem('lifeguard:step', JSON.stringify({ account, step }));
    setBusy('wallet');
    let hash: string | null;
    try {
      if (step === 1) {
        const transactions: WalletTransaction[] = [{ receiverId: call.receiverId, actions: [{ type: 'FunctionCall', params: { methodName: call.method, args: call.args, gas: call.gas, deposit: call.deposit } }] }];
        if (!owner.keeperKey) transactions.push({ receiverId: account, actions: [{ type: 'AddKey', params: { publicKey: owner.keeperPublicKey, accessKey: { permission: {
          receiverId: owner.contract, methodNames: ['request_action', 'confirm'], allowance: '1000000000000000000000000',
        } } } }] });
        hash = (await wallet.signTransactions(transactions))?.[0] || null;
      } else hash = await wallet.signFunctionCall(call);
    } catch (error) { sessionStorage.removeItem('lifeguard:step'); setRefresh(value => value + 1); throw error; }
    if (!hash) return; // Redirects resume from the returned intent and the chain.
    sessionStorage.removeItem('lifeguard:step');
    setWaiting(step); setBusy('confirming');
    if (step === 1) setRefresh(value => value + 1);
    else if (step === 6) await startSetup();
    else {
      try { await startRelay(); }
      catch (error) { setLocalRelay({ state: 'failed', tx: null, error: message(error) }); }
    }
  }
  function runPhase() {
    void act('setup', async () => {
      if (step === 1) { const adapter = wallet || await getWallet(); setWallet(adapter); await adapter.connect(); setAccount(adapter.accountId()); }
      else if (p && (setupFailed || step !== 4)) await startSetup();
      else await signStep(step === 2 ? 1 : 6);
    });
  }
  const setupStep = setup?.step ? setupWords[setup.step] : null;
  const workingStep = setup?.state === 'working' ? setupStep : null;
  const problem = error || readError || lookupError;
  const stopped = !ready && setupFailed && !startingSetup;
  const failure = problem || (stopped ? setupError || setup?.error || 'Lifeguard could not finish.' : null)
    || (ready && ['failed', 'reverted'].includes(relay?.state || '') ? relayWords(relay) : null);
  const status = busy === 'wallet' ? 'Approve in your wallet'
    : looking || (p && !p.loan) ? 'Finding your loan'
    : ready ? inFlight ? relayWords(relay) || 'Waiting for the loan to update' : null
    : setupWorking || inFlight ? workingStep?.[0] || (waiting === 1 ? 'Opening your loan' : waiting === 6 || p?.pending.length ? 'Waiting for Read MPC to confirm' : 'Checking your loan')
    : null;
  const title = ready ? 'Health factor' : stopped && !problem ? setupStep?.[1] || 'Setup stopped' : STEPS[step - 1];
  const detail = failure ?? (status === 'Approve in your wallet' ? ['', '0.05 NEAR', '', '1,000 USDC', ''][step - 1]
    : status && !ready && status !== 'Finding your loan' ? `About ${workingStep?.[2] ?? (step === 2 ? 8 : 5)} minutes left`
    : ['NEAR testnet', '0.05 NEAR · 1 wallet approval', '', '1 wallet approval', ''][step - 1]);
  const action: [string, () => void] | null = failure
    ? problem ? ['Try again', () => { setError(null); setRefresh(value => value + 1); void load(); }]
      : stopped ? ['Try again', runPhase]
      : relay?.state === 'failed' ? ['Try again', () => void act('Retry relay', startRelay)] : null
    : status ? null
    : ready ? ['Borrow until the health factor is 1.2', () => void act('Borrow more', () => signStep(8))]
    : [['Connect wallet', 'Open loan', 'Continue setup', 'Borrow 1,000 USDC', 'Continue setup'][step - 1], runPhase];
  const done = ready ? 5 : step - 1;
  const loan = p?.loan;

  return <><Header account={account} disconnect={() => void act('Disconnect', async () => { await wallet?.disconnect(); setAccount(null); })} />
    <main className="mx-auto max-w-[74rem] px-4 pb-10 sm:px-6">
      <section aria-labelledby="setup-heading" className="py-10 sm:py-14">
        <h1 id="setup-heading" className="text-4xl">{ready ? 'Your loan' : 'Set up your loan'}</h1>
        <div className={sideBySide}>
          <section aria-labelledby="step-name" className={card}>
            {!ready && <div role="progressbar" aria-label="Loan setup" aria-valuemin={0} aria-valuemax={5} aria-valuenow={done} aria-valuetext={`Step ${step} of 5: ${title}`} className="absolute -inset-x-px -top-px h-[3px] bg-border">
              <span className={`block h-full ${failure ? 'bg-danger' : 'bg-safe'}`} style={{ width: `${done * 20}%` }} />
            </div>}
            <div className="flex items-baseline justify-between gap-3"><h2 id="step-name" className={ready ? 'font-sans text-base tracking-normal text-ink-2' : 'text-3xl'}>{title}</h2>{!ready && <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden>{step} / 5</span>}</div>
            {detail && <p className={`mt-3 [overflow-wrap:anywhere] ${failure ? 'text-danger' : 'text-ink-2'}`}>{detail}</p>}
            {ready && loan && <Health loan={loan} />}
            <div aria-live="polite" aria-atomic className="mt-9">
              {action ? <button className={primary} disabled={!!busy || (step === 1 && !wallet)} onClick={action[1]}>{action[0]}{arrow}</button>
                : status && <p role="status" className="flex min-h-13 items-center gap-3 border-t pt-4"><svg viewBox="0 0 24 24" className="size-5 shrink-0 text-safe" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M7 3h10M7 21h10M8 3v5l4 4-4 4v5m8-18v5l-4 4 4 4v5" /></svg>{status}</p>}
            </div>
          </section>
          <div className="mx-auto w-full max-w-[36rem] lg:max-w-none"><LoanPicture step={done} failed={!!failure && !ready} debt={loan?.debtUsd ?? null} /></div>
        </div>
      </section>
      {ready && <><section aria-labelledby="agents-heading" className="border-t py-10 sm:py-14">
        <h2 id="agents-heading" className="text-3xl sm:text-4xl">Your agents</h2>
        <div className="mt-7 grid border-y bg-card md:grid-cols-2">
          <article aria-labelledby="keeper-heading" className="min-w-0 border-b p-5 sm:p-7 md:border-r md:border-b-0">
            <h3 id="keeper-heading" className="text-2xl">Lifeguard's agent</h3><p className="mt-4 max-w-md text-ink-2">Steps in below health factor 1.25 and repays to 1.9, or up to 25% more if it is falling fast. A model on NEAR AI reads the trend.</p>
            {keeperGiven && <p className="mt-5 text-sm text-safe">Key given</p>}
            <button className={button + ' mt-5'} disabled={actionsDisabled} onClick={() => void act(keeperGiven ? 'Revoke key' : 'Give a key', async () => {
              if (keeperGiven) await wallet!.deleteKey(p!.agentPublicKey);
              else await wallet!.addKey(p!.contract, p!.agentPublicKey);
              setRefresh(value => value + 1); await load();
            })}>{keeperGiven ? 'Revoke' : 'Give it a key'}</button>
          </article>
          <article aria-labelledby="mcp-heading" className="min-w-0 p-5 sm:p-7"><h3 id="mcp-heading" className="text-2xl">Your own agent, over MCP</h3>
            <ol className="mt-5 space-y-5">
              <li><p>1. Create a key. This prints its public key.</p><Command value={p ? `node agent/mcp.js init ${p.position} ${p.contract}` : null} /></li>
              <li><label htmlFor="agent-key">2. Give that public key access.</label><input id="agent-key" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm" placeholder="ed25519:…" value={ownKey} onChange={event => setOwnKey(event.target.value)} disabled={!p} spellCheck={false} autoComplete="off" />
                <button className={button + ' mt-3'} disabled={actionsDisabled || !ownKey.trim() || ownKeyGiven} onClick={() => void act('Give a key', async () => { await wallet!.addKey(p!.contract, ownKey.trim()); setOwnKey(''); await load(); })}>{ownKeyGiven ? 'Key given' : 'Give it a key'}</button></li>
              <li><p>3. Connect your MCP client.</p><Command value={p ? `claude mcp add lifeguard -e LIFEGUARD_STATE=$HOME/.lifeguard/${p.contract}-${p.position}.json -- node agent/mcp.js` : null} /></li>
            </ol>
          </article>
        </div>
        {own.length > 0 && <><h3 className="mt-8 text-2xl">Your agents' keys</h3>
        <ul aria-label="Agent keys" className="mt-4 divide-y border-y">{own.map(agent => <li key={agent.publicKey} className="flex items-center justify-between gap-4 py-4"><div className="min-w-0"><p className="font-mono">{short(agent.publicKey)}</p><p className="mt-1 break-words text-sm text-muted-foreground">May call <span className="font-mono">{agent.methods.join(', ') || 'any method'}</span></p></div><button className={button} disabled={actionsDisabled} onClick={() => void act('Revoke key', async () => { await wallet!.deleteKey(agent.publicKey); setRefresh(value => value + 1); await load(); })}>Revoke</button></li>)}</ul></>}
      </section>
      <section aria-labelledby="activity-heading" className="border-t py-10 sm:py-14"><h2 id="activity-heading" className="text-3xl sm:text-4xl">Activity</h2><Activity p={p} /></section></>}
    </main>
  </>;
}
export function AppPage() {
  return new URLSearchParams(window.location.search).get('position') === '0' ? <TestLoan /> : <OwnerApp />;
}
