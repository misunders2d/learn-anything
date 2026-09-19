import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const milestone = { title: 'Observe stage presence', takeaway: 'A deliberate pause changes audience attention.', nextStep: 'Try a pause before the next line.', concepts: ['pause'], misconceptions: [] };
const patternMessages = [
  { version: 'v0.9', createSurface: { surfaceId: 'example', catalogId: 'urn:learn-anything:catalog:v1' } },
  { version: 'v0.9', updateComponents: { surfaceId: 'example', components: [{ id: 'root', component: 'Markdown', content: 'Compare the same line with and without a pause.' }] } },
  { version: 'v0.9', updateDataModel: { surfaceId: 'example', path: '/', value: { title: 'Compare delivery' } } },
];
const pattern = { title: 'Compare delivery', description: 'Use two readings of one generic line to compare a pause.', tags: ['acting'], a2ui_jsonl: patternMessages.map((value) => JSON.stringify(value)).join('\n') };
const typedPattern = { title: pattern.title, description: pattern.description, tags: pattern.tags, surface_plan: { operations: [
  { kind: 'create_surface', surface_id: 'example' },
  { kind: 'update_components', surface_id: 'example', components: patternMessages[1].updateComponents.components },
  { kind: 'update_data_model', surface_id: 'example', path: '/', value: { title: 'Compare delivery' } },
] } };
const answer = { message: 'A pause gives the audience time to notice the change.', focus: 'chat', messages: [], a2ui_jsonl: null, continuationKind: 'question', continuation_kind: 'question', continuation: 'What changed when you paused?', milestone, pattern };
const typedAnswer = { contractVersion: 1, message: answer.message, presentation: 'chat', continuation: { kind: 'question', text: answer.continuation }, milestone, pattern: typedPattern };

async function fixtures(root) {
  const sdk = join(root, 'sdk.mjs');
  await writeFile(sdk, `
export const tool=(name,description,schema,handler)=>({name,handler});
export const createSdkMcpServer=value=>value;
export async function startup({options}) {
 return {query(input){
   const iterator=input[Symbol.asyncIterator]();
   const stream=(async function*(){
     let item=await iterator.next();
     while(!item.done){
       if(!item.value.message.content.includes('Generic teaching examples')) throw new Error('missing Claude examples');
       if(!item.value.message.content.includes('Constructor prepared acting plan')) throw new Error('missing Claude course brief');
       if(item.value.message.content.includes('Learner asks an inline clarification')) throw new Error('Unanchored work question constrained as inline clarification');
       // Match the installed SDK's eager streamInput behavior.
       const next=iterator.next();
       yield {type:'stream_event',event:{type:'content_block_start',content_block:{type:'text',text:'Uncommitted prose must never publish'}}};
       await new Promise(resolve=>setTimeout(resolve,25));
       if(process.env.ADAPTER_TEST_MODE!=='failure') await options.mcpServers.learn_anything.tools[0].handler(process.env.ADAPTER_TEST_MODE==='malformed'?{...${JSON.stringify(answer)},message:''}:${JSON.stringify(answer)});
       yield {type:'result',subtype:process.env.ADAPTER_TEST_MODE==='failure'?'error_during_execution':'success',errors:['Provider unavailable']};
       item=await next;
     }
   })();
   stream.close=async()=>{};
   return stream;
 },close(){}};
}
`);
  const loader = join(root, 'loader.mjs');
  await writeFile(loader, `export async function resolve(specifier,context,next){ if(specifier==='@anthropic-ai/claude-agent-sdk') return {url:${JSON.stringify(pathToFileURL(sdk).href)},shortCircuit:true}; return next(specifier,context); }`);
  const codex = join(root, 'codex');
  await writeFile(codex, `#!${process.execPath}
if(process.argv.includes('login')) process.exit(0);
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 if(!input.includes('Generic teaching examples')){process.exitCode=3;return;}
 if(!input.includes('Constructor prepared acting plan')){process.exitCode=5;return;}
 if(input.includes('Learner asks an inline clarification')){process.exitCode=6;return;}
 if(process.env.ADAPTER_TEST_MODE==='failure'){console.error('Provider unavailable');process.exitCode=1;return;}
 console.log(JSON.stringify({type:'thread.started',thread_id:'course'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.env.ADAPTER_TEST_MODE==='malformed'?'not JSON':JSON.stringify(${JSON.stringify(answer)})}}));
});`); await chmod(codex, 0o755);
  const pi = join(root, 'pi');
  await writeFile(pi, `#!${process.execPath}
import {createInterface} from 'node:readline';
const send=value=>console.log(JSON.stringify(value));
let coursePrompts=0;
for await (const line of createInterface({input:process.stdin})){
 const c=JSON.parse(line);
 if(c.type==='get_state') send({type:'response',id:c.id,success:true,data:{model:{provider:'test',id:'model'},sessionId:'course',isStreaming:false,isCompacting:false,pendingMessageCount:0,messageCount:0}});
 if(c.type==='abort'){send({type:'response',id:c.id,success:true});send({type:'agent_settled'});}
 if(c.type==='prompt'){
  send({type:'response',id:c.id,success:true});
  const preflight=c.message.startsWith('Readiness check.');
  if(!preflight && ++coursePrompts===1 && (!c.message.includes('Generic teaching examples') || !c.message.includes('Prior offline practice'))) process.exit(4);
  if(!preflight && !c.message.startsWith('Your structured browser candidate') && !c.message.includes('Constructor prepared acting plan')) process.exit(5);
  if(!preflight && process.env.ADAPTER_TEST_MODE==='failure') send({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'Provider unavailable',content:[]}});
  else send({type:'tool_execution_end',toolName:'complete_mentor_turn',isError:false,result:{details:{...${JSON.stringify(typedAnswer)},message:preflight?'pi-ready':process.env.ADAPTER_TEST_MODE==='malformed'?'':${JSON.stringify(answer.message)}}}});
  send({type:'agent_settled'});
 }
}
`); await chmod(pi, 0o755);
  return { loader, pi };
}

