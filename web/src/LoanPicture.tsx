import { AAVE, BASE, NEAR } from './Logos';

// The loan as it gets built: done parts solid, the current part dashed, later parts faint and blurred.
const DESCRIBE = [
  'Your NEAR wallet, not connected yet. Nothing is open.',
  'Your wallet is connected. Opening the loan creates a Lifeguard position on NEAR, a Base address and a key for its agent.',
  'Lifeguard holds its agent key and is supplying 1 cbETH to the loan on Base.',
  '1 cbETH is supplied on Base. Next, borrow USDC against it.',
  'USDC is borrowed. Lifeguard is letting its agent key repay the loan.',
  "The loan is ready. Its owner's NEAR wallet holds the Lifeguard position, and its agent key can repay the Base loan.",
];

const Logo = ({ ds, box, x, y, w, h }: { ds: string[]; box: string; x: number; y: number; w: number; h: number }) =>
  <svg x={x} y={y} width={w} height={h} viewBox={box} fill="currentColor" style={{ color: 'var(--ink-2)' }}>{ds.map(d => <path key={d.slice(0, 16)} d={d} />)}</svg>;

/** `step` is the index of the current part (0–4), or 5 when the loan is ready. `wallet` labels the owner's wallet. */
export function LoanPicture({ step, failed, debt, wallet = 'Your wallet' }: { step: number; failed: boolean; debt: number | null; wallet?: string }) {
  const mode = (i: number) => `part ${i < step ? 'complete' : i > step ? 'future' : failed ? 'error' : 'active'}`;
  const moving = (i: number, kind: string) => i === step && !failed ? kind : '';
  return <figure className="picture min-w-0">
    <svg className="scene block h-auto w-full" viewBox="0 0 620 590" role="img" aria-labelledby="picture-title picture-desc">
      <title id="picture-title">Lifeguard loan</title><desc id="picture-desc">{failed ? `Stopped. ${DESCRIBE[step]}` : DESCRIBE[step]}</desc>
      <defs>
        {/* Styles don't reach into <use> copies, so the strokes are set here. */}
        <g id="tick" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m-6 0 4 4 9-10" /></g>
        <g id="key" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="0" cy="0" r="10" /><path d="M10 0h29v7m-9-7v6" /></g>
      </defs>
      <g className={mode(0)}>
        <path className="surface" d="M90 99v7l135 54 135-54v-7M225 153v7" />
        <path className="surface" d="m225 45 135 54-135 54L90 99Z" />
        <g className={moving(0, 'motion')}><use href="#key" transform="matrix(1 .4 -1 .4 207 92)" /></g>
        <path className="wire" d="M225 160v24" />
        <use className="check" href="#tick" x="383" y="98" />
        <text className="label" x="403" y="104">{wallet}</text>
      </g>
      <g className={mode(1)}>
        <path className="surface" d="M90 241v7l135 54 135-54v-7M225 295v7" />
        <path className="surface" d="m225 187 135 54-135 54L90 241Z" />
        <g transform="matrix(1 .4 -1 .4 191 226)"><path className="wire" d="M-17-14h34M-17 0h25M-17 14h34" /></g>
        <g className={moving(1, 'motion')}><use href="#key" transform="matrix(1 .4 -1 .4 249 244)" /></g>
        <use className="check" href="#tick" x="383" y="231" />
        <text className="label" x="403" y="235">Lifeguard</text><text className="sub" x="403" y="262">Agent key</text>
        <path className="wire" d="M550 70h13v208h-13" />
        <Logo ds={NEAR} box="0 0 345 86" x={524} y={33} w={75} h={19} />
      </g>
      <g className={`part ${step >= 2 ? 'complete' : 'future'}`}>
        <path className="surface" d="M79 427v10a146 51 0 0 0 292 0v-10" />
        <ellipse className="surface" cx="225" cy="427" rx="146" ry="51" />
        <ellipse className="wire" cx="225" cy="427" rx="130" ry="44" opacity=".35" />
        <Logo ds={BASE} box="0 0 1280 323.84" x={125} y={492} w={91} h={23} />
        <Logo ds={AAVE} box="0 0 833 139" x={247} y={497} w={78} h={13} />
      </g>
      <g className={mode(2)}>
        <g className={moving(2, 'landing')}>
          <path className="surface" d="m225 322 45 24v52l-45 24-45-24v-52Z" />
          <path className="wire" d="m180 346 45 24 45-24m-45 24v52" />
          <path className="face" d="m225 323 44 23-44 23-44-23Z" />
          <circle className="surface" cx="225" cy="376" r="29" />
          <text className="ticker" x="225" y="382" textAnchor="middle">cbETH</text>
        </g>
        <text className="label current-label" x="55" y="338">1 cbETH</text>
        <path className="wire" d="M119 349h27l22 13" opacity=".7" />
        <use className="check" href="#tick" x="40" y="331" />
        <g className="cross" transform="translate(40 331)"><path className="wire" d="m-6-6 12 12m0-12-12 12" /></g>
      </g>
      <g className={mode(3)}>
        <path className="wire" d="M373 427h43m-8-6 8 6-8 6" />
        <g className={moving(3, 'motion')}><circle className="surface" cx="469" cy="427" r="40" /><text className="ticker" x="469" y="433" textAnchor="middle">USDC</text></g>
        <text className="amount" x="469" y="504" textAnchor="middle">{step < 4 ? '1,000' : debt ? Math.round(debt).toLocaleString('en-US') : '—'}</text>
        <text className="sub" x="469" y="533" textAnchor="middle">{step > 3 ? 'Borrowed' : 'To borrow'}</text>
      </g>
      <g className={mode(4)}>
        <path className={`wire ${moving(4, 'draw')}`} pathLength={1} d="M285 256C376 280 399 326 356 376l-20 21m2-15-2 15 15-4" />
        <text className="sub pending-label" x="405" y="328">{step > 4 ? 'Repayments on' : 'Turning on'}</text>
        <use className="check" href="#tick" x="385" y="321" />
      </g>
    </svg>
  </figure>;
}
