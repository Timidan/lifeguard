import { useEffect, useId, useRef, useState } from 'react';
import { BASE_TX, ExternalLink, NEAR_TX, num, rescue, sendAttack, short, type Position, type Result } from './App';
import { Aave, Base, Near } from './Logos';

const requests = ['Repay 1,000 USDC', 'Withdraw collateral', 'Send NEAR away'] as const;
const plates = [
  { id: 'key', name: 'Access key', y: 145, at: 510, word: 'Accepted' },
  { id: 'contract', name: 'Lifeguard contract', y: 270, at: 880, word: 'Built' },
  { id: 'signers', name: 'MPC signers', y: 395, at: 1200, word: 'Signed' },
  { id: 'read', name: 'Read MPC', y: 520, at: 2450, word: 'Confirmed' },
] as const;
type Part = typeof plates[number]['id'] | 'base' | 'agent';
type Path = 'repay' | 'key' | 'contract' | 'signed' | 'idle';
const durations: Record<Path, number> = { repay: 2450, key: 610, contract: 980, signed: 1300, idle: 0 };

function cubePosition(time: number, path: Path) {
  if (path === 'idle') return 85;
  const poses = [[0, 85], [140, 77], [510, 145]];
  if (path !== 'key') poses.push([880, 270]);
  if (path === 'repay' || path === 'signed') poses.push([1200, 395]);
  if (path === 'repay') poses.push([1480, 520], [1780, 700]);
  for (let i = 1; i < poses.length; i++) {
    const [end, to] = poses[i], [start, from] = poses[i - 1];
    if (time <= end) {
      const t = Math.max(0, (time - start) / (end - start));
      return from + (to - from) * t * t * (3 - 2 * t);
    }
  }
  return poses[poses.length - 1][1];
}

