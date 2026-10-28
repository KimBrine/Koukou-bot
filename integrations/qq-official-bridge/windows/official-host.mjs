import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './app/integrations/qq-official-bridge/cli.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const stopFile = path.join(root, 'profile', 'bridge', 'stop.request');
await fs.rm(stopFile, {force: true});
const bridge = await main(process.argv.slice(2));
let closing = false;
const timer = setInterval(async () => {
  if (closing) return;
  try { await fs.access(stopFile); } catch { return; }
  closing = true;
  clearInterval(timer);
  await bridge.close();
  await fs.rm(stopFile, {force: true});
  console.log('Official QQ bridge stopped cleanly.');
}, 500);
