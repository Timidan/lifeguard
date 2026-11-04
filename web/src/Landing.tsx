import { Stack } from './Stack';
import { LifeRing } from './LifeRing';
import { Aave, Base, Mark, Near } from './Logos';
import { BASE_ADDRESS, BASE_TX, ExternalLink, NEAR_ACCOUNT, NEAR_TX, num, rescue, usePosition } from './App';

function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b bg-background">
      <div className="mx-auto flex h-16 max-w-[69rem] items-center justify-between gap-6 px-4">
        <a href="/" className="flex items-center gap-2.5 text-[1.0625rem] font-semibold whitespace-nowrap"><Mark />Lifeguard</a>
        <div className="flex items-center gap-6 text-[0.875rem] text-muted-foreground">
          <a href="#how" className="hidden hover:text-foreground sm:inline">How it works</a>
          <a href="/app" className="tap rounded-md bg-safe px-4 py-2 font-semibold whitespace-nowrap text-background hover:opacity-85">Open app</a>
        </div>
      </div>
    </nav>
  );
}

export function Landing() {
  const { p } = usePosition();
  const hf = p?.loan.healthFactor;
  const figures: [string, React.ReactNode][] = [
    ['Health factor', <>{rescue.before} → <span className="text-safe">{rescue.after}</span></>],
    ['Debt', `$${num(rescue.debtBefore, 0)} → $${num(rescue.debtAfter, 0)}`],
    ['Health factor now', p ? (hf === null ? 'No debt' : num(hf!, 3)) : '—'],
    ['Requests refused', p ? `${p.feed.refused} of ${p.feed.sent}` : '—'],
  ];

  return (
    <div className="min-h-dvh">
      <Nav />

      <header className="px-4 pt-14 pb-20">
        <div className="mx-auto grid max-w-[69rem] items-center gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-8">
          <div>
            <h1 className="text-[2.375rem] leading-[1.08] sm:text-[3.25rem]">
              An AI agent that can rescue your loan <em className="block text-safe">and can never put it at risk.</em>
            </h1>
            <p className="mt-5 max-w-[34rem] text-[1.125rem] leading-relaxed text-muted-foreground">
              It repays your Aave loan on Base when it nears liquidation, and NEAR enforces every limit instead of trusting the agent.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <a href="#how" className="tap rounded-md bg-safe px-7 py-3.5 text-[0.9375rem] font-semibold text-background hover:opacity-90">Attack the agent</a>
              <a href="#how" className="text-[0.9375rem] font-medium text-ink-2 underline decoration-input underline-offset-4 hover:text-foreground">How it works</a>
            </div>
            <dl className="mt-10 grid max-w-[34rem] grid-cols-2 gap-x-6 gap-y-5 border-t pt-6">
              {figures.map(([k, v]) => (
                <div key={k}>
                  <dt className="label-mono">{k}</dt>
                  <dd className="tnum mt-1 font-serif text-[1.1875rem] tracking-[-0.015em] whitespace-nowrap sm:text-[1.5rem]">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 max-w-[34rem] text-[0.8125rem] text-muted-foreground">{rescue.action} on {rescue.date}, recorded on NEAR testnet and Base Sepolia.</p>
          </div>
          <LifeRing />
        </div>
      </header>

      <Stack p={p} />

      <section className="px-4 pb-24">
        <div className="mx-auto grid max-w-[69rem] items-end gap-8 md:grid-cols-[1.3fr_1fr]">
          <h2 className="text-[2rem] leading-[1.1] sm:text-[2.5rem]">Try to break it. <em className="text-ink-2">With the agent's key.</em></h2>
          <div className="flex flex-col gap-5">
            <p className="text-[1rem] leading-relaxed text-muted-foreground">Eight requests a compromised agent would send, fired at testnet from your browser. Each result shows which layer stopped it and links to the failed transaction.</p>
            <a href="/app" className="tap self-start rounded-md bg-safe px-7 py-3.5 text-[0.9375rem] font-semibold text-background hover:opacity-90">Open app</a>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-[69rem] border-t px-4 py-12">
        <div className="flex flex-wrap justify-between gap-10">
          <div className="max-w-[28ch]">
            <div className="text-[1.0625rem] font-semibold">Lifeguard</div>
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
              <ExternalLink href={NEAR_TX + rescue.nearProof} className="text-muted-foreground no-underline hover:text-foreground">Verified by Read MPC</ExternalLink>
            </div>
          </div>
        </div>
        <div className="built mt-10 text-[0.875rem] text-muted-foreground">Built on <Near /> <Aave /> <Base /></div>
        <div className="mt-6 flex flex-wrap justify-between gap-3 text-[0.8125rem] text-faint">
          <span>Testnet only · no real funds</span><span>Built for NEAR Hackathon · MIT</span>
        </div>
        <p className="mt-3 text-[0.8125rem] text-faint">NEAR, Aave and Base names and logos belong to their owners. Lifeguard is an independent hackathon project.</p>
      </footer>
    </div>
  );
}
