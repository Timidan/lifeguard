import { useCallback, useEffect, useState } from 'react';
import evidence from './evidence.json';
import { PixelLogo } from './PixelLogo';

type Entry = { nonce: string; tx_hash: string; kind: string; at_ms: string; proven: boolean };
export type Position = {
  contract: string; owner: string; address: string; agentPublicKey: string; nonce: string; pending: string[]; history: Entry[];
  config: { mpc: string; chain_id: string; pool: string; assets: { address: string; approve_cap: string }[]; max_fee_per_gas: string; max_priority_fee_per_gas: string; max_gas_limit: string; max_actions_per_day: number };
  key: { receiver_id: string; method_names: string[]; allowance: string | null } | 'FullAccess';
  loan: { healthFactor: number | null; debtUsd: number; collateralUsd: number };
  attacks: { name: string; detail: string }[];
  readAt: string;
};
type Result = { refused: boolean; layer: string | null; error: string | null; tx: string | null } | { failed: string };

export const NEAR_TX = 'https://testnet.nearblocks.io/txns/';
export const NEAR_ACCOUNT = 'https://testnet.nearblocks.io/address/';
export const BASE_TX = 'https://sepolia.basescan.org/tx/';
export const BASE_ADDRESS = 'https://sepolia.basescan.org/address/';
const ASSETS: Record<string, [string, number]> = {
  '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f': ['USDC', 6],
  '0xd171b9694f7a2597ed006d41f7509aad4b485c4b': ['cbETH', 18],
};
const OWNER_CALLS: Record<string, string> = { '0xc6c3bbe6': 'Mint test tokens', '0xa415bcad': 'Borrow' };
export const rescue = evidence.rescue;

export const num = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const units = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const asset = (a: string) => ASSETS[a.toLowerCase()] ?? [short(a), 0];

/** Reads the loan, the agent key and the contract through the Lifeguard server, every 30 s. */
export function usePosition() {
  const [p, setP] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch('/api/position').then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setP(body); setError(null);
    }).catch((e) => setError(e instanceof Error && e.message ? e.message : 'The server is unreachable.'));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  return { p, error, load };
}

/** The contract records what it signed in plain words; this turns raw amounts and selectors into readable ones. */
function describe(kind: string) {
  let m = kind.match(/^(approve|supply|repay) (\d+) of (0x[0-9a-fA-F]{40})( to the pool)?$/);
  if (m) {
    const [sym, dec] = asset(m[3]);
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${num(units(m[2], dec), 0)} ${sym}${m[4] ? ' to the Pool' : ''}`;
  }
  m = kind.match(/^owner call (0x[0-9a-f]{8}) to (0x[0-9a-fA-F]{40})$/);
  if (m) return OWNER_CALLS[m[1]] ?? `Call ${m[1]} on ${short(m[2])}`;
  return kind;
}

export function ExternalLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 underline decoration-input underline-offset-4 hover:decoration-foreground ${className}`}>
      {children}
      <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden><path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
    </a>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
      aria-label={done ? 'Copied' : `Copy ${text}`} title={done ? 'Copied' : 'Copy'} className="tap grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
        {done ? <path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" /> : <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.5v-1h-8v8h1" fill="none" stroke="currentColor" strokeWidth="1.4" /></>}
      </svg>
    </button>
  );
}

