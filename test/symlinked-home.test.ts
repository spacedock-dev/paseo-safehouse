import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as service from '../server/service';
import { run } from '../server/policy';

// PASEO_HOME reaches the daemon home through a symlink, as /tmp -> /private/tmp does on macOS.
test('symlinked daemon home launches the prepared snapshot and keeps the guard strict', { skip: process.platform !== 'darwin' }, async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.safehouse-symlinked-home-')));
  const real = path.join(base, 'real-home'), link = path.join(base, 'link-home'), cwd = path.join(base, 'workspace');
  await fs.mkdir(real); await fs.mkdir(cwd); await fs.symlink(real, link);
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = link;
  t.after(async () => { if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome; await fs.rm(base, { recursive: true, force: true }); });
  await fs.writeFile(path.join(real, 'config.json'), JSON.stringify({ daemon: { listen: '127.0.0.1:9' }, plugins: { 'paseo-safehouse': { path: process.cwd() } } }));
  let config: any = { providers: { probe: { extends: 'acp', command: [process.execPath], paseoTools: { enabled: true } } } };
  const paseo: any = { config: { get: async () => ({ config }), patch: async (p: any) => { config = { ...config, providers: { ...config.providers, ...p.providers } }; } } };
  await service.setup(paseo);
  const saved = await service.installation();
  assert.ok(saved);
  assert.equal(saved.home, real);

  // One canonical spelling for every state path, and the derived launcher runs the prepared session under real Safehouse.
  const opened: any = await service.prepareOpening({ agentId: 'agent', provider: 'safehouse-probe', cwd, reason: 'create', env: {}, tools: [], mcpServers: {} } as any, paseo);
  const workdir = opened.env.SAFEHOUSE_WORKDIR;
  const receipt = JSON.parse(await fs.readFile(service.receiptPath('agent'), 'utf8'));
  const launcher = config.providers['safehouse-probe'].command;
  const launch = (dir: string) => run(launcher[0], [...launcher.slice(1), '-e', 'console.log("sentinel")'], { cwd, env: { ...process.env, ...opened.env, SAFEHOUSE_WORKDIR: dir }, timeout: 45000 })
    .then(r => r.stdout.trim(), (e: any) => `exit ${e.code}: ${String(e.stderr).trim()}`);
  // The guard still refuses a folder outside the snapshots folder and the symlinked spelling of a real snapshot.
  const outside = path.join(base, 'outside'); await fs.mkdir(outside);
  await fs.copyFile(path.join(workdir, '.safehouse'), path.join(outside, '.safehouse'));
  const refused = 'exit 78: A prepared Safehouse snapshot is required for this launch.';
  assert.deepEqual({
    stateRoot: service.stateRoot(),
    snapshots: path.dirname(workdir),
    receipt: receipt.snapshot,
    prepared: await launch(workdir),
    outside: await launch(outside),
    linkedSpelling: await launch(path.join(link, 'safehouse', 'snapshots', path.basename(workdir))),
  }, {
    stateRoot: path.join(saved.home, 'safehouse'),
    snapshots: path.join(saved.home, 'safehouse', 'snapshots'),
    receipt: workdir,
    prepared: 'sentinel',
    outside: refused,
    linkedSpelling: refused,
  });
});
