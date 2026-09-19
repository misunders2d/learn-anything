import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentorSupervisor } from '../skills/learn-anything/blocks/adapters/runtime.mjs';
import { PiRpcClient } from '../skills/learn-anything/blocks/adapters/pi-cli/rpc-client.mjs';
import { runCodex, MAX_PROMPT_BYTES } from '../skills/learn-anything/blocks/adapters/codex-cli/adapter.mjs';
import { usableCommand } from '../skills/learn-anything/blocks/execution/availability.mjs';
import { probeCapabilities } from '../skills/learn-anything/scripts/probe.mjs';
import { constructSession } from '../skills/learn-anything/scripts/construct.mjs';

function fakeChild({ ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (ignoreTerm && signal !== 'SIGKILL') return true;
    child.exitCode = 1;
    queueMicrotask(() => child.emit('exit', 1, signal));
    return true;
  };
  return child;
}

test('supervisor attach timeout kills child before retry and caps failed restarts', async () => {
  const children = [];
  let attempts = 0;
  const supervisor = new MentorSupervisor({
    spawnAdapter: () => { assert.ok(children.every((child) => child.exitCode !== null)); const child = fakeChild({ ignoreTerm: true }); children.push(child); return child; },
    waitUntilReady: async () => { if (++attempts > 1) throw new Error('attach timeout'); },
    sleep: async () => {}, maxRestarts: 2, killTimeoutMs: 5,
  });
  await supervisor.start();
  children[0].exitCode = 1;
  await supervisor.handleExit();
  assert.equal(children.length, 3);
  assert.equal(supervisor.child, null);
  assert.ok(children.slice(1).every((child) => child.signals.includes('SIGKILL')));
  await supervisor.stop();
});

test('initial supervisor attach timeout owns cleanup and healthy interval resets restart budget', async () => {
  const failed = fakeChild();
  const initial = new MentorSupervisor({ spawnAdapter: () => failed, waitUntilReady: async () => { throw new Error('timeout'); } });
  await assert.rejects(initial.start(), /timeout/);
  assert.notEqual(failed.exitCode, null);
  let time = 0;
  const children = [];
  const supervisor = new MentorSupervisor({ spawnAdapter: () => { const child = fakeChild(); children.push(child); return child; }, waitUntilReady: async () => {}, sleep: async () => {}, maxRestarts: 1, healthyMs: 100, now: () => time });
  await supervisor.start();
  children[0].exitCode = 1;
  await supervisor.handleExit();
  assert.equal(children.length, 2);
  time = 101;
  children[1].exitCode = 1;
  await supervisor.handleExit();
  assert.equal(children.length, 3);
  await supervisor.stop();
});

test('Codex sends large bounded prompts on stdin for new and resumed threads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mentor-codex-stdin-'));
  try {
    const fake = join(root, 'codex.mjs');
    await writeFile(fake, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({bytes:Buffer.byteLength(input),prefix:input.slice(0,8)})}}));});`);
    for (const threadId of [null, 'thread']) {
      let captured;
      const result = await runCodex({ sessionDir: root, threadId, prompt: 'PRIVATE:'.repeat(100_000), spawnImpl: (command, args, options) => { captured = args; return spawn(process.execPath, [fake], options); } });
      assert.equal(captured.at(-1), '-');
      assert.ok(captured.every((arg) => !arg.includes('PRIVATE:')));
      assert.ok(captured.includes('sandbox_mode="read-only"'));
      assert.ok(result.response.bytes <= MAX_PROMPT_BYTES);
      assert.equal(result.response.prefix, 'PRIVATE:');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function rpcFixture(root, mode) {
  const path = join(root, `${mode}.mjs`);
  await writeFile(path, `
