// Synthetic local endpoint regression. Never uses production data or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-draft-flyer-'));
const port = Number(process.env.PORT || 4849), base = `http://localhost:${port}`, origin = 'https://tools.synthetic.invalid';
const token = 'synthetic-studio-token-' + 'x'.repeat(32), agent = 'synthetic-agent-token-' + 'y'.repeat(32);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
const db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(Date.now());
const notice = JSON.stringify({ kind: 'event', links: [], eventDate: '2026-12-01' });
const insert = db.prepare("INSERT INTO drafts(status,source,title,body,section,area,date,created_at,updated_at,announcement,submitter_email,agent_note,source_url) VALUES('new','agent',?,'Synthetic body','news','conference','2026-10-22',1,1,?,'private-sentinel@example.invalid','private-note-sentinel','https://example.invalid/private-source-' || lower(hex(randomblob(4))))");
const ordinary = Number(insert.run('Ordinary synthetic draft', null).lastInsertRowid);
const id = Number(insert.run('Synthetic event draft', notice).lastInsertRowid);
const other = Number(insert.run('Other synthetic event', notice).lastInsertRowid);
const photo = (draft, name, position) => {
 const rel = `${draft}/${name}.png`; fs.mkdirSync(path.join(scratch, 'uploads', String(draft)), { recursive: true }); fs.writeFileSync(path.join(scratch, 'uploads', rel), png);
 return Number(db.prepare('INSERT INTO draft_photos(draft_id,path,ext,alt,position,created_at) VALUES(?,?,\'png\',?, ?,1)').run(draft, rel, 'Synthetic flyer description', position).lastInsertRowid);
};
photo(ordinary, 'ordinary', 0); const otherId = photo(other, 'other', 0); const galleryId = photo(id, 'gallery', 1); const lead = photo(id, 'flyer', 0);
const server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST:'127.0.0.1', PORT:String(port), DATA_DIR:scratch, SITE_URL:base, PUBLISH_TOKEN:token, AGENT_API_TOKEN:agent, PUBLISH_ORIGINS:origin, AUTH_SECRET:'synthetic-auth-'+'a'.repeat(32), RESEND_API_KEY:'', GDRIVE_SERVICE_ACCOUNT_JSON:'', GDRIVE_FOLDER_ID:'' }, stdio:['ignore','pipe','pipe'] });
const logs=[]; server.stdout.on('data',d=>logs.push(String(d))); server.stderr.on('data',d=>logs.push(String(d)));
let checks=0; const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
const call=(url,auth=token,method='GET')=>fetch(base+url,{method,headers:{Origin:origin,...(auth?{Authorization:'Bearer '+auth}:{})}});
const uri=(d,p,k)=>`/api/studio-draft-flyer?draftId=${d}&photoId=${p}&key=${k}`;
try {
 for(let n=0;n<100;n++){try{await fetch(base+'/api/agent/sections');break;}catch{await new Promise(r=>setTimeout(r,50));}}
 let list=await(await call('/api/stories?limit=50')).json(), draft=list.drafts.find(d=>d.id===id), desc=draft.draftFlyer;
 check('open typed announcement exposes a scoped flyer descriptor',desc.draftId===id&&desc.photoId===lead&&/^[a-f0-9]{32}$/.test(desc.key));
 check('ordinary draft uploads remain excluded',!list.drafts.find(d=>d.id===ordinary).draftFlyer);
 check('draft descriptor has only safe identifiers and description',Object.keys(desc).sort().join(',')==='alt,draftId,key,photoId');
 check('Studio list has no upload paths, private contacts, source or agent notes',!['/uploads/','/api/admin/photos/','private-sentinel','private-note-sentinel','private-source'].some(s=>JSON.stringify(list).includes(s)));
 const endpoint=uri(id,lead,desc.key); let r=await call(endpoint);
 check('Studio token retrieves exact original flyer bytes',r.status===200&&Buffer.from(await r.arrayBuffer()).equals(png));
 check('flyer is no-store, sniffed PNG with matching CORS',r.headers.get('cache-control')==='no-store'&&r.headers.get('content-type')==='image/png'&&r.headers.get('access-control-allow-origin')===origin);
 check('anonymous request cannot read draft flyer',(await call(endpoint,'')).status===401);
 check('AI agent token cannot read a draft flyer',(await call(endpoint,agent)).status===401);
 check('wrong Studio token cannot read a draft flyer',(await call(endpoint,'synthetic-wrong-token')).status===401);
 check('preflight works without credentials',(await call(endpoint,'','OPTIONS')).status===204);
 check('POST cannot mutate or read a flyer',(await call(endpoint,token,'POST')).status===405);
 for(const url of [uri(other,lead,desc.key),uri(id,otherId,desc.key),uri(id,galleryId,desc.key),uri(id,lead,'0'.repeat(32)),uri('../',lead,desc.key),'/api/studio-draft-flyer?draftId=1&photoId=1&key=bad']) check('invalid/cross-draft/non-lead descriptor is refused', (await call(url)).status===404);
 db.prepare("UPDATE drafts SET status='published' WHERE id=?").run(id);check('closed drafts immediately lose flyer access',(await call(endpoint)).status===404);
 db.prepare("UPDATE drafts SET status='in_review',announcement=NULL WHERE id=?").run(id);check('ordinary story conversion immediately loses flyer access',(await call(endpoint)).status===404);
 db.prepare('UPDATE drafts SET announcement=? WHERE id=?').run(notice,id);
 db.prepare('UPDATE draft_photos SET position=9 WHERE id=?').run(lead);check('lead reorder invalidates previous flyer descriptor',(await call(endpoint)).status===404);db.prepare('UPDATE draft_photos SET position=0 WHERE id=?').run(lead);
 const file=path.join(scratch,'uploads',String(id),'flyer.png');fs.writeFileSync(file,'synthetic-not-an-image');check('non-image content cannot be served',(await call(endpoint)).status===404);
 fs.writeFileSync(file,Buffer.alloc(10*1024*1024+1));check('oversized files cannot be served',(await call(endpoint)).status===404);
 fs.unlinkSync(file);const outside=path.join(scratch,'outside.png');fs.writeFileSync(outside,png);fs.symlinkSync(outside,file);check('symlinked private file is refused',(await call(endpoint)).status===404);fs.unlinkSync(file);fs.writeFileSync(file,png);
 db.prepare('UPDATE draft_photos SET path=? WHERE id=?').run('../outside.png',lead);check('stored path traversal is refused',(await call(endpoint)).status===404);db.prepare('UPDATE draft_photos SET path=? WHERE id=?').run(`${id}/flyer.png`,lead);
 db.prepare('DELETE FROM draft_photos WHERE id=?').run(lead);const replacement=photo(id,'replacement',0);check('fixture exercises numeric photo ID reuse',replacement===lead);
 check('old media key cannot access replacement photo',(await call(endpoint)).status===404);
 list=await(await call('/api/stories')).json();const fresh=list.drafts.find(d=>d.id===id).draftFlyer;check('new descriptor has fresh identity and works',fresh.key!==desc.key&&(await call(uri(id,replacement,fresh.key))).status===200);
 check('draft flyer remains absent from public feed',!(await(await fetch(base+'/stories.json')).text()).includes('Synthetic event draft'));
 check('no credentials or private contact fields leak into logs',!logs.join('').includes(token)&&!logs.join('').includes(agent)&&!logs.join('').includes('private-sentinel'));
 console.log(`\n${checks} scoped draft-flyer checks passed.`);
} finally {db.close();const stopped=new Promise(r=>server.once('exit',r));server.kill();await Promise.race([stopped,new Promise(r=>setTimeout(r,2000))]);if(server.exitCode===null)server.kill('SIGKILL');fs.rmSync(scratch,{recursive:true,force:true});}
