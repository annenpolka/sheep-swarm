import {assertSupportedSchema} from './codex-worker.ts';

export interface GoToolCall {
 readonly id:string;
 readonly type:'function';
 readonly function:{readonly name:string;readonly arguments:string};
}
export interface GoAssistant {
 readonly role:'assistant';
 readonly content:string|null;
 readonly reasoning_content?:string;
 readonly tool_calls?:readonly GoToolCall[];
}
export type GoMessage = {readonly role:'system'|'user';readonly content:string}
 | GoAssistant | {readonly role:'tool';readonly tool_call_id:string;readonly content:string};
export interface GoTool {
 readonly type:'function';
 readonly function:{readonly name:string;readonly description:string;readonly parameters:Record<string,unknown>};
}
export interface GoConversation {readonly messages:readonly GoMessage[];readonly tools:readonly GoTool[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Preserve the assistant message, including provider thinking, for explicit replay. */
export function parseGoAssistant(value:unknown,finish:unknown,tools:readonly GoTool[]):GoAssistant {
 if(!object(value)||value.role!=='assistant'||value.refusal||value.function_call)throw new Error('invalid assistant message');
 if(value.content!==null&&typeof value.content!=='string')throw new Error('invalid assistant content');
 if(value.reasoning_content!==undefined&&typeof value.reasoning_content!=='string')throw new Error('invalid reasoning content');
 const calls:GoToolCall[]=[],ids=new Set<string>();
 if(value.tool_calls!==undefined&&value.tool_calls!==null){
  if(!Array.isArray(value.tool_calls))throw new Error('invalid tool calls');
  for(const call of value.tool_calls){
   if(!object(call)||typeof call.id!=='string'||!call.id||ids.has(call.id)||call.type!=='function'||!object(call.function)
    ||typeof call.function.name!=='string'||!tools.some(t=>t.function.name===(call.function as Record<string,unknown>).name)||typeof call.function.arguments!=='string')throw new Error('invalid tool call');
   ids.add(call.id);calls.push({id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments}});
  }
 }
 if(calls.length?finish!=='tool_calls':finish!=='stop'||!value.content?.trim())throw new Error('incomplete assistant turn');
 return {role:'assistant',content:value.content as string|null,
  ...(value.reasoning_content===undefined?{}:{reasoning_content:value.reasoning_content as string}),
  ...(calls.length?{tool_calls:calls}:{})};
}

/** Reject orphan, duplicate, missing and interleaved tool results before any network request. */
export function validateGoConversation(conversation:GoConversation):void {
 if(!Array.isArray(conversation.messages)||!conversation.messages.length||!Array.isArray(conversation.tools))throw new Error('invalid conversation');
 const names=new Set<string>();
 for(const tool of conversation.tools){
  if(tool?.type!=='function'||!tool.function||!tool.function.description||!/^\w{1,64}$/.test(tool.function.name)||names.has(tool.function.name))throw new Error('invalid tool definition');
  names.add(tool.function.name);assertSupportedSchema(tool.function.parameters);
 }
 const pending=new Set<string>(),seen=new Set<string>();
 for(const message of conversation.messages){
  if(!message)throw new Error('invalid message');
  if(message.role==='tool'){
   if(!pending.delete(message.tool_call_id)||typeof message.content!=='string')throw new Error('orphan or duplicate tool result');
  }else{
   if(pending.size)throw new Error('missing tool results');
   if(message.role==='assistant'){
    const parsed=parseGoAssistant(message,message.tool_calls?.length?'tool_calls':'stop',conversation.tools);
    // Tool-enabled thinking continuation requires even no-tool assistant turns to retain thinking.
    if(conversation.tools.length&&typeof parsed.reasoning_content!=='string')throw new Error('missing assistant reasoning for tool continuation');
    for(const call of parsed.tool_calls??[]){if(seen.has(call.id))throw new Error('reused tool call ID');seen.add(call.id);pending.add(call.id);}
   }else if(!['system','user'].includes(message.role)||typeof message.content!=='string')throw new Error('invalid message');
  }
 }
 if(pending.size)throw new Error('missing tool results');
 if(conversation.messages.at(-1)?.role==='assistant')throw new Error('conversation must end with host input');
}
