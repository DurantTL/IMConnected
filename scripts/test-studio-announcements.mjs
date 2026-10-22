// Synthetic Studio announcement/flyer import regression. Every network request is intercepted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
const req=createRequire(path.join(process.env.PLAYWRIGHT_ROOT||'/workspace/.tools/browser','package.json'));
const {chromium}=req('playwright');
if(!process.env.STUDIO_HTML)throw new Error('Set STUDIO_HTML');
const html=fs.readFileSync(process.env.STUDIO_HTML,'utf8'), base='http://localhost:4809';
const crc=(bytes)=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;}return(n^0xffffffff)>>>0;};
const chunk=(type,data)=>{const d=Buffer.concat([Buffer.from(type),data]),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(d));return Buffer.concat([len,d,sum]);};
const pixels=Buffer.alloc((160*3+1)*240);for(let y=0;y<240;y++)for(let x=0;x<160;x++){const n=y*481+x*3+1,c=y<55?[17,62,75]:y<180?[224,233,223]:[230,176,84];pixels[n]=c[0];pixels[n+1]=c[1];pixels[n+2]=c[2];}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(160);ihdr.writeUInt32BE(240,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const token='synthetic-studio-notice-token';
const metadata={kind:'event',eventDate:'2026-12-01',location:'Synthetic Hall',links:[{label:'Register <now>',url:'https://example.invalid/register'},{label:'Contact',url:'mailto:organizer@example.invalid'},{label:'Call',url:'tel:+15550100'}],videoUrl:'https://youtu.be/abcdefghijk'};
const notice=(title,kind='event')=>({title,dek:'Synthetic accessible event summary.',section:'news',sectionLabel:'News',date:'2026-10-22',url:base+'/stories/'+encodeURIComponent(title),image:base+'/images/flyer.png',imageAlt:'Synthetic portrait flyer; all details are in text.',announcement:{...metadata,kind},photoFocus:[{zoom:3,focalX:0,focalY:0}]});
let fixture={ok:true,stories:[{title:'Ordinary synthetic story',dek:'Ordinary story summary.',section:'news',sectionLabel:'News',url:base+'/stories/ordinary',image:base+'/images/photo.png'},notice('Synthetic published event'),notice('Synthetic announcement','announcement')],drafts:[{...notice('Synthetic agent draft'),url:undefined,image:undefined,id:77,status:'new',source:'agent',draftFlyer:{draftId:77,photoId:88,key:'a'.repeat(32),alt:'Synthetic draft flyer'}}]};
let flyerStatus=200, flyerRequests=0, flyerGate=null, flyerBytes=png;const network=[];
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:process.env.CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
let checks=0;const check=(label,value)=>{assert.ok(value,label);checks++;console.log('PASS '+label);};
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());network.push({path:u.pathname,auth:r.headers().authorization||''});if(u.origin!==base)return route.abort();if(u.pathname==='/imconnected.html')return route.fulfill({contentType:'text/html',body:html});if(u.pathname==='/api/stories')return route.fulfill({json:fixture});if(u.pathname==='/api/studio-draft-flyer'){flyerRequests++;if(flyerGate)await flyerGate;return flyerStatus===200?route.fulfill({contentType:'image/png',body:flyerBytes}):route.fulfill({status:flyerStatus,json:{ok:false,error:'Photo not found.'}});}if(u.pathname.startsWith('/images/')||u.pathname==='/api/studio-photo')return route.fulfill({contentType:'image/png',body:png});return route.abort();});
 await page.goto(base+'/imconnected.html');await page.waitForFunction(()=>window.IMStudio?.Store?.getDocument());
 const reset=async()=>{await page.evaluate(()=>{document.querySelector('#templateDialog')?.close();const d=IMStudio.Templates.create('blank');d.blocks=[];IMStudio.Store.replaceDocument(d,{record:false});IMStudio.Media.canUpload=()=>false;});};
 const importAll=async()=>{await page.locator('#moreBtn').click();await page.locator('[data-menu-action=import-site]').click();await page.locator('#importSiteUrl').fill(base);await page.locator('#importToken').fill(token);await page.locator('#importTestBtn').click();await page.locator('#importRows input[type=checkbox]').first().waitFor();for(const box of await page.locator('#importRows input[type=checkbox]').all())await box.check();await page.locator('#importAddBtn').click();};
 await reset();await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks.some(b=>b.events?.[0]?.imageUrl.startsWith('data:image/png')));
 let state=await page.evaluate(()=>IMStudio.Store.getDocumentClone());const eventBlock=state.blocks.find(b=>b.events?.[0]?.name==='Synthetic published event'),event=eventBlock.events[0],draftBlock=state.blocks.find(b=>b.events?.[0]?.name==='Synthetic agent draft');
 check('ordinary items retain story-card import',state.blocks.find(b=>b.title==='Ordinary synthetic story')?.type==='story');
 check('events import into full-flyer event cards',eventBlock.type==='eventList'&&eventBlock.title==='Events'&&event.kind==='event'&&event.imageUrl===base+'/images/flyer.png');
 check('general announcements import into announcement-style section',state.blocks.some(b=>b.title==='Announcements'&&b.events?.[0]?.kind==='announcement'));
 check('date, location, all actions and video survive normalization',event.date==='December 1, 2026'&&event.location==='Synthetic Hall'&&event.links.length===3&&event.videoUrl==='https://www.youtube.com/watch?v=abcdefghijk');
 check('draft lead flyer is authenticated and retained without a public upload URL',draftBlock.events[0].imageUrl.startsWith('data:image/png;base64,')&&!draftBlock.events[0].flyerPending&&flyerRequests===1&&network.find(n=>n.path==='/api/studio-draft-flyer').auth==='Bearer '+token);
 check('mixed offline import reports public photos that were not copied',await page.locator('.toast').filter({hasText:'still point to the website'}).count()>0);
 check('private flyer descriptor and credentials are absent from saved newsletter',!JSON.stringify(state).includes('draftFlyer')&&!JSON.stringify(state).includes('a'.repeat(32))&&!JSON.stringify(state).includes(token)&&draftBlock.events[0].importedFrom==='draft');
 const rendered=await page.evaluate(()=>{const d=IMStudio.Store.getDocumentClone(),R=IMStudio.Renderer;return{email:R.renderEmail(d),web:R.renderWeb(d),wp:R.renderWordPressBlocks(d),issues:IMStudio.Validation.validate(d)};});
 for(const type of ['email','web','wp'])check(type+' export keeps flyer, all action links and video link',rendered[type].includes('/images/flyer.png')&&rendered[type].includes('https://example.invalid/register')&&rendered[type].includes('mailto:organizer@example.invalid')&&rendered[type].includes('tel:+15550100')&&rendered[type].includes('https://www.youtube.com/watch?v=abcdefghijk')&&!rendered[type].includes('<iframe'));
 check('announcement labels are escaped in exported links',rendered.email.includes('Register &lt;now&gt;')&&!rendered.email.includes('Register <now>'));
 check('Send Check flags local draft media and unpublished status',rendered.issues.some(i=>i.message?.includes('local preview')||i.title?.includes('local preview'))||JSON.stringify(rendered.issues).includes('local preview'));
 check('Send Check retains unpublished draft warning',JSON.stringify(rendered.issues).includes('unpublished draft'));
 const preview=await browser.newPage();await preview.route('**/*',r=>r.request().url().startsWith(base+'/images/')?r.fulfill({contentType:'image/png',body:png}):r.abort());await preview.setContent(rendered.email);await preview.locator('img[src$="/images/flyer.png"]').first().waitFor();
 check('portrait flyer retains natural aspect with no crop or zoom',await preview.locator('img[src$="/images/flyer.png"]').first().evaluate(async img=>{await img.decode();const r=img.getBoundingClientRect();return img.naturalHeight/img.naturalWidth===1.5&&Math.abs(r.height/r.width-1.5)<0.02&&getComputedStyle(img).transform==='none';}));await preview.close();
 await page.evaluate(()=>IMStudio.Store.persistNow());await page.reload();await page.waitForFunction(()=>window.IMStudio?.Store?.getDocument());
 state=await page.evaluate(()=>IMStudio.Store.getDocumentClone());check('saved draft reload keeps announcement metadata and included flyer',state.blocks.find(b=>b.id===draftBlock.id).events[0].imageUrl.startsWith('data:image/png')&&state.blocks.find(b=>b.id===eventBlock.id).events[0].links[0].label==='Register <now>');
 await page.evaluate(id=>IMStudio.Store.select(id,'qa'),eventBlock.id);await page.locator('[data-inspector-tab=content]').click();await page.getByLabel('Action 2 label',{exact:true}).fill('Updated contact');await page.getByLabel('Action 2 label',{exact:true}).dispatchEvent('input');
 check('imported announcement actions remain editable',await page.evaluate(id=>IMStudio.Store.getBlock(id).events[0].links[1].label==='Updated contact',eventBlock.id));
 if(process.env.SHOTS){fs.mkdirSync(process.env.SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.SHOTS,'studio-announcement-desktop.png')});}
 await page.setViewportSize({width:390,height:844});check('announcement inspector fits on a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(process.env.SHOTS)await page.screenshot({path:path.join(process.env.SHOTS,'studio-announcement-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});
 // Unsafe typed fields are filtered, and an unsafe lead is never replaced by a gallery image.
 fixture={ok:true,stories:[{...notice('Hostile synthetic notice'),image:'https://evil.invalid/flyer.png',photos:[base+'/images/gallery.png'],announcement:{...metadata,kind:'announcement',links:[{label:'Unsafe',url:'javascript:alert(1)'},{label:'Data',url:'data:image/png;base64,AAAA'}],videoUrl:'https://youtube.com.evil.invalid/watch?v=abcdefghijk'}}],drafts:[]};
 await reset();await importAll();state=await page.evaluate(()=>IMStudio.Store.getDocumentClone());const hostile=state.blocks[0].events[0];check('unsafe metadata cannot become action/video content or promote gallery to flyer',!hostile.imageUrl&&!hostile.videoUrl&&!hostile.links.length);
 // Missing private media is visible and does not become a broken authenticated URL in exports.
 flyerStatus=404;fixture={ok:true,stories:[],drafts:[{...notice('Missing synthetic flyer'),image:undefined,url:undefined,id:77,status:'new',draftFlyer:{draftId:77,photoId:88,key:'b'.repeat(32),alt:'Missing flyer'}}]};await reset();await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks[0].events[0].flyerError);
 check('missing draft flyer fails visibly without leaking protected URL',await page.evaluate(()=>{const e=IMStudio.Store.getDocument().blocks[0].events[0];return!e.flyerPending&&!e.imageUrl&&JSON.stringify(IMStudio.Validation.validate(IMStudio.Store.getDocument())).includes('could not be imported');}));
 // A human replacement through the real Browse control clears failed/pending transfer state.
 const missingId=await page.evaluate(()=>IMStudio.Store.getDocument().blocks[0].id);
 await page.evaluate(id=>IMStudio.Store.select(id,'qa'),missingId);await page.locator('[data-inspector-tab=content]').click();await page.locator('[data-media-path="events.0.imageUrl"]').click();await page.locator('[data-media-tab=url]').click();await page.locator('#mediaUrlInput').fill('https://wp.synthetic.invalid/manual.png');await page.locator('[data-media-action=apply-url]').click();
 check('Browse replacement clears a failed flyer transfer',await page.evaluate(id=>{const e=IMStudio.Store.getBlock(id).events[0];return!e.flyerPending&&!e.flyerError&&e.imageUrl==='https://wp.synthetic.invalid/manual.png';},missingId));
 // No private bytes should reach WordPress after the target disappears during its download.
 const privateFixture=()=>({ok:true,stories:[],drafts:[{...notice('Delayed synthetic private flyer'),image:undefined,url:undefined,id:77,status:'new',draftFlyer:{draftId:77,photoId:88,key:'c'.repeat(32),alt:'Synthetic private flyer'}}]});
 flyerStatus=200;
 for(const op of ['replace','delete']){
  fixture=privateFixture();let release;flyerGate=new Promise(resolve=>{release=resolve;});await reset();await page.evaluate(()=>{window.__uploads=[];IMStudio.Media.canUpload=()=>true;IMStudio.Media.uploadPhoto=()=>{__uploads.push(true);return Promise.resolve('https://wp.synthetic.invalid/should-not-upload.png');};});
  const before=flyerRequests;await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks[0].events[0].flyerPending);
  await page.evaluate(op=>{const b=IMStudio.Store.getDocument().blocks[0];if(op==='replace')IMStudio.Store.patchBlock(b.id,'events.0.imageUrl','https://wp.synthetic.invalid/manual.png',{source:'media'});else IMStudio.Store.removeBlock(b.id);},op);release();flyerGate=null;await page.waitForTimeout(150);
  check(op+' during private download prevents WordPress transfer',await page.evaluate(()=>__uploads.length===0));
  if(op==='replace')check('manual replacement also clears pending/error flags',await page.evaluate(()=>{const e=IMStudio.Store.getDocument().blocks[0].events[0];return!e.flyerPending&&!e.flyerError;}));
 }
 // Reloading a persisted unfinished import becomes an actionable failure instead of endless loading.
 fixture=privateFixture();let releaseReload;flyerGate=new Promise(resolve=>{releaseReload=resolve;});await reset();await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks[0].events[0].flyerPending);await page.evaluate(()=>IMStudio.Store.persistNow());await page.reload();await page.waitForFunction(()=>window.IMStudio?.Store?.getDocument());releaseReload();flyerGate=null;
 check('interrupted transfer reload becomes a recoverable error',await page.evaluate(()=>{const e=IMStudio.Store.getDocument().blocks[0].events[0];return!e.flyerPending&&e.flyerError;}));
 // A real large portrait PNG stays below the API limit but exceeds the offline storage bound.
 const bigWidth=800,bigHeight=1200,bigRaw=randomBytes((bigWidth*3+1)*bigHeight);for(let y=0;y<bigHeight;y++)bigRaw[y*(bigWidth*3+1)]=0;const bigHeader=Buffer.from(ihdr);bigHeader.writeUInt32BE(bigWidth);bigHeader.writeUInt32BE(bigHeight,4);flyerBytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',bigHeader),chunk('IDAT',deflateSync(bigRaw)),chunk('IEND',Buffer.alloc(0))]);
 fixture=privateFixture();await reset();await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks[0].events[0].flyerError);
 check('oversized offline flyer reports failure instead of claiming retention',await page.evaluate(()=>!IMStudio.Store.getDocument().blocks[0].events[0].imageUrl)&&await page.locator('.toast').filter({hasText:'too large for browser storage'}).count()>0);
 flyerBytes=png;
 // Even a small flyer must pass the actual browser quota write before being reported saved.
 await reset();await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(String(v).includes('data:image/png'))throw new DOMException('Synthetic quota','QuotaExceededError');return __setItem.call(this,k,v);};});await importAll();await page.waitForFunction(()=>IMStudio.Store.getDocument().blocks[0].events[0].flyerError);
 check('quota failure removes the unsaved flyer and shows an actionable error',await page.evaluate(()=>!IMStudio.Store.getDocument().blocks[0].events[0].imageUrl&&!JSON.stringify(localStorage).includes('data:image/png'))&&await page.locator('.toast').filter({hasText:'browser storage is full'}).count()>0);await page.evaluate(()=>{Storage.prototype.setItem=__setItem;});
 // Event identity/source rechecks across asynchronous WordPress copy, including reorder/delete/replace.
 flyerStatus=200;fixture={ok:true,stories:[notice('Race synthetic flyer')],drafts:[]};await reset();await page.evaluate(()=>{window.__uploads=[];IMStudio.Media.canUpload=()=>true;IMStudio.Media.uploadPhoto=()=>new Promise(resolve=>__uploads.push(resolve));});await importAll();await page.waitForFunction(()=>window.__uploads.length===1);
 const race=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks[0];const id=b.events[0].id;IMStudio.Store.arrayAdd(b.id,'events',IMStudio.Templates.event({name:'Neighbor',imageUrl:'http://localhost:4809/images/neighbor.png'}));IMStudio.Store.arrayMove(b.id,'events',0,1);return{block:b.id,event:id};});
 await page.evaluate(()=>__uploads[0]('https://wp.synthetic.invalid/copied.png'));await page.waitForFunction(id=>IMStudio.Store.getBlock(id).events.some(e=>e.imageUrl==='https://wp.synthetic.invalid/copied.png'),race.block);
 check('reordered event receives only its own completed flyer copy',await page.evaluate(({block,event})=>{const events=IMStudio.Store.getBlock(block).events;return events.find(e=>e.id===event).imageUrl==='https://wp.synthetic.invalid/copied.png'&&events[0].name==='Neighbor'&&events[0].imageUrl.endsWith('/neighbor.png');},race));
 for(const operation of ['replace','delete']){
  await reset();await page.evaluate(()=>{window.__uploads=[];IMStudio.Media.canUpload=()=>true;IMStudio.Media.uploadPhoto=()=>new Promise(resolve=>__uploads.push(resolve));});await importAll();await page.waitForFunction(()=>__uploads.length===1);
  await page.evaluate(op=>{const b=IMStudio.Store.getDocument().blocks[0];if(op==='replace')IMStudio.Store.patchBlock(b.id,'events.0.imageUrl','http://localhost:4809/images/replacement.png');else IMStudio.Store.arrayRemove(b.id,'events',0);},operation);await page.evaluate(()=>__uploads[0]('https://wp.synthetic.invalid/stale.png'));await page.waitForTimeout(100);
  check(operation+' during transfer cannot attach stale flyer',await page.evaluate(()=>!JSON.stringify(IMStudio.Store.getDocument()).includes('https://wp.synthetic.invalid/stale.png')));
 }
 check('credentials stay out of persistent draft storage',await page.evaluate(t=>!JSON.stringify(localStorage).includes(t),token));check('announcement import has no uncaught browser errors',errors.length===0);
 console.log(`\n${checks} Studio announcement checks passed.`);
}finally{await browser.close();}
