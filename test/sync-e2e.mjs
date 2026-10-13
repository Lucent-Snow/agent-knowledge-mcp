// Optional real Syncthing test: two temporary loopback peers, no user services touched.
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {KnowledgeStore} from '../src/store.mjs';
import {prepareSync} from '../src/sync.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const cli = new URL('../src/cli.mjs', import.meta.url);
const exec=promisify(execFile), children=[], clients=[];
const base=await mkdtemp(path.join(tmpdir(),'knowledge-sync-e2e-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
async function waitFor(fn, label) {for(let i=0;i<120;i++){try{if(await fn())return}catch{}await sleep(250)}throw new Error('Timeout: '+label)}
try {
 const nodes=[];
 for(const name of ['a','b']) {
  const home=path.join(base,name+'-config'), root=path.join(base,name+'-memory');
  await exec('syncthing',['generate','--home',home,'--no-port-probing']);
  const xml=await readFile(path.join(home,'config.xml'),'utf8');
  const id=xml.match(/<device id="([^"]+)"/)[1], key=xml.match(/<apikey>([^<]+)<\/apikey>/)[1];
  nodes.push({home,root,xml,id,key,sync:await port(),gui:await port()});
 }
 const stores=nodes.map(n=>new KnowledgeStore({root:n.root}));
 await stores[0].initialize();
 for(const s of stores)await prepareSync(s);
 for(let i=0;i<2;i++) {
  const n=nodes[i], peer=nodes[1-i];
  let xml=n.xml.replace(/<folder\b[\s\S]*?<\/folder>/g,'');
  xml=xml.replace(/<address>127\.0\.0\.1:8384<\/address>/,`<address>127.0.0.1:${n.gui}</address>`);
  xml=xml.replace(/<listenAddress>[^<]+<\/listenAddress>/g,`<listenAddress>tcp://127.0.0.1:${n.sync}</listenAddress>`);
  for(const tag of ['globalAnnounceEnabled','localAnnounceEnabled','relaysEnabled','natEnabled','startBrowser'])xml=xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`,'g'),`<${tag}>false</${tag}>`);
  xml=xml.replace(/<autoUpgradeIntervalH>[^<]*<\/autoUpgradeIntervalH>/,'<autoUpgradeIntervalH>0</autoUpgradeIntervalH>');
  xml=xml.replace(/<urAccepted>[^<]*<\/urAccepted>/,'<urAccepted>-1</urAccepted>');
  const folder=`<folder id="memory-test" label="memory-test" path="${n.root}" type="sendreceive" rescanIntervalS="1" fsWatcherEnabled="false"><device id="${n.id}"/><device id="${peer.id}"/></folder>`;
  const device=`<device id="${peer.id}" name="isolated-peer"><address>tcp://127.0.0.1:${peer.sync}</address></device>`;
  xml=xml.replace('<gui ',folder+device+'<gui ');
  await writeFile(path.join(n.home,'config.xml'),xml);
  const p=spawn('syncthing',['serve','--home',n.home,'--no-browser','--no-upgrade','--no-restart','--no-port-probing','--log-level','WARN'],{stdio:['ignore','pipe','pipe']});
  p.stdout.on('data',()=>{});p.stderr.on('data',()=>{});children.push(p);
 }
 const api=async(n,url,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${n.gui}/rest/${url}`,{method,headers:{'X-API-Key':n.key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error('Syncthing API '+r.status);return r.status===204?null:await r.text()};
 for(const n of nodes)await waitFor(async()=>{await api(n,'system/status');return true},'daemon startup');
 await waitFor(async()=>{const d=await stores[1].read('memory://context/global/memory-system',{relations:'none'});return d.body.includes('Memory usage guide')},'seed replication');
 for(const n of nodes){const c=new Client({name:'isolated-sync-test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(cli),'serve','--root',n.root]}));clients.push(c)}
 const call=async(c,name,args)=>{const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return r.structuredContent};
 const uri='memory://project/sync-roundtrip';
 await call(clients[0],'knowledge_write',{mode:'create',uri,name:'Sync roundtrip',description:'isolated two-peer test',body:'created on A'});
 await waitFor(async()=> (await stores[1].read(uri,{relations:'none'})).body==='created on A','create replication');
 const b=await call(clients[1],'knowledge_read',{uri});
 await call(clients[1],'knowledge_write',{mode:'update',uri,op:'replace',body:'updated on B',expectedEtag:b.etag});
 await waitFor(async()=> (await stores[0].read(uri,{relations:'none'})).body==='updated on B','reverse update');
 const a=await call(clients[0],'knowledge_read',{uri});
 await call(clients[0],'knowledge_delete',{uri,expectedEtag:a.etag});
 await waitFor(async()=>{try{await stores[1].read(uri,{relations:'none'});return false}catch(e){return e.code==='NOT_FOUND'}},'delete replication');
 // Put a private file outside the four memory trees and ensure it never transfers.
 await writeFile(path.join(nodes[0].root,'should-not-sync.txt'),'private local data');
 for(const n of nodes)await api(n,'db/scan?folder=memory-test','POST');
 await sleep(1500);
 let privateTransferred=false;try{await readFile(path.join(nodes[1].root,'should-not-sync.txt'));privateTransferred=true}catch{}
 if(privateTransferred)throw new Error('Ignore allowlist failed');
 console.log(JSON.stringify({seedReplication:true,createReplication:true,reverseUpdate:true,deleteReplication:true,nonMemoryExcluded:true,isolatedPeers:2}));
} finally {
 for(const c of clients)await c.close().catch(()=>{});
 for(const p of children)p.kill('SIGTERM');
 await Promise.all(children.map(p=>new Promise(r=>{if(p.exitCode!==null)return r();p.once('close',r);setTimeout(()=>{p.kill('SIGKILL');r()},3000).unref()})));
 await rm(base,{recursive:true,force:true});
}
