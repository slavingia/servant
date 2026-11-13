import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { frameOrigins, workspaceConfig } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Only public workspace metadata is bundled. Never copy server config or data.
const config = process.env.SERVANT_DESKTOP_WORKSPACE
  ? workspaceConfig(JSON.parse(fs.readFileSync(process.env.SERVANT_DESKTOP_WORKSPACE, 'utf8')), { allowLoopback: process.env.SERVANT_DESKTOP_TEST === '1' })
  : null;
fs.writeFileSync(path.join(here, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
// Extra https origins the window may frame, e.g. a GitHub Pages site with prototype previews.
fs.writeFileSync(path.join(here, 'frame-origins.json'), JSON.stringify(frameOrigins(process.env.SERVANT_DESKTOP_FRAME_ORIGINS)) + '\n');
// The public certificate that interface updates must be signed against.
fs.copyFileSync(path.join(here, '../app/certs/certificate.pem'), path.join(here, 'ota-certificate.pem'));
const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', '../desktop/web'], {
  cwd: path.join(here, '../app'), stdio: 'inherit', env: { ...process.env, CI: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