export function Stack({ p }: { p: Position | null }) {
  const [pick, setPick] = useState<string>(requests[0]);
  const [out, setOut] = useState<{ result: Result; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [extra, setExtra] = useState({ sent: 0, refused: 0 });
  const [run, setRun] = useState({ path: 'repay' as Path, animate: false });
  const [time, setTime] = useState(durations.repay);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  const [hovered, setHovered] = useState<Part | null>(null);
  const [focused, setFocused] = useState<Part | null>(null);
  const [pinned, setPinned] = useState<Part | null>(null);
  const selected = hovered ?? focused ?? pinned;
  const clipId = useId();
  const outcomeId = useId();

  useEffect(() => setExtra({ sent: 0, refused: 0 }), [p?.feed.sent]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const resize = () => setNarrow(media.matches);
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const end = durations[run.path];
    const finish = () => { cancelAnimationFrame(frame); setTime(end); };
    const preference = () => { if (media.matches) finish(); };
    if (!run.animate || media.matches) finish();
    else {
      const start = performance.now();
      const tick = (now: number) => {
        const elapsed = Math.min(now - start, end);
        setTime(elapsed);
        if (elapsed < end) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    media.addEventListener('change', preference);
    return () => { cancelAnimationFrame(frame); media.removeEventListener('change', preference); };
  }, [run]);

  function animate(path: Path) {
    setTime(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? durations[path] : 0);
    setRun({ path, animate: true });
  }

  async function choose(name: string) {
    if (sending.current) return;
    setPick(name); setOut(null);
    setHovered(null); setFocused(null); setPinned(null);
    if (name === requests[0]) { animate('repay'); return; }
    const i = p?.attacks.findIndex(a => a.short === name) ?? -1;
    if (i < 0) return;
    sending.current = true; setBusy(true); animate('idle');
    const start = performance.now();
    const result = await sendAttack(i);
    setOut({ result, ms: performance.now() - start });
    if (!('failed' in result)) {
      setExtra(e => ({ sent: e.sent + 1, refused: e.refused + (result.refused ? 1 : 0) }));
      animate(result.refused ? (result.layer === 'NEAR access key' ? 'key' : 'contract') : 'signed');
    }
    sending.current = false; setBusy(false);
  }

  const captions: Record<Part, [string, string]> = {
    key: [p?.key === 'FullAccess' ? 'This key has full access.' : 'NEAR checks which calls this key is allowed to make.',
      p ? (p.key === 'FullAccess' ? 'FullAccess' : p.key.method_names.join(', ') || 'Any method') : 'request_action, confirm'],
    contract: ['It writes every Base transaction. Only supply, repay and a capped approve exist.', p ? p.contract : 'lifeguard-mvxuworb.testnet'],
    signers: ['NEAR’s MPC network signs. No single node holds the key.', p ? p.config.mpc : 'v1.signer-prod.testnet'],
    read: ['NEAR checks the repayment on Base before the nonce advances.', 'verify_foreign_transaction'],
    base: ['The loan, on Base Sepolia testnet.', p ? short(p.address) : '0xd6ca…b719'],
    agent: ['The agent holds the key used to send this request.', p ? short(p.agentPublicKey) : 'NEAR function-call key'],
  };
  function partProps(id: Part, label: string) {
    return {
      role: 'button', tabIndex: 0, 'aria-label': label, 'aria-pressed': pinned === id,
      'aria-controls': outcomeId, 'data-part': id,
      className: 'group cursor-pointer outline-none',
      onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType !== 'touch') setHovered(id); },
      onPointerLeave: () => setHovered(null),
      onFocus: () => setFocused(id), onBlur: () => setFocused(null),
      onClick: () => setPinned(id),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned(id); }
      },
    };
  }
  const { path } = run;
  const stopped = (path === 'key' && time >= 510) || (path === 'contract' && time >= 880);
  const cubeTone = stopped || path === 'signed' ? 'var(--danger)' : time >= 510 && path !== 'idle' ? 'var(--safe)' : 'var(--ink-2)';
  const readAmount = path === 'repay' ? Math.min(1, Math.max(0, (time - 2020) / 390)) : 0;
  const labelX = narrow ? 250 : 438;
  const scaleX = narrow ? .58 : 1;
  const focusClass = 'invisible fill-none stroke-foreground group-focus-visible:visible';
  const liftClass = 'transition-transform duration-150 motion-reduce:transition-none';
  const totals = p ? { sent: p.feed.sent + extra.sent, refused: p.feed.refused + extra.refused } : null;
  const result = out?.result;

  return (
    <section id="how" aria-labelledby="stack-heading" className="scroll-mt-24 px-4 pb-24"
      onKeyDown={e => {
        if (e.key === 'Escape') {
          setHovered(null); setFocused(null); setPinned(null);
          if (document.activeElement instanceof SVGElement) document.activeElement.blur();
        }
      }}>
      <div className="mx-auto grid max-w-[69rem] items-center gap-6 border-y bg-card px-5 py-10 sm:px-8 lg:grid-cols-[minmax(0,.95fr)_minmax(0,1.05fr)]">
        <div className="min-w-0 self-start lg:pt-5">
          <h2 id="stack-heading" className="text-[2rem] leading-[1.15] sm:text-[2.5rem]">Two layers stop the agent. <em className="text-ink-2">Neither one trusts it.</em></h2>
          <div role="group" aria-label="Requests" className="mt-8 grid sm:flex sm:gap-4">
            {requests.map(name => (
              <button key={name} type="button" aria-pressed={pick === name} aria-controls={outcomeId} data-request={name}
                disabled={busy || (name !== requests[0] && !p?.attacks.some(a => a.short === name))} onClick={() => choose(name)}
                className={`tap min-h-12 border-b py-3 text-left text-[0.875rem] whitespace-nowrap disabled:cursor-wait disabled:opacity-50 sm:text-[0.8125rem] ${pick === name ? 'border-foreground text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {name}
              </button>
            ))}
          </div>
          <div id={outcomeId} data-outcome aria-live="polite" aria-atomic="true" className="mt-7 min-h-[12rem]">
            {selected ? <>
              <p className="text-[1.25rem] leading-relaxed text-ink-2">{captions[selected][0]}</p>
              <p className="mt-4 font-mono text-[0.875rem] leading-relaxed break-all text-muted-foreground">{captions[selected][1]}</p>
            </> : pick === requests[0] ? <>
              <p className="font-serif text-[1.625rem] tracking-tight text-safe">Repaid 1,000 USDC.</p>
              <div className="tnum mt-4 space-y-1 font-mono text-[0.875rem] text-ink-2">
                <p>Health factor {rescue.before} → {rescue.after}</p>
                <p>Debt ${num(rescue.debtBefore, 0)} → ${num(rescue.debtAfter, 0)}</p>
                <p>Then Read MPC confirmed · <span className="whitespace-nowrap">nonce {rescue.nonce} → {rescue.nonce + 1}</span></p>
              </div>
              <p className="mt-4 text-[0.8125rem] text-muted-foreground">Recorded on testnet, {rescue.date}.</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-[0.8125rem] text-muted-foreground">
                <ExternalLink href={NEAR_TX + rescue.nearSign}>Signed on NEAR</ExternalLink>
                <ExternalLink href={BASE_TX + rescue.baseTx}>Mined on Base</ExternalLink>
                <ExternalLink href={NEAR_TX + rescue.nearProof}>Verified by Read MPC</ExternalLink>
              </div>
            </> : busy ? <p className="font-serif text-[1.625rem] text-ink-2">Sending with the agent’s key…</p>
              : result && ('failed' in result ? <p className="text-[1.125rem] text-danger">Not sent: {result.failed}</p> : <>
                <p className="font-serif text-[1.625rem] tracking-tight text-danger">{result.refused ? `Refused by the ${result.layer === 'NEAR access key' ? 'access key' : 'contract'}.` : 'The contract signed it. This should never happen.'}</p>
                {result.error && <p className="mt-4 font-mono text-[0.8125rem] leading-relaxed break-words text-ink-2">{result.error}</p>}
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[0.8125rem] text-muted-foreground">
                  {result.tx ? <ExternalLink href={NEAR_TX + result.tx}>{result.refused ? 'Failed transaction on NEAR' : 'Transaction on NEAR'}</ExternalLink> : result.refused && <span>Rejected before it reached the chain</span>}
                  <span className="tnum">{(out.ms / 1000).toFixed(1)} s</span>
                </div>
              </>)}
          </div>
          <p className="mt-5 text-[0.75rem] leading-relaxed text-faint">
            <span className="tnum">{totals ? `${totals.refused} of ${totals.sent} requests refused, from every visitor so far` : 'Every request any visitor sends is counted here.'}</span>{' · '}
            <a href="/app?position=0" className="underline decoration-input underline-offset-4 hover:text-foreground">All eight attacks, with the loan and its transactions</a>
          </p>
        </div>

        <svg data-stack-scene data-path={path} data-phase={time >= durations[path] ? 'complete' : 'running'}
          viewBox={narrow ? '28 35 456 775' : '30 35 730 775'} role="group"
          aria-label="NEAR access key, contract and signers; Base execution, then Read MPC confirmation"
          className="mx-auto block w-full max-w-[38rem] overflow-visible [&_path]:[vector-effect:non-scaling-stroke] [&_ellipse]:[vector-effect:non-scaling-stroke] [&_circle]:[vector-effect:non-scaling-stroke]">
          <defs>
            <clipPath id={clipId}><rect x="70" y={72 - 146 * readAmount} width="340" height={146 * readAmount} /></clipPath>
            <clipPath id={`${clipId}-grid`}><rect x="30" width="380" height="790" /></clipPath>
          </defs>
          <g transform={`scale(${scaleX} 1)`} clipPath={`url(#${clipId}-grid)`} fill="none" stroke="var(--border)" strokeDasharray="3 7" opacity=".55" className="pointer-events-none" aria-hidden="true">
            {[177, 287, 397, 507, 617].map(y => <path key={y} d={`M36 ${y} 240 ${y - 82} 444 ${y}M36 ${y} 240 ${y + 82} 444 ${y}`} />)}
          </g>
          {plates.map((plate, i) => {
            const refused = path === plate.id && stopped;
            const passed = time >= plate.at && (path === 'repay' || (path === 'contract' && i === 0) || (path === 'signed' && i < 3));
            const stroke = refused ? 'var(--danger)' : passed ? 'var(--safe)' : 'var(--faint)';
            const face = `M240 -65 395 0 240 65 85 0Z${plate.id === 'read' ? ' M240 -23 185 0 240 23 295 0Z' : ''}`;
            return <g key={plate.id} {...partProps(plate.id, plate.name)} transform={`translate(0 ${plate.y})`} data-status={refused ? 'refused' : passed ? 'passed' : 'idle'}>
              <g className={liftClass} style={{ transform: selected === plate.id ? 'translateY(-8px)' : undefined }}>
                <g transform={`scale(${scaleX} ${narrow ? .65 : .8})`}>
                  <path d="M85 0v7l155 65L395 7V0M240 65v7" fill="none" stroke={stroke} strokeWidth="1.2" />
                  <path d={face} fill="var(--card)" stroke={stroke} strokeWidth="1.2" fillRule="evenodd" />
                  {passed && plate.id !== 'read' && <path d={face} fill="var(--safe-soft)" />}
                  {plate.id === 'read' && <path data-read-fill d={face} fill="var(--safe-soft)" stroke="var(--safe)" strokeWidth="1.2" fillRule="evenodd" clipPath={`url(#${clipId})`} />}
                  <path d="M112 0 240 54 368 0" fill="none" stroke="var(--border)" />
                  <g transform="matrix(1 .419 -1 .419 240 0)" fill="none" stroke={stroke} strokeWidth="1.2" aria-hidden="true">
                    {plate.id === 'key' && <path d="M-5 -5a9 9 0 1 1 10 0V20H-5Z" />}
                    {plate.id === 'contract' && <path d="M-20 -14h40M-20 0h30M-20 14h40" />}
                    {plate.id === 'signers' && [-16, 0, 16].flatMap(x => [-16, 0, 16].map(y => <circle key={`${x},${y}`} cx={x} cy={y} r="2.5" fill={stroke} stroke="none" />))}
                  </g>
                  <path data-plate-hit d="M240 -65 395 0 240 72 85 7Z" fill="transparent" />
                  <path className={focusClass} d="M240 -74 405 0 240 80 75 0Z" strokeWidth="1.5" />
                </g>
                <path d="M399 0h16" transform={`scale(${scaleX} 1)`} stroke="var(--faint)" />
                <g transform={`translate(${labelX} 0)`}>
                  <rect data-label-hit x="-9" y="-30" width="204" height="70" fill="transparent" />
                  <text y="6" fill={selected === plate.id ? 'var(--foreground)' : 'var(--ink-2)'} fontSize={narrow ? 22 : 20}>{plate.name}</text>
                  <text y="31" fill={stroke} fontSize={narrow ? 20 : 18}>{refused ? 'Refused' : passed ? plate.word : ''}</text>
                </g>
              </g>
            </g>;
          })}
          <path d={narrow ? 'M454 124h12v425h-12M466 124V112h-14' : 'M646 124h12v425h-12M658 346h9'} fill="none" stroke="var(--faint)" />
          <foreignObject x={narrow ? 380 : 672} y={narrow ? 78 : 331} width="74" height="24" className="overflow-visible">
            <div className="text-ink-2 [&_.logo]:h-[18px]"><Near /></div>
          </foreignObject>
          <g {...partProps('base', 'Aave on Base')}>
            <g className={liftClass} style={{ transform: selected === 'base' ? 'translateY(-8px)' : undefined }}>
              <g transform={`scale(${scaleX} 1)`}>
                <path d="M105 700v9a135 47 0 0 0 270 0v-9" fill="none" stroke="var(--faint)" strokeWidth="1.2" />
                <ellipse cx="240" cy="700" rx="135" ry="47" fill="var(--card)" stroke="var(--faint)" strokeWidth="1.2" />
                <ellipse cx="240" cy="700" rx="119" ry="40" fill="none" stroke="var(--border)" />
                <ellipse data-plate-hit cx="240" cy="704" rx="140" ry="54" fill="transparent" />
                <ellipse className={focusClass} cx="240" cy="704" rx="146" ry="61" strokeWidth="1.5" />
              </g>
              <g transform={`translate(${labelX} 650)`}>
                <rect data-label-hit x="-9" y="-16" width="220" height="166" fill="transparent" />
                <foreignObject width="210" height="27" className="pointer-events-none overflow-visible">
                  <div className="flex items-center gap-5 text-ink-2 [&_.logo-base]:h-[18px] [&_.logo-aave]:h-[13px]"><Base /><Aave /></div>
                </foreignObject>
                <g fill="var(--muted-foreground)" fontSize={narrow ? 20 : 18}>
                  <text y="42">Base Sepolia</text>
                  <text y="69">{p ? 'Live health factor' : 'Recorded health factor'}</text>
                  <text data-health y="112" className="tnum font-serif text-[40px]" fill="var(--foreground)">{p ? (p.loan.healthFactor === null ? 'No debt' : num(p.loan.healthFactor, 3)) : rescue.after}</text>
                  <text data-nonce y="146" className="tnum">{p ? `Live nonce ${p.nonce}` : `Recorded nonce ${rescue.nonce + 1}`}</text>
                </g>
              </g>
            </g>
          </g>
          <g data-cube transform={`translate(${240 * scaleX} ${cubePosition(time, path)})`} fill={cubeTone}>
            <g {...partProps('agent', 'Agent request')}>
              <path d="M0 -32 15 -24 0 -16 -15 -24Z M-15 -24 0 -16V0l-15 -8Z M0 -16 15 -24v16L0 0Z" />
              <path d="M-15 -24 0 -16 15 -24M0 -16V0" fill="none" stroke="var(--card)" strokeWidth="1" />
              <rect data-cube-hit x="-36" y="-48" width="72" height="72" fill="transparent" />
              <path className={focusClass} d="M0 -41 24 -28v25L0 10 -24 -3v-25Z" strokeWidth="1.5" />
            </g>
          </g>
        </svg>
      </div>
    </section>
  );
}
