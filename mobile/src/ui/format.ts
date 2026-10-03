/** 数值格式化工具。 */

export function fmtDist(m: number): string {
  if (!isFinite(m)) return '∞';
  const a = Math.abs(m);
  if (a < 1000) return `${m.toFixed(0)} m`;
  if (a < 100_000) return `${(m / 1000).toFixed(2)} km`;
  if (a < 10_000_000) return `${(m / 1000).toFixed(1)} km`;
  return `${(m / 1000).toFixed(0)} km`;
}

export function fmtSpeed(v: number): string {
  if (!isFinite(v)) return '—';
  return Math.abs(v) < 100 ? `${v.toFixed(1)} m/s` : `${v.toFixed(0)} m/s`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '—';
  const neg = s < 0;
  s = Math.abs(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p2 = (x: number) => String(x).padStart(2, '0');
  let out: string;
  if (d > 0) out = `${d}天 ${p2(h)}:${p2(m)}:${p2(sec)}`;
  else if (h > 0) out = `${h}:${p2(m)}:${p2(sec)}`;
  else if (m > 0) out = `${m}:${p2(sec)}`;
  else out = `${(s < 10 ? s.toFixed(1) : sec.toString())} 秒`;
  return (neg ? '-' : '') + out;
}

export function fmtMass(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(0)} kg`;
}

export function fmtForce(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)} MN` : `${(n / 1000).toFixed(0)} kN`;
}

export function fmtMET(s: number): string {
  const neg = s < 0;
  s = Math.abs(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p2 = (x: number) => String(x).padStart(2, '0');
  return `${neg ? 'T-' : 'T+'}${d > 0 ? d + '天 ' : ''}${p2(h)}:${p2(m)}:${p2(sec)}`;
}
