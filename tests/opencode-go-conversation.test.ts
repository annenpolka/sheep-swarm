import test from 'node:test';
import assert from 'node:assert/strict';
import {callOpenCodeGoTurn,callOpenCodeGo} from '../src/opencode-go-worker.ts';
import {validateGoConversation,type GoMessage,type GoTool} from '../src/opencode-go-conversation.ts';
const tools:GoTool[]=[{type:'function',function:{name:'lookup',description:'Get value',parameters:{type:'object'}}}];
const assistant={role:'assistant' as const,content:null,reasoning_content:'private carried state',tool_calls:[{id:'t1',type:'function' as const,function:{name:'lookup',arguments:'{}'}}]};
const response=(message:unknown,finish='stop')=>new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:finish,message}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
const base={model:'deepseek-flash',cwd:process.cwd(),timeoutMs:1000,maxTokens:100,apiKey:'test-key'};
test('Go tool conversation replays assistant thinking and matching results; legacy still rejects tools',async()=>{
 const messages:GoMessage[]=[{role:'user',content:'start'}];
 const first=await callOpenCodeGoTurn({...base,messages,tools,fetch:async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.equal(body.response_format,undefined);assert.equal(body.thinking.type,'enabled');return response(assistant,'tool_calls');}});
 messages.push(first.result,{role:'tool',tool_call_id:'t1',content:'host value'});
 const second=await callOpenCodeGoTurn({...base,messages,tools,fetch:async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.deepEqual(body.messages[1],assistant);return response({role:'assistant',content:'{"ok":true}',reasoning_content:'continued'});}});
 assert.equal(second.transcript.usageCompleteness,'complete');assert.equal(second.result.content,'{"ok":true}');
 await assert.rejects(()=>callOpenCodeGo({...base,prompt:'start',schema:{type:'object'},fetch:async()=>response(assistant,'tool_calls')}));
});
test('Go continuation rejects orphan/missing/duplicate tools and missing thinking before network',()=>{
 const prefix:GoMessage[]=[{role:'user',content:'start'},assistant];
 for(const messages of [prefix,[{role:'tool',tool_call_id:'x',content:'bad'}],[...prefix,{role:'user',content:'interleaved'}],[...prefix,{role:'tool',tool_call_id:'t1',content:'ok'},{role:'tool',tool_call_id:'t1',content:'duplicate'}],[{role:'assistant',content:'old'}, {role:'user',content:'continue'}]]as GoMessage[][])assert.throws(()=>validateGoConversation({messages,tools}));
});
test('Go continuation rejects incomplete finish, unknown tools, missing thinking and unsupported models',async()=>{
 for(const [message,finish]of [[assistant,'length'],[{...assistant,tool_calls:[{...assistant.tool_calls[0]!,function:{name:'other',arguments:'{}'}}]},'tool_calls'],[{role:'assistant',content:'{}'},'stop']]as const){
  await assert.rejects(()=>callOpenCodeGoTurn({...base,messages:[{role:'user',content:'start'}],tools,fetch:async()=>response(message,finish)}));
 }
 await assert.rejects(()=>callOpenCodeGoTurn({...base,model:'gpt-5.6-luna',messages:[{role:'user',content:'start'}],tools}));
});

test('production lazy tool schema passes the real adapter preflight',async()=>{
 const {lazyTools}=await import('../src/repo-lazy-run.ts');
 validateGoConversation({messages:[{role:'user',content:'start'}],tools:lazyTools});
});
