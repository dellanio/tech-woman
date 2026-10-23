/** Cliente de teste dos handlers de rota (Request/Response reais, sem servidor). Sem testes próprios. */
import assert from 'node:assert/strict';

type Handler=(request:Request,context:never)=>Promise<Response>;
type WithContext=(request:Request,context?:{params:Promise<Record<string,string>>})=>Promise<Response>;
export type Opts={method?:string;body?:unknown;raw?:string;headers?:Record<string,string|null>;cookie?:string;csrf?:string;key?:string;params?:Record<string,string>};
export type Reply={status:number;json:any;text:string;headers:Headers};
export const origin=()=>String(process.env.APP_ORIGIN);

/** Chama o handler como o Next chamaria: Origin do app, same-origin e JSON por padrão; `headers` com null remove o cabeçalho. */
export async function call(handler:Handler,path:string,o:Opts={}):Promise<Reply>{
 const headers=new Headers({Origin:origin(),'Sec-Fetch-Site':'same-origin'});
 const hasBody=o.body!==undefined||o.raw!==undefined;
 if(hasBody)headers.set('Content-Type','application/json');
 if(o.cookie)headers.set('Cookie',`other=1; tw_session=${o.cookie}`);
 if(o.csrf)headers.set('X-CSRF-Token',o.csrf);
 if(o.key)headers.set('Idempotency-Key',o.key);
 for(const [k,v] of Object.entries(o.headers??{})){if(v===null)headers.delete(k);else headers.set(k,v);}
 const method=o.method??(hasBody?'POST':'GET');
 const response=await (handler as unknown as WithContext)(new Request(origin()+path,{method,headers,...(hasBody?{body:o.raw??JSON.stringify(o.body)}:{})}),o.params?{params:Promise.resolve(o.params)}:undefined);
 const text=await response.text();
 return {status:response.status,json:text?JSON.parse(text):null,text,headers:response.headers};
}
export const code=(r:Reply)=>String(r.json?.error?.code);
/** Valor e atributos do cookie tw_session em Set-Cookie (null se ausente). */
export function sessionCookie(r:Reply):{token:string;attrs:string[]}|null{
 const raw=r.headers.get('set-cookie');if(!raw)return null;
 const [pair,...attrs]=raw.split(';').map(v=>v.trim());const [name,...value]=pair.split('=');
 return name==='tw_session'?{token:value.join('='),attrs}:null;
}
export const sameShape=(a:Reply,b:Reply)=>JSON.stringify([a.status,a.json?.data??a.json?.error])===JSON.stringify([b.status,b.json?.data??b.json?.error]);
/** Captura tudo que o processo escreve em console/stdout/stderr durante o fluxo. */
export function captureOutput(){
 const chunks:string[]=[];const restore:(()=>void)[]=[];
 for(const name of ['log','info','warn','error','debug'] as const){const original=console[name];console[name]=(...args:unknown[])=>{chunks.push(args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' '));};restore.push(()=>{console[name]=original;});}
 for(const stream of [process.stdout,process.stderr]){const original=stream.write.bind(stream);stream.write=((chunk:string|Uint8Array)=>{if(typeof chunk==='string'&&!chunk.startsWith('▶')&&!chunk.includes('✔')&&!chunk.includes('✖'))chunks.push(chunk);return original(chunk);}) as typeof stream.write;restore.push(()=>{stream.write=original as typeof stream.write;});}
 return {text:()=>chunks.join('\n'),stop:()=>{for(const r of restore)r();}};
}
export const has=(haystack:string,needles:string[])=>needles.some(n=>n.length>0&&haystack.includes(n));
void assert;