for (const adapter of ['claude-agent-sdk', 'codex-cli', 'pi-cli']) {
  for (const mode of ['success', 'malformed', 'failure']) {
    test(`${adapter}: ${mode} obeys atomic turn, diagnostic-only errors and sequential delivery`, { timeout: 10_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'adapter-conformance-'));
      let child;
      const sockets = new Set();
      const calls = [];
      let active = false, overlapping = false, delivered = 0, completed = 0;
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      let stderr = '';
      const session = { slug: 'acting', topic: 'Acting', security: { accessToken: 'test-token' }, agentSessionId: 'course', mentorSessionInitialized: true, transcript: [{id:'prior',role:'user',content:'Prior offline practice'}], canvas: {} };
      const server = createServer(async (req, res) => {
        const path = new URL(req.url, 'http://localhost').pathname;
        res.setHeader('content-type', 'application/json');
        if (path === '/api/session') { res.end(JSON.stringify(session)); return; }
        if (path === '/api/mentor/next') {
          if (delivered >= 2) return;
          if (active) overlapping = true;
          active = true;
          const id = ++delivered;
          res.end(JSON.stringify({ type: 'user_message', courseBrief: 'Constructor prepared acting plan', teachingPatterns: [{title:'Generic pause comparison', messages:patternMessages}], message: { id: `q-${id}`, content: 'Explain stage presence.', source: 'work' }, mentorTurn: { id: `turn-${id}`, baseRevision: id } }));
          return;
        }
        let body = ''; for await (const chunk of req) body += chunk;
        const value = body ? JSON.parse(body) : {};
        calls.push({ path, value });
        if (path === '/api/mentor/turn' || path === '/api/mentor/event' && value.type === 'RUN_ERROR') { active = false; completed++; }
        res.end('{"accepted":true}');
        if (completed === 2) resolveDone();
      });
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        const fixture = await fixtures(root);
        session.assembly = { capabilities: { commands: { pi: fixture.pi } } };
        await writeFile(join(root, 'session.json'), JSON.stringify(session));
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const entry = resolve(`skills/learn-anything/blocks/adapters/${adapter}/adapter.mjs`);
        const args = adapter === 'claude-agent-sdk' ? ['--loader', fixture.loader, entry] : [entry];
        child = spawn(process.execPath, [...args, '--url', `http://127.0.0.1:${server.address().port}`, '--session', root], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ADAPTER_TEST_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const earlyExit = new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`adapter exited ${code}: ${stderr}`))));
        await Promise.race([done, earlyExit]);
        assert.equal(overlapping, false);
        assert.equal(delivered, 2);
        assert.equal(calls.some(({ path, value }) => path.startsWith('/api/a2ui') || String(value.type).startsWith('TEXT_MESSAGE_')), false);
        const commits = calls.filter(({ path }) => path === '/api/mentor/turn');
        const errors = calls.filter(({ value }) => value.type === 'RUN_ERROR');
        if (mode === 'success') {
          assert.equal(commits.length, 2); assert.equal(errors.length, 0);
          for (const [index, { value }] of commits.entries()) {
            assert.equal(value.turnId, `turn-${index + 1}`); assert.equal(value.baseRevision, index + 1);
            assert.equal(value.message, answer.message); assert.deepEqual(value.milestone, milestone);
            assert.equal(value.presentation, 'chat'); assert.deepEqual(value.messages, []);
            assert.deepEqual(value.pattern, {title: pattern.title, description: pattern.description, tags: pattern.tags, messages: patternMessages});
          }
        } else {
          assert.equal(commits.length, 0); assert.equal(errors.length, 2);
          for (const [index, { value }] of errors.entries()) { assert.equal(value.turnId, `turn-${index + 1}`); assert.equal(value.baseRevision, index + 1); }
        }
      } finally {
        if (child?.exitCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 500);
          await exited; clearTimeout(timer);
        }
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
