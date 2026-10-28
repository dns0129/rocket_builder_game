import { generatePatch, type PatchJob } from './terrainGen';

self.onmessage = (e: MessageEvent<PatchJob>) => {
  const r = generatePatch(e.data);
  (self as unknown as Worker).postMessage(r, [r.pos.buffer, r.normal.buffer, r.uv.buffer, r.uv1.buffer]);
};
