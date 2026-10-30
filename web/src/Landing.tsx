import { useEffect, useState } from 'react';
import { PixelLogo } from './PixelLogo';
import { BASE_ADDRESS, BASE_TX, Dot, ExternalLink, NEAR_ACCOUNT, NEAR_TX, num, rescue, sendAttack, short, usePosition, type Position, type Result } from './App';

/** Where a request goes. A refused one stops at the layer that refused it; the rescue goes all the way. */
const STAGES = [
  { label: 'Agent', sub: 'NEAR function-call key' },
  { label: 'NEAR access key', sub: 'checks what the key may call' },
  { label: 'Lifeguard contract', sub: 'builds the Base transaction' },
  { label: 'NEAR MPC', sub: 'chain signature' },
  { label: 'Aave on Base', sub: 'executes' },
  { label: 'Read MPC', sub: 'proves it succeeded' },
];
type Stage = 'idle' | 'active' | 'pass' | 'stop' | 'skip';
type Outcome = { kind: 'repay' } | { kind: 'attack'; name: string; result: Result; ms: number };
const REPAY = -1; // the recorded rescue, replayed through the same view
const idle = (): Stage[] => STAGES.map(() => 'idle');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Pipeline({ states }: { states: Stage[] }) {
  const node = { idle: 'border-border text-faint', active: 'animate-pulse border-safe/70 text-safe', pass: 'border-safe bg-safe-soft text-safe', stop: 'border-danger bg-danger-soft text-danger', skip: 'border-dashed border-border text-faint opacity-40' };
  return (
    <ol className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-x-0">
      {STAGES.map((s, i) => (
        <li key={s.label} className="relative flex items-start gap-3 lg:flex-col lg:gap-3 lg:pr-4">
          {i < STAGES.length - 1 && <span aria-hidden className={`absolute top-[1.125rem] left-11 hidden h-px w-[calc(100%-2.75rem)] transition-colors duration-300 lg:block ${states[i] === 'pass' ? 'bg-safe/60' : 'bg-border'}`} />}
          <span className={`relative grid size-9 shrink-0 place-items-center rounded-xl border bg-card font-mono text-[0.8125rem] transition-colors duration-300 ${node[states[i]]}`}>
            {states[i] === 'pass' ? '✓' : states[i] === 'stop' ? '✕' : i + 1}
          </span>
          <span className={`min-w-0 transition-opacity duration-300 ${states[i] === 'skip' ? 'opacity-40' : ''}`}>
            <span className={`block text-[0.875rem] font-medium ${states[i] === 'stop' ? 'text-danger' : ''}`}>{s.label}</span>
            <span className="block text-[0.75rem] leading-snug text-muted-foreground">{s.sub}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The hero: pick what the agent tries, send it with the agent's real key, and watch where it stops. */
function LiveConsole({ p }: { p: Position | null }) {
  const attacks = p?.attacks ?? [];
  const [pick, setPick] = useState(REPAY);
  const [states, setStates] = useState<Stage[]>(idle);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const [extra, setExtra] = useState({ sent: 0, refused: 0 });
  const still = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function walk(stopAt: number | null, pace: number) {
    for (let i = 0; i < STAGES.length; i++) {
      if (stopAt !== null && i > stopAt) { setStates((st) => st.map((v, j) => (j > stopAt ? 'skip' : v))); return; }
      setStates((st) => st.map((v, j) => (j === i ? 'active' : v)));
      if (!still) await sleep(pace);
      setStates((st) => st.map((v, j) => (j === i ? (i === stopAt ? 'stop' : 'pass') : v)));
    }
  }

  async function send(which = pick) {
    setBusy(true); setOut(null); setStates(idle());
    if (which === REPAY) {
      await walk(null, 420);
      setOut({ kind: 'repay' });
    } else {
      setStates((st) => st.map((v, j) => (j === 0 ? 'active' : v)));
      const t0 = performance.now();
      const result = await sendAttack(which);
      const ms = performance.now() - t0;
      if ('failed' in result) setStates(idle());
      else {
        await walk(result.refused ? (result.layer === 'NEAR access key' ? 1 : 2) : 3, 260);
        setExtra((e) => ({ sent: e.sent + 1, refused: e.refused + (result.refused ? 1 : 0) }));
      }
      setOut({ kind: 'attack', name: attacks[which].short, result, ms });
    }
    setBusy(false);
  }

  // Replay the rescue once on arrival, so the outcome is on screen before anyone clicks.
  useEffect(() => { const t = setTimeout(() => send(REPAY), 1200); return () => clearTimeout(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chip = (selected: boolean) => `tap inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] whitespace-nowrap disabled:opacity-60 ${selected ? 'border-foreground bg-foreground font-medium text-background' : 'text-ink-2 hover:border-input hover:text-foreground'}`;
  const totals = p ? { sent: p.feed.sent + extra.sent, refused: p.feed.refused + extra.refused } : null;

  return (
    <div id="console" className="w-full max-w-[66rem] scroll-mt-24 overflow-hidden rounded-3xl border bg-card/95 text-left shadow-[0_40px_120px_-40px_rgb(16_185_129/0.25)] backdrop-blur">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <span className="flex items-center gap-3">
          <span className="flex gap-1.5" aria-hidden>{['#ef4444', '#f59e0b', '#22c55e'].map((c) => <span key={c} className="size-2 rounded-full" style={{ background: c }} />)}</span>
          <span className="font-mono text-[0.75rem] text-muted-foreground">agent console</span>
        </span>
        <span className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase"><Dot className="animate-pulse text-safe" />Live · NEAR testnet</span>
      </div>

      <div className="space-y-6 p-5 sm:p-7">
        <div>
          <div className="label-mono">What the agent tries</div>
          <div role="radiogroup" aria-label="Request" className="mt-3 flex flex-wrap gap-2">
            <button type="button" role="radio" aria-checked={pick === REPAY} disabled={busy} onClick={() => setPick(REPAY)} className={chip(pick === REPAY)}>
              Repay 1,000 USDC <span className={`font-mono text-[0.6875rem] ${pick === REPAY ? 'text-background/70' : 'text-safe'}`}>recorded</span>
            </button>
            {attacks.map((a, i) => (
              <button key={a.name} type="button" role="radio" aria-checked={pick === i} title={a.detail} disabled={busy} onClick={() => setPick(i)} className={chip(pick === i)}>{a.short}</button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={() => send()} disabled={busy || (pick !== REPAY && !attacks.length)}
            className="tap inline-flex h-11 items-center gap-2 rounded-full bg-safe px-6 text-[0.875rem] font-semibold text-background hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
            {busy && <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {pick === REPAY ? 'Replay the rescue' : busy ? 'Sending…' : "Send with the agent's key"}
          </button>
          <span className="text-[0.8125rem] text-muted-foreground">{pick === REPAY ? `Recorded on testnet, ${rescue.date}.` : 'Sent live to NEAR testnet with the real key. The server holds it, not your browser.'}</span>
        </div>

        <div className="rounded-2xl border bg-background/60 p-5"><Pipeline states={states} /></div>

        <div className="min-h-[5.5rem]" aria-live="polite">
          {!out && <p className="text-[0.875rem] text-muted-foreground">{busy ? (pick === REPAY ? 'Replaying the recorded rescue…' : "Sending with the agent's key…") : 'Pick a request and send it.'}</p>}
          {out?.kind === 'repay' && (
            <div className="animate-line space-y-2">
              <p className="text-[0.9375rem]"><span className="text-safe">✓ Signed, executed and proven.</span> <span className="text-ink-2">Health factor</span> <span className="tnum font-mono text-white">{rescue.before} → {rescue.after}</span></p>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
                <ExternalLink href={NEAR_TX + rescue.nearSign}>Signed on NEAR</ExternalLink>
                <ExternalLink href={BASE_TX + rescue.baseTx}>Mined on Base</ExternalLink>
                <ExternalLink href={NEAR_TX + rescue.nearProof}>Proven by Read MPC</ExternalLink>
              </p>
            </div>
          )}
          {out?.kind === 'attack' && ('failed' in out.result ? (
            <p className="animate-line text-[0.875rem] text-wait">Not sent: {out.result.failed}</p>
          ) : (
            <div className="animate-line space-y-2.5">
              <p className="text-[0.9375rem]">
                {out.result.refused
                  ? <><span className="text-danger">✕ {out.name}: refused by the {out.result.layer}.</span> <span className="text-safe">The loan wasn't touched.</span></>
                  : <span className="text-danger">The contract signed “{out.name}”. This should never happen.</span>}
              </p>
              {out.result.error && <p className="rounded-lg border bg-background px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-ink-2">{out.result.error}</p>}
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
                {out.result.tx ? <ExternalLink href={NEAR_TX + out.result.tx}>Failed transaction on NEAR</ExternalLink> : <span>Rejected before it reached the chain</span>}
                <span className="tnum">{(out.ms / 1000).toFixed(1)} s</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-[0.8125rem] text-muted-foreground">
        <span className="tnum">{totals && totals.sent > 0 ? `${totals.refused} of ${totals.sent} requests refused, from every visitor so far` : 'Every request any visitor sends is counted here.'}</span>
        <a href="/app" className="underline decoration-input underline-offset-4 hover:text-foreground">All eight at once, the loan and the logbook</a>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="fixed top-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-6 rounded-full border border-white/[0.07] bg-card/75 py-2.5 pr-2.5 pl-5 text-[0.8125rem] backdrop-blur-xl sm:gap-8">
      <a href="/" className="flex items-center gap-2 font-mono text-[0.8125rem] font-bold tracking-[0.12em] whitespace-nowrap"><PixelLogo cell={3} word={false} />LIFEGUARD</a>
      <div className="flex items-center gap-6 text-muted-foreground">
        <a href="#how" className="hidden hover:text-foreground sm:inline">How it works</a>
        <a href="/app#rescue" className="hidden hover:text-foreground sm:inline">Proof</a>
        <a href="/app" className="tap rounded-full bg-safe px-4 py-1.5 font-semibold whitespace-nowrap text-background hover:opacity-85">Launch app</a>
      </div>
    </nav>
  );
}

function Terminal({ lines }: { lines: [string, React.ReactNode, ('safe' | 'danger')?][] }) {
  return (
    <div className="relative w-full max-w-[23rem] rounded-xl border bg-background/90 px-5 py-4 font-mono text-[0.75rem] leading-[1.9]">
      {lines.map(([k, v, tone], i) => (
        <div key={i} className="flex gap-4">
          <span className={`w-24 shrink-0 ${tone === 'safe' ? 'text-safe' : tone === 'danger' ? 'text-danger' : 'text-faint'}`}>{k}</span>
          <span className={`min-w-0 truncate ${tone ? 'text-ink-2' : 'text-foreground'}`}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Step({ n, title, body, visual, flip }: { n: number; title: React.ReactNode; body: string; visual: React.ReactNode; flip?: boolean }) {
  return (
    <div className="grid overflow-hidden rounded-3xl border bg-card md:min-h-[24rem] md:grid-cols-2">
      <div className={`flex flex-col justify-center gap-4 p-8 sm:p-12 ${flip ? 'md:order-2' : ''}`}>
        <span className="font-mono text-[4rem] leading-none font-extrabold text-white/[0.04]">0{n}</span>
        <span className="label-mono text-safe">Step 0{n}</span>
        <h3 className="text-[1.75rem] leading-[1.15] font-bold tracking-[-0.02em]">{title}</h3>
        <p className="max-w-[38ch] text-[0.9375rem] leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <div className="relative flex items-center justify-center overflow-hidden bg-muted p-8 sm:p-10">
        <div aria-hidden className="grid-lines absolute inset-0 opacity-60 [background-size:32px_32px]" />
        {visual}
      </div>
    </div>
  );
}

function Stats({ p }: { p: Position | null }) {
  const hf = p?.loan.healthFactor;
  const proven = p?.history.filter((e) => e.proven).length;
  const stats: [string, string][] = [
    [p ? (hf === null ? 'No debt' : num(hf!, 3)) : '—', 'Health factor now, live'],
    [`${rescue.before} → ${rescue.after}`, `The agent's rescue, ${rescue.date}`],
    p && p.feed.sent > 0 ? [`${p.feed.refused} / ${p.feed.sent}`, 'Requests refused, every visitor'] : ['8 / 8', 'Attacks refused in the 30 Oct red team'],
    [proven !== undefined ? String(proven) : '—', 'Transactions proven by Read MPC'],
  ];
  return (
    <section className="mx-auto mb-28 grid max-w-[69rem] grid-cols-2 overflow-hidden rounded-[1.25rem] border bg-card lg:grid-cols-4">
      {stats.map(([v, l], i) => (
        <div key={l} className={`px-6 py-9 text-center ${i % 2 ? 'border-l' : ''} ${i > 1 ? 'border-t lg:border-t-0' : ''} ${i === 2 ? 'lg:border-l' : ''}`}>
          <div className="tnum font-mono text-[1.625rem] font-bold tracking-[-0.02em] text-white">{v}</div>
          <div className="mt-1.5 text-[0.8125rem] text-muted-foreground">{l}</div>
        </div>
      ))}
    </section>
  );
}

export function Landing() {
  const { p } = usePosition();
  const key = p && p.key !== 'FullAccess' ? p.key : null;
  const rise = (i: number) => ({ className: 'animate-rise', style: { animationDelay: `${150 + i * 120}ms` } });

  return (
    <div className="min-h-dvh">
      <Nav />

      <header className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 pt-28 pb-20 text-center">
        <div aria-hidden className="grid-lines pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_80%_70%_at_50%_45%,black_10%,transparent_65%)]" />
        <div aria-hidden className="pointer-events-none absolute top-1/3 left-1/2 h-[28rem] w-[46rem] -translate-x-1/2 rounded-full bg-safe/[0.06] blur-3xl" />
        <div className="relative flex flex-col items-center">
          <div {...rise(0)}><PixelLogo cell={9} /></div>
          <div {...rise(1)} className="mt-10 animate-rise font-mono text-[0.6875rem] tracking-[0.3em] text-safe uppercase">AI agent security · enforced by NEAR</div>
          <h1 {...rise(2)} className="mt-6 max-w-[16ch] animate-rise text-[2.75rem] leading-[1.04] font-bold tracking-[-0.04em] sm:text-[4.25rem]">
            It can rescue your loan. <em className="font-serif font-normal text-ink-2">It can never sink it.</em>
          </h1>
          <p {...rise(3)} className="mt-6 max-w-[48ch] animate-rise text-[1.0625rem] leading-relaxed text-muted-foreground">
            Lifeguard: an AI agent that can rescue your loan on any chain but can never put it at risk, enforced by NEAR.
          </p>
          <div {...rise(4)} className="mt-9 flex animate-rise flex-wrap justify-center gap-3">
            <a href="#console" className="tap rounded-full bg-safe px-8 py-3.5 text-[0.875rem] font-semibold text-background hover:opacity-90">Attack the agent</a>
            <a href="#how" className="tap rounded-full border px-8 py-3.5 text-[0.875rem] font-medium text-ink-2 hover:border-input hover:text-foreground">How it works</a>
          </div>
          <div {...rise(5)} className="mt-14 flex w-full animate-rise justify-center"><LiveConsole p={p} /></div>
          <div {...rise(6)} className="mt-10 flex animate-rise items-center gap-2 font-mono text-[0.6875rem] tracking-[0.12em] text-faint uppercase">
            <Dot className="text-safe" />Live on NEAR testnet · Base Sepolia · built for NEAR HACKATHON
          </div>
        </div>
      </header>

      <Stats p={p} />

      <section id="how" className="scroll-mt-24 px-4 pb-28">
        <div className="mx-auto max-w-[40rem] pb-14 text-center">
          <div className="label-mono">How it works</div>
          <h2 className="mt-4 text-[2rem] leading-[1.1] font-bold tracking-[-0.03em] sm:text-[2.75rem]">Two layers stop the agent. <em className="font-serif font-normal text-ink-2">Neither one trusts it.</em></h2>
        </div>
        <div className="mx-auto flex max-w-[69rem] flex-col gap-4">
          <Step n={1} title="The agent holds a NEAR key, not your wallet"
            body="Its key may call two methods on one contract: request an action, or confirm one. NEAR's protocol rejects every other call, transfer and deposit before it runs."
            visual={<Terminal lines={[
              ['key', key ? short(p!.agentPublicKey) : 'ed25519:…'],
              ['receiver', key?.receiver_id ?? 'lifeguard contract'],
              ['methods', key ? key.method_names.join(', ') : 'request_action, confirm'],
              ['owner_action', '✕ MethodNameMismatch', 'danger'],
              ['transfer', '✕ RequiresFullAccess', 'danger'],
            ]} />} />
          <Step n={2} flip title="NEAR builds and signs every Base transaction"
            body="The contract writes the transaction byte by byte: Aave's Pool as the target, the loan as onBehalfOf, capped fees. Only supply, repay and a capped approve exist. Then NEAR's MPC network signs it with chain signatures."
            visual={<Terminal lines={[
              ['chain', 'Base Sepolia · 84532'],
              ['to', `Aave Pool ${short(p?.config.pool ?? '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27')}`],
              ['call', `repay 1,000 USDC for ${p ? short(p.address) : 'the loan'}`],
              ['max fee', p ? `≤ ${Number(p.config.max_fee_per_gas) / 1e9} gwei` : '≤ 5 gwei'],
              ['signer', p?.config.mpc ?? 'v1.signer-prod.testnet'],
              ['result', '✓ signed', 'safe'],
            ]} />} />
          <Step n={3} title="Read MPC proves it happened"
            body="Once Base marks the block safe, NEAR's Read MPC checks that the exact transaction the contract built succeeded on Base. Only then does the loan's nonce advance. A reverted transaction is never proven."
            visual={<Terminal lines={[
              ['method', 'verify_foreign_transaction'],
              ['chain', 'Base · finality Safe'],
              ['tx', short(rescue.baseTx)],
              ['extractor', 'BlockHash'],
              ['result', '✓ succeeded · nonce 6 → 7', 'safe'],
            ]} />} />
        </div>
      </section>

      <section id="proof" className="scroll-mt-24 px-4 pb-28 text-center">
        <div className="label-mono">Built on NEAR</div>
        <div className="mx-auto mt-7 flex max-w-[60rem] flex-wrap justify-center gap-x-10 gap-y-4 font-mono text-[0.875rem] text-muted-foreground">
          {['Chain signatures', 'Read MPC', 'Function-call keys', 'Yield / resume', 'Aave V3 on Base'].map((n) => <span key={n}>{n}</span>)}
        </div>
      </section>

      <section className="px-4 pb-28">
        <div className="mx-auto grid max-w-[69rem] items-center gap-10 rounded-3xl border border-safe/15 bg-[linear-gradient(135deg,rgb(16_185_129/0.08),rgb(16_185_129/0.02))] p-8 sm:p-16 md:grid-cols-[1.3fr_1fr]">
          <h2 className="text-[2rem] leading-[1.1] font-bold tracking-[-0.03em] sm:text-[2.5rem]">Try to break it. <em className="font-serif font-normal text-ink-2">With the agent's real key.</em></h2>
          <div className="flex flex-col gap-5">
            <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">Eight requests a compromised agent would send, fired at testnet from your browser. Each result shows which layer stopped it and links to the failed transaction.</p>
            <a href="/app" className="tap self-start rounded-full bg-safe px-8 py-3.5 text-[0.875rem] font-semibold text-background hover:opacity-90">Launch app</a>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-[69rem] border-t px-4 py-12">
        <div className="flex flex-wrap justify-between gap-10">
          <div className="max-w-[28ch]">
            <div className="font-mono text-[1rem] font-bold tracking-[0.12em]">LIFEGUARD</div>
            <p className="mt-2 text-[0.8125rem] text-faint">An AI agent that can rescue your loan but can never put it at risk.</p>
          </div>
          <div className="flex gap-16 text-[0.8125rem]">
            <div className="flex flex-col gap-2">
              <span className="label-mono mb-1">On chain</span>
              {p && <ExternalLink href={NEAR_ACCOUNT + p.contract} className="text-muted-foreground no-underline hover:text-foreground">Contract on NEAR</ExternalLink>}
              {p && <ExternalLink href={BASE_ADDRESS + p.address} className="text-muted-foreground no-underline hover:text-foreground">Loan on Base</ExternalLink>}
            </div>
            <div className="flex flex-col gap-2">
              <span className="label-mono mb-1">The rescue</span>
              <ExternalLink href={NEAR_TX + rescue.nearSign} className="text-muted-foreground no-underline hover:text-foreground">Signed on NEAR</ExternalLink>
              <ExternalLink href={BASE_TX + rescue.baseTx} className="text-muted-foreground no-underline hover:text-foreground">Mined on Base</ExternalLink>
              <ExternalLink href={NEAR_TX + rescue.nearProof} className="text-muted-foreground no-underline hover:text-foreground">Proven by Read MPC</ExternalLink>
            </div>
          </div>
        </div>
        <div className="mt-12 flex flex-wrap justify-between gap-3 font-mono text-[0.6875rem] tracking-[0.12em] text-faint uppercase">
          <span>Testnet only · no real funds</span><span>Built for NEAR HACKATHON · MIT</span>
        </div>
      </footer>
    </div>
  );
}
