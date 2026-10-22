// Synthetic publication, original generated graphics and a disposable local server only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
if (!process.env.AXE_JS || !fs.existsSync(process.env.AXE_JS)) throw new Error('Set AXE_JS to axe.min.js; this design suite requires its accessibility checks.');
const base = 'http://localhost:4885', scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-publication-design-'));
const shots = process.env.SHOTS || '/workspace/review-artifacts/publication-redesign'; fs.mkdirSync(shots, { recursive: true });
let server, browser, db, checks = 0;
const logs = [], check = (label, condition) => { assert.ok(condition, label); checks++; console.log('PASS ' + label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const crc = (bytes) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let k=0;k<8;k++) n = n&1 ? 0xedb88320 ^ n>>>1 : n>>>1; } return (n^0xffffffff)>>>0; };
const chunk = (name, bytes) => { const all=Buffer.concat([Buffer.from(name),bytes]), length=Buffer.alloc(4), checksum=Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(all)); return Buffer.concat([length,all,checksum]); };
function graphic(width, height, flyer=false) {
 const rows=Buffer.alloc((width*3+1)*height);
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const at=y*(width*3+1)+1+x*3, band=flyer ? y<height*.25 || y>height*.82 : y>height*(.5+.15*Math.sin(x/width*6));
  const color=band ? [11,57+Math.floor(x/width*40),84] : [45+Math.floor(x/width*80),180+Math.floor(y/height*30),185];
  rows[at]=color[0];rows[at+1]=color[1];rows[at+2]=color[2];
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
try {
 db=openDatabase(scratch);runMigrations(db,readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
 const run=(sql,...args)=>db.prepare(sql).run(...args), row=(sql,...args)=>db.prepare(sql).get(...args);
 const now=Date.now(); run("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)",now);
 const user=Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('synthetic-design@example.invalid','Synthetic Editor','admin','active',?,?)",now,now).lastInsertRowid), token=randomBytes(32).toString('base64url');
 run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)',createHash('sha256').update(token).digest('hex'),user,now,now,now+3600000);
 const body='## A place to belong\n\nThis is synthetic editorial content created for a local design review. It does not describe a real event, person or congregation. '.repeat(6)+'\n\n> There is room for every story.\n\nA final synthetic paragraph keeps the reading column and line spacing visible.';
 function seed(slug,title,section='news',eventDate=null,extras=[]) {
  const image=`/media/stories/${slug}/image.png`, bytes=graphic(eventDate?320:960,eventDate?480:540,!!eventDate), rel=image.slice('/media/'.length);
  fs.mkdirSync(path.dirname(path.join(scratch,'media',rel)),{recursive:true});fs.writeFileSync(path.join(scratch,'media',rel),bytes);
  const meta=eventDate?JSON.stringify({kind:'event',eventDate,location:'Synthetic Community Hall',links:[]}):null;
  const id=Number(run("INSERT INTO stories(slug,title,dek,section,area,author,date,image,image_alt,body,status,source,published_at,updated_at,announcement,featured,additional_sections) VALUES(?,?,?,?,?,'Synthetic Editor','2026-10-22',?, ?,?,'live','editor',?,?,?,1,?)",slug,title,'Stories of connection, service and a living faith. Synthetic preview content.',section,section==='news'?'camp':'',image,eventDate?'Synthetic portrait flyer; event details are also provided in text.':'Synthetic geometric landscape for design verification.',body,now,now,meta,JSON.stringify(extras)).lastInsertRowid);
  run("INSERT INTO story_photos(story_id,position,kind,path,alt,bytes,sha256,focal_x,focal_y,zoom) VALUES(?,0,'lead',?,?,?, ?,17,83,1.8)",id,rel,eventDate?'Synthetic flyer':'Synthetic landscape',bytes.length,createHash('sha256').update(bytes).digest('hex'));
 }
 const future=(days)=>new Date(now+days*86400000).toISOString().slice(0,10);
 seed('synthetic-gathering','A weekend to reconnect','news',future(7));seed('synthetic-service','Small acts. Lasting connections.','news',future(14));seed('synthetic-celebration','Make room for what comes next','news',future(21));
 seed('synthetic-camp','Something good is growing here','news',null,['youth']);seed('synthetic-table','Room for everyone at the table','features');seed('synthetic-voices','Young voices, lasting faith','youth');seed('synthetic-reflection','The quiet work of showing up','columns');
 const draftId=Number(run("INSERT INTO drafts(status,source,title,body,section,area,author,date,created_at,updated_at,additional_sections) VALUES('in_review','editor','Synthetic cross-category story',?,'news','camp','Synthetic Editor','2026-10-22',?,?, '[\"youth\"]')",body,now,now).lastInsertRowid);
 server=spawn(process.execPath,['dist/server/entry.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'4885',DATA_DIR:scratch,SITE_URL:base,AUTH_SECRET:'synthetic-publication-design-'+ 'x'.repeat(40),RESEND_API_KEY:'',GDRIVE_SERVICE_ACCOUNT_JSON:'',GDRIVE_FOLDER_ID:'',DISCORD_WEBHOOK_URL:''},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',(d)=>logs.push(String(d)));server.stderr.on('data',(d)=>logs.push(String(d)));
 let ready=false;for(let n=0;n<100;n++){try{await fetch(base+'/admin/login');ready=true;break;}catch{await delay(100);}}check('synthetic publication server starts',ready);
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:process.env.CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await context.addCookies([{name:'__Host-imc_session',value:token,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(), errors=[];page.on('pageerror',(e)=>errors.push(String(e)));page.setDefaultTimeout(10000);
 await page.goto(base+'/');await page.locator('[data-slide-play]').waitFor();
 const colors=await page.evaluate(()=>Object.fromEntries(['--brand','--accent','--brand-soft','--bg'].map((name)=>[name,getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase()])));
 check('website uses the uploaded email palette',colors['--brand']==='#087e8b'&&colors['--accent']==='#2dd4bf'&&colors['--brand-soft']==='#e0f5f7'&&colors['--bg']==='#f8f7f5');
 const mark=page.locator('.site-header .brand-wordmark img');await mark.evaluate((img)=>img.decode());check('local IMConnected wordmark loads',await mark.evaluate((img)=>img.naturalWidth>0));
 check('spotlight is an immersive full-width stage',await page.locator('.event-spotlight').evaluate((node)=>{const r=node.getBoundingClientRect();return r.width>=innerWidth-2&&r.height>500;}));
 await page.locator('[data-event-track]').scrollIntoViewIfNeeded();await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());
 await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 const first=await page.locator('[data-event-status]').innerText(), focusedBefore=await page.evaluate(()=>document.activeElement.tagName);
 await page.waitForFunction((before)=>document.querySelector('[data-event-status]')?.textContent!==before,first,{timeout:12000});
 check('visible slider automatically advances without stealing focus',await page.evaluate((tag)=>document.activeElement.tagName===tag,focusedBefore));
 check('automatic rotation does not repeatedly announce slides',await page.locator('[data-event-status]').getAttribute('aria-live')==='off');
 await page.getByRole('button',{name:'Pause auto-advance',exact:true}).click();await page.mouse.move(0,0);await page.locator('.skip').focus();
 const paused=await page.locator('[data-event-status]').innerText();await delay(7600);
 check('reader pause persists after hover/focus leave',await page.locator('[data-event-status]').innerText()===paused&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.getByRole('button',{name:'Resume auto-advance',exact:true}).click();await page.mouse.move(0,0);await page.locator('.skip').focus();
 await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');check('explicit resume restarts automatic rotation',await page.locator('[data-slide-play]').getAttribute('aria-pressed')==='true');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 check('hidden-tab lifecycle suspends automatic rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 const hiddenPosition=await page.locator('[data-event-status]').innerText();await delay(7600);check('hidden-tab lifecycle cancels its pending advance',await page.locator('[data-event-status]').innerText()===hiddenPosition);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));check('pagehide cancels rotation before back-forward caching',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 const cachedPosition=await page.locator('[data-event-status]').innerText();await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.waitForFunction((before)=>document.querySelector('[data-event-status]')?.textContent!==before,cachedPosition,{timeout:12000});check('pageshow restores a working automatic timer',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='true');
 await page.locator('.site-footer').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='false');check('offscreen spotlight stops its timer',true);await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 await page.locator('.spotlight-copy').first().hover();check('hover suspends rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.mouse.move(0,0);await page.locator('[data-event-track]').focus();check('keyboard focus suspends rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.getByRole('button',{name:/Show event 3:/}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 3 of 3');check('direct event choices are keyboard-focusable and update selection',await page.locator('[data-slide-to="2"]').getAttribute('aria-current')==='true');
 await page.locator('[data-event-track]').focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 2 of 3');check('arrow keys retain native focused-track navigation',true);
 const flyer=page.locator('.spotlight-flyer img').nth(1);await flyer.evaluate((img)=>img.decode());check('immersive flyer retains full portrait aspect',await flyer.evaluate((img)=>{const r=img.getBoundingClientRect();return Math.abs(r.height/r.width-1.5)<.02&&getComputedStyle(img).objectFit==='contain';}));
 await page.getByRole('button',{name:/Show event 1:/}).click();await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 1 of 3');await page.locator('.home-news-heading').click();
 if(process.env.AXE_JS){await page.addScriptTag({path:process.env.AXE_JS});const result=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));if(result.violations.length)console.log(JSON.stringify(result.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>({html:n.html,summary:n.failureSummary}))}))));check('rebranded homepage and slider pass axe',result.violations.length===0);}
 await page.screenshot({path:path.join(shots,'publication-home-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});await page.goto(base+'/');check('new brand and event stage fit a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-home-mobile.png'),fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});await page.goto(base+'/');await page.locator('[data-slide-play]').waitFor();await delay(7600);
 check('reduced-motion users get no automatic rotation',await page.locator('[data-event-status]').innerText()==='Event 1 of 3'&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false'&&await page.locator('[data-slide-play]').isDisabled());
 await page.getByRole('button',{name:'Next event',exact:true}).click();check('reduced-motion manual navigation jumps directly without smooth scrolling',await page.locator('[data-event-track]').evaluate((track)=>{const slides=track.querySelectorAll('[data-event-slide]');return Math.abs(track.scrollLeft-(slides[1].offsetLeft-slides[0].offsetLeft))<2;})&&await page.locator('[data-event-status]').innerText()==='Event 2 of 3');
 check('system dark preference retains the requested newsletter palette',await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase()==='#087e8b'));
 await page.setViewportSize({width:1440,height:1100});await page.goto(base+'/stories/synthetic-camp/');check('article shows both category links and reading guidance',await page.locator('.article-heading a[href="/news/"]').count()===1&&await page.locator('.article-heading a[href="/youth/"]').count()===1&&await page.locator('.article-reading').innerText().then((s)=>s.includes('min read')));await page.screenshot({path:path.join(shots,'publication-article-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});check('article reading column fits a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-article-mobile.png'),fullPage:true});
 await page.goto(base+`/admin/drafts/${draftId}`);await page.locator('[data-studio-tab=settings]').click();check('editor shares the wordmark and exposes multiple-category controls',await page.locator('.admin-brand .brand-wordmark img').count()===1&&await page.locator('input[name=additionalSections][value=youth]').isChecked());check('branded editor fits a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-editor-mobile.png'),fullPage:true});
 const plain=await browser.newContext({javaScriptEnabled:false,viewport:{width:1440,height:1100}});await plain.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());const nojs=await plain.newPage();await nojs.goto(base+'/');check('without JavaScript all event cards remain readable with native links',await nojs.locator('[data-event-slide]').count()===3&&await nojs.locator('[data-event-track] a').count()>=6);await plain.close();
 const touch=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:900}});await touch.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());const touchPage=await touch.newPage();await touchPage.goto(base+'/');await touchPage.locator('.spotlight-number').first().tap();check('real touch interaction persistently pauses rotation',await touchPage.locator('[data-slide-play]').getAttribute('aria-pressed')==='false'&&await touchPage.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');await touch.close();
 for(const slug of ['synthetic-service','synthetic-celebration']){const form=new FormData();form.set('slug',slug);const response=await fetch(base+'/api/admin/stories/unpublish',{method:'POST',headers:{Origin:base,Cookie:`__Host-imc_session=${token}`},body:form,redirect:'manual'});check('synthetic fixture can retire extra events',response.status===303&&response.headers.get('location').includes('n=unpublished'));}
 await page.emulateMedia({reducedMotion:'no-preference',colorScheme:'light'});await page.goto(base+'/');check('one event has no autoplay or unnecessary controls',await page.locator('[data-event-slide]').count()===1&&!await page.locator('[data-slide-play]').isVisible()&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')!=='true');
 const last=new FormData();last.set('slug','synthetic-gathering');await fetch(base+'/api/admin/stories/unpublish',{method:'POST',headers:{Origin:base,Cookie:`__Host-imc_session=${token}`},body:last,redirect:'manual'});await page.goto(base+'/');check('an empty calendar hides the entire event stage',await page.locator('[data-event-spotlight]').count()===0);
 check('publication workflows have no uncaught browser errors',errors.length===0);
 console.log(`\n${checks} publication redesign checks passed.`);
} finally {await browser?.close();if(server){server.kill();await Promise.race([new Promise((r)=>server.once('exit',r)),delay(3000)]);}db?.close();fs.rmSync(scratch,{recursive:true,force:true});}