function Chip({ tone, children }: { tone: 'safe' | 'danger' | 'wait' | 'plain'; children: React.ReactNode }) {
  const tones = { safe: 'bg-safe-soft text-safe', danger: 'bg-danger-soft text-danger', wait: 'bg-wait-soft text-wait', plain: 'border text-ink-2' };
  return <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 font-mono text-[0.75rem] font-medium tracking-wide whitespace-nowrap uppercase ${tones[tone]}`}>{children}</span>;
}

export const Dot = ({ className = '' }: { className?: string }) => <span aria-hidden className={`inline-block size-1.5 rounded-full bg-current ${className}`} />;

function Header({ p }: { p: Position | null }) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <a href="/" className="flex items-center gap-2.5 font-mono text-[0.875rem] font-bold tracking-[0.12em]"><PixelLogo cell={3} word={false} />LIFEGUARD</a>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-2 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase sm:inline-flex"><Dot className="text-safe" />NEAR testnet · Base Sepolia</span>
          {p && <ExternalLink href={NEAR_ACCOUNT + p.contract} className="text-[0.8125rem] text-ink-2">Contract</ExternalLink>}
        </div>
      </div>
    </header>
  );
}

function LoanCard({ p, error, retry }: { p: Position | null; error: string | null; retry: () => void }) {
  const hf = p?.loan.healthFactor;
  return (
    <div className="rounded-2xl border bg-card p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono">Health factor</span>
        {p && <span className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground"><Dot className="text-safe" />Live from Aave</span>}
      </div>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="tnum font-mono text-[3.5rem] leading-none font-medium tracking-[-0.04em] text-white">{p ? (hf === null ? 'No debt' : num(hf!, 3)) : '—'}</span>
        <span className="text-[0.8125rem] text-muted-foreground">liquidation below 1.00</span>
      </div>
      <a href="#rescue" className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-safe-soft px-3.5 py-2.5 text-[0.875rem] text-safe hover:brightness-110">
        <span>Rescued by the agent on {rescue.date}</span>
        <span className="tnum font-mono whitespace-nowrap">{rescue.before} → {rescue.after}</span>
      </a>
      {error ? (
        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-wait-soft px-3.5 py-2.5 text-[0.875rem] text-wait">
          <span>Can't read the loan right now. {error}</span>
          <button type="button" onClick={retry} className="tap rounded-full border border-current px-3 py-1 font-medium">Retry</button>
        </div>
      ) : (
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-[0.875rem]">
          <div><dt className="label-mono">Debt</dt><dd className="tnum mt-1.5 font-mono text-[1.0625rem]">{p ? `$${num(p.loan.debtUsd)}` : '—'}</dd></div>
          <div><dt className="label-mono">Collateral</dt><dd className="tnum mt-1.5 font-mono text-[1.0625rem]">{p ? `$${num(p.loan.collateralUsd)}` : '—'}</dd></div>
          <div className="col-span-2">
            <dt className="label-mono">Loan address on Base · key held by NEAR MPC</dt>
            <dd className="mt-1.5 flex items-center gap-1 font-mono text-ink-2">{p ? <><ExternalLink href={BASE_ADDRESS + p.address}>{short(p.address)}</ExternalLink><Copy text={p.address} /></> : '—'}</dd>
          </div>
        </dl>
      )}
      {p && <p className="mt-5 border-t pt-3 text-[0.8125rem] text-muted-foreground">Aave V3 on Base Sepolia · read at {new Date(p.readAt).toLocaleTimeString('en-GB')}</p>}
    </div>
  );
}

function AttackRow({ attack, result, running, onRun }: { attack: { name: string; detail: string }; result?: Result; running: boolean; onRun: () => void }) {
  return (
    <li className={`px-5 py-4 ${result && 'refused' in result ? 'animate-flash' : ''}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">{attack.name}</div>
          <div className="text-[0.875rem] text-muted-foreground">{attack.detail}</div>
        </div>
        {result && 'refused' in result ? (
          result.refused ? <Chip tone="safe"><svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>Refused</Chip> : <Chip tone="danger"><Dot />Signed</Chip>
        ) : (
          <button type="button" onClick={onRun} disabled={running} aria-busy={running}
            className="tap inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-input px-4 text-[0.8125rem] font-medium hover:border-ink-2 disabled:cursor-wait disabled:opacity-70">
            {running && <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {running ? 'Sending' : 'Try it'}
          </button>
        )}
      </div>
      {result && (
        <div className="mt-3 animate-line space-y-2" aria-live="polite">
          {'failed' in result ? (
            <div className="flex flex-wrap items-center gap-2 text-[0.875rem]"><Chip tone="wait"><Dot />Not sent</Chip><span className="text-wait">{result.failed}</span><button type="button" onClick={onRun} className="underline underline-offset-4">Try again</button></div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.875rem]">
                <span className="text-ink-2">{result.refused ? <>Stopped by the <strong className="font-semibold text-foreground">{result.layer}</strong></> : 'The contract signed it. This should never happen.'}</span>
                {result.tx ? <ExternalLink href={NEAR_TX + result.tx} className="text-muted-foreground">Failed transaction</ExternalLink>
                  : result.refused && <span className="text-muted-foreground">Rejected by NEAR before it reached the chain</span>}
              </div>
              {result.error && <p className="rounded-lg border bg-background px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-ink-2">{result.error}</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[0.875rem]">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 text-ink-2">{v}</dd></div>)}
    </dl>
  );
}

function Layers({ p }: { p: Position | null }) {
  const key = p && p.key !== 'FullAccess' ? p.key : null;
  const c = p?.config;
  const code = (s: string) => <code className="font-mono text-[0.8125rem] text-foreground">{s}</code>;
  return (
    <>
      <div className="rounded-2xl border bg-card p-5">
        <div className="label-mono text-safe">Layer 1</div>
        <h3 className="mt-1.5 font-semibold">NEAR's access key</h3>
        <p className="mt-1 mb-4 text-[0.875rem] text-muted-foreground">NEAR itself rejects anything this key isn't allowed to call.</p>
        {key ? <Facts rows={[
          ['May call', <>{key.method_names.map((m, i) => <span key={m}>{i > 0 && ', '}{code(m)}</span>)}</>],
          ['On', code(key.receiver_id)],
          ['Gas budget', key.allowance ? `${num(units(key.allowance, 24), 3)} NEAR left` : 'Unlimited'],
          ['Public key', <span className="flex items-center gap-1 font-mono text-[0.8125rem]">{short(p!.agentPublicKey)}<Copy text={p!.agentPublicKey} /></span>],
        ]} /> : <p className="text-[0.875rem] text-muted-foreground">{p ? 'This key has full access.' : 'Reading the key from NEAR…'}</p>}
      </div>
      <div className="rounded-2xl border bg-card p-5">
        <div className="label-mono text-safe">Layer 2</div>
        <h3 className="mt-1.5 font-semibold">The Lifeguard contract</h3>
        <p className="mt-1 mb-4 text-[0.875rem] text-muted-foreground">It builds every byte of the Base transaction, then asks NEAR's MPC network to sign.</p>
        {c ? <Facts rows={[
          ['Actions', 'Supply, Repay, Approve to the Pool'],
          ['Assets', c.assets.map((a) => { const [sym, dec] = asset(a.address); return `${sym} (approve ≤ ${num(units(a.approve_cap, dec), 0)})`; }).join(', ')],
          ['Fees', `≤ ${units(c.max_fee_per_gas, 9)} gwei, tip ≤ ${units(c.max_priority_fee_per_gas, 9)} gwei, ≤ ${num(Number(c.max_gas_limit), 0)} gas`],
          ['Rate', `${c.max_actions_per_day} actions a day`],
          ['Chain', `Base Sepolia (${c.chain_id}), Aave Pool ${short(c.pool)}`],
        ]} /> : <p className="text-[0.875rem] text-muted-foreground">Reading the contract from NEAR…</p>}
      </div>
    </>
  );
}

function AttackPanel({ p, aside }: { p: Position | null; aside: React.ReactNode }) {
  const [results, setResults] = useState<Record<number, Result>>({});
  const [running, setRunning] = useState<Set<number>>(new Set());
  const attacks = p?.attacks ?? [];

  const run = useCallback(async (i: number) => {
    setRunning((s) => new Set(s).add(i));
    setResults(({ [i]: _, ...rest }) => rest);
    let result: Result;
    try {
      const res = await fetch(`/api/attack/${i}`, { method: 'POST' });
      const body = await res.json();
      result = res.ok ? body : { failed: body.error ?? `The server answered ${res.status}.` };
    } catch {
      result = { failed: "Can't reach the Lifeguard server." };
    }
    setResults((r) => ({ ...r, [i]: result }));
    setRunning((s) => { const n = new Set(s); n.delete(i); return n; });
  }, []);

  const runAll = async () => { for (let i = 0; i < attacks.length; i++) if (!(results[i] && 'refused' in results[i])) await run(i); };
  const refused = Object.values(results).filter((r) => 'refused' in r && r.refused).length;
  const busy = running.size > 0;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[44rem]">
          <div className="label-mono text-safe">Live on testnet</div>
          <h1 className="mt-3 text-[2.25rem] leading-[1.08] font-bold tracking-[-0.035em] sm:text-[2.75rem]">Attack the agent. <em className="font-serif font-normal text-ink-2">Watch it fail.</em></h1>
          <p className="mt-3 text-muted-foreground">These are the requests a compromised or prompt-injected agent would send. Each one goes out with the agent's real NEAR key, now.</p>
        </div>
        <button type="button" onClick={runAll} disabled={busy || !attacks.length}
          className="tap inline-flex h-11 items-center rounded-full bg-safe px-6 text-[0.875rem] font-semibold text-background hover:opacity-90 disabled:opacity-60">
          {busy ? 'Sending…' : `Try all ${attacks.length || 'eight'}`}
        </button>
      </div>
      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <span className="label-mono">Request</span>
            <span className="tnum font-mono text-[0.75rem] text-muted-foreground">{refused} / {attacks.length} refused</span>
          </div>
          {attacks.length ? (
            <ul className="divide-y">{attacks.map((a, i) => <AttackRow key={a.name} attack={a} result={results[i]} running={running.has(i)} onRun={() => run(i)} />)}</ul>
          ) : <p className="px-5 py-8 text-[0.875rem] text-muted-foreground">Loading the attacks…</p>}
        </div>
        <div className="space-y-4">{aside}</div>
      </div>
    </div>
  );
}

function RescueProof() {
  const steps = [
    { title: 'The agent asked, NEAR signed', body: `request_action: ${rescue.action}. The contract built the Base transaction and NEAR's MPC network signed it with chain signatures.`, href: NEAR_TX + rescue.nearSign, link: 'NEAR transaction' },
    { title: 'Aave executed it on Base', body: `Anyone can broadcast the signed transaction. The loan's debt fell from $${num(rescue.debtBefore, 0)} to $${num(rescue.debtAfter, 0)}.`, href: BASE_TX + rescue.baseTx, link: 'Base transaction' },
    { title: 'Read MPC proved it', body: "NEAR's Read MPC confirmed the transaction succeeded on Base. Only then did the loan's nonce advance.", href: NEAR_TX + rescue.nearProof, link: 'Proof on NEAR' },
  ];
  return (
    <section id="rescue" className="scroll-mt-20 border-t py-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[40rem]">
          <div className="label-mono">Recorded on testnet · {rescue.date}</div>
          <h2 className="mt-3 text-[1.875rem] leading-tight font-bold tracking-[-0.03em]">The rescue, <em className="font-serif font-normal text-ink-2">proven on both chains.</em></h2>
        </div>
        <div className="text-right">
          <div className="label-mono">Health factor</div>
          <div className="tnum mt-1.5 font-mono text-[1.75rem] tracking-[-0.03em]"><span className="text-muted-foreground">{rescue.before}</span> → <span className="text-safe">{rescue.after}</span></div>
        </div>
      </div>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col rounded-2xl border bg-card p-6">
            <span className="font-mono text-[2.5rem] leading-none font-bold text-white/[0.06]">0{i + 1}</span>
            <h3 className="mt-3 font-semibold">{s.title}</h3>
            <p className="mt-1.5 flex-1 text-[0.875rem] text-muted-foreground">{s.body}</p>
            <ExternalLink href={s.href} className="mt-4 text-[0.875rem] font-medium text-safe decoration-safe/40">{s.link}</ExternalLink>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Logbook({ p }: { p: Position | null }) {
  const time = (ms: string) => new Date(Number(ms)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  return (
    <section className="border-t py-16">
      <div className="label-mono">Read live from the contract</div>
      <h2 className="mt-3 text-[1.875rem] leading-tight font-bold tracking-[-0.03em]">Logbook</h2>
      <p className="mt-2 text-muted-foreground">Every transaction the contract has signed for this loan{p && <>, from <ExternalLink href={NEAR_ACCOUNT + p.contract} className="font-mono text-[0.8125rem]">{p.contract}</ExternalLink></>}.</p>
      <div className="mt-8 overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full min-w-[44rem] text-[0.875rem]">
          <thead><tr className="border-b text-left">{['Nonce', 'Action', 'Method', 'Base transaction', 'Read MPC', 'Signed'].map((h) => <th key={h} className="label-mono px-5 py-3 font-normal">{h}</th>)}</tr></thead>
          <tbody className="divide-y">
            {p ? [...p.history].reverse().map((e) => {
              const pending = p.pending.includes(e.tx_hash);
              return (
                <tr key={e.tx_hash} className={e.proven ? '' : 'text-muted-foreground'}>
                  <td className="tnum px-5 py-3 font-mono">{e.nonce}</td>
                  <td className="px-5 py-3">{describe(e.kind)}</td>
                  <td className="px-5 py-3"><code className="font-mono text-[0.8125rem] text-ink-2">{e.kind.startsWith('owner call') ? 'owner_action' : 'request_action'}</code></td>
                  <td className="px-5 py-3 font-mono">{e.proven || pending ? <ExternalLink href={BASE_TX + e.tx_hash}>{short(e.tx_hash)}</ExternalLink> : short(e.tx_hash)}</td>
                  <td className="px-5 py-3">{e.proven ? <Chip tone="safe"><Dot />Proven</Chip> : pending ? <Chip tone="wait"><Dot />Awaiting</Chip> : <Chip tone="plain">Not proven</Chip>}</td>
                  <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">{time(e.at_ms)}</td>
                </tr>
              );
            }) : <tr><td colSpan={6} className="px-5 py-8 text-muted-foreground">Reading the contract…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AppPage() {
  const { p, error, load } = usePosition();
  return (
    <>
      <Header p={p} />
      <main className="mx-auto max-w-6xl px-4">
        <section className="py-12">
          <AttackPanel p={p} aside={<><LoanCard p={p} error={error} retry={load} /><Layers p={p} /></>} />
        </section>
        <RescueProof />
        <Logbook p={p} />
        <footer className="flex flex-wrap justify-between gap-4 border-t py-10 font-mono text-[0.6875rem] tracking-[0.12em] text-faint uppercase">
          <span>Testnet only · no real funds</span><span>Built for NEAR HACKATHON · MIT</span>
        </footer>
      </main>
    </>
  );
}
