import { useEffect, useRef } from 'react';

// Pixel-block wordmark in the manner of Murmur's TetrisMlogo: a 7x7 life ring, then LIFEGUARD in 5x7 letters.
const RING = ['0111110', '1100011', '1000001', '1000001', '1000001', '1100011', '0111110'];
const LETTERS: Record<string, string[]> = {
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10010', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
};
const RED = ['#F25555', '#9E2B2B'], WHITE = ['#F4F4F5', '#8B8B94'], TEXT = ['#E4E4E7', '#6B6B74'];

/** A life ring's bands alternate: red at the top, bottom and sides, white on the diagonals. */
function ringColour(c: number, r: number) {
  const angle = Math.atan2(r - 3, c - 3) + Math.PI / 8 + 2 * Math.PI;
  return Math.floor(angle / (Math.PI / 4)) % 2 === 0 ? RED : WHITE;
}

function block(ctx: CanvasRenderingContext2D, col: number, row: number, size: number, [fill, edge]: string[]) {
  const x = col * size + 1, y = row * size + 1, s = size - 2;
  ctx.fillStyle = edge;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, s - 2, s - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(x, y, s - 2, 2);
}

export function PixelLogo({ cell = 14, word = true }: { cell?: number; word?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const letters = word ? 'LIFEGUARD'.split('') : [];
  const cols = 7 + (word ? 2 + letters.length * 6 - 1 : 0);
  const w = cols * cell, h = 7 * cell;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const draw = () => {
      RING.forEach((line, r) => [...line].forEach((on, c) => on === '1' && block(ctx, c, r, cell, ringColour(c, r))));
      letters.forEach((ch, i) => LETTERS[ch].forEach((line, r) => [...line].forEach((on, c) => on === '1' && block(ctx, 9 + i * 6 + c, r, cell, TEXT))));
    };
    ctx.save();
    ctx.filter = `blur(${Math.max(2, cell / 2)}px)`;
    ctx.globalAlpha = 0.45;
    draw();
    ctx.restore();
    draw();
  }, [cell, w, h]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} role="img" aria-label="Lifeguard" style={{ width: w, maxWidth: '100%', height: 'auto', aspectRatio: `${w} / ${h}` }} className="block" />;
}