import { createInterface } from 'node:readline';
const send=value=>console.log(JSON.stringify(value));
let prompts=0;
for await (const line of createInterface({input:process.stdin})) {
 const c=JSON.parse(line);
 if(c.type==='get_state') send({id:c.id,type:'response',success:true,data:{model:{id:'model',provider:'test'},sessionId:${JSON.stringify(mode === 'identity' ? 'foreign' : 'course')},isStreaming:${mode === 'busy'},isCompacting:false,pendingMessageCount:0,messageCount:0}});
 if(c.type==='prompt') { send({id:c.id,type:'response',success:true}); if(++prompts>1){send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'second only'}]}});send({type:'agent_settled'});} }
 if(c.type==='abort' && ${mode !== 'abort-hang'}) {send({id:c.id,type:'response',success:true});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'late old answer'}]}});send({type:'agent_settled'});}
}`);
  return new PiRpcClient({ command: process.execPath, args: [path], cwd: root, timeoutMs: 60, abortTimeoutMs: 150, expectedSessionId: 'course' });
}

for (const mode of ['resync', 'abort-hang', 'identity', 'busy']) {
  test(`Pi RPC ${mode} is fenced by readiness/abort state`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mentor-rpc-timeout-'));
    const client = await rpcFixture(root, mode);
    try {
      if (['identity', 'busy'].includes(mode)) {
        await assert.rejects(client.ready(), mode === 'identity' ? /identity mismatch/ : /not idle/);
        assert.equal(client.closed, true);
      } else {
        await client.ready();
        await assert.rejects(client.prompt('first'), /timed out/);
        if (mode === 'resync') {
          assert.equal(client.closed, false);
          assert.equal((await client.prompt('second')).assistantText, 'second only');
        } else {
          assert.equal(client.closed, true);
          await assert.rejects(client.prompt('second'), /not ready/);
        }
      }
    } finally { client.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('explicit manual profile works on Node-only host and cross-provider migration resets identity only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mentor-profile-'));
  const caps = { platform: process.platform, node: process.version, commands: { node: process.execPath }, languages: { javascript: true }, features: {}, warnings: [] };
  const capabilityProbe = () => caps;
  try {
    const created = await constructSession({ topic: 'Acting', root, profile: 'portable-shell', capabilityProbe });
    const saved = JSON.parse(await readFile(created.sessionPath));
    saved.agentSessionId = 'foreign-id'; saved.mentorModel = 'foreign/model'; saved.mentorSessionInitialized = true;
    saved.transcript = [{ id: 'q', role: 'user', content: 'Stage presence' }]; saved.progress = { milestone: 3 };
    await writeFile(created.sessionPath, JSON.stringify(saved));
    caps.commands.pi = '/fake/pi'; caps.features.piPersistentMentor = true;
    await constructSession({ topic: 'Acting', root, profile: 'pi-cli', capabilityProbe, migrate: true });
    const migrated = JSON.parse(await readFile(created.sessionPath));
    assert.notEqual(migrated.agentSessionId, 'foreign-id'); assert.ok(migrated.agentSessionId);
    assert.equal(migrated.mentorModel, null); assert.equal(migrated.mentorSessionInitialized, false);
    assert.deepEqual(migrated.transcript, saved.transcript); assert.deepEqual(migrated.progress, saved.progress); assert.deepEqual(migrated.canvas, saved.canvas);
    await constructSession({ topic: 'Acting', root, profile: 'portable-shell', capabilityProbe, migrate: true });
    assert.equal(JSON.parse(await readFile(created.sessionPath)).agentSessionId, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime probe rejects broken mise shim and kills hanging version check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mentor-shim-'));
  try {
    const java = join(root, 'java');
    await writeFile(java, '#!/bin/sh\necho "mise ERROR No version is set for command java" >&2\nexit 1\n'); await chmod(java, 0o755);
    assert.equal(usableCommand(java), false);
    const caps = probeCapabilities({ resolveCommand: (name) => name === 'node' ? process.execPath : ['java', 'javac'].includes(name) ? java : null });
    assert.equal(caps.languages.java, false); assert.equal(caps.commands.java, null);
    const hanging = join(root, 'hung'); await writeFile(hanging, '#!/bin/sh\nwhile :; do :; done\n'); await chmod(hanging, 0o755);
    const started = Date.now(); assert.equal(usableCommand(hanging, { timeout: 40 }), false); assert.ok(Date.now() - started < 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supervisor attach failure reaps an actual running process', async () => {
  let child;
  const supervisor = new MentorSupervisor({
    spawnAdapter: () => { child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); return child; },
    waitUntilReady: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); throw new Error('attach timeout'); },
    killTimeoutMs: 30,
  });
  await assert.rejects(supervisor.start(), /attach timeout/);
  assert.ok(child.exitCode !== null || child.signalCode);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
