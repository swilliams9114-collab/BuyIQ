const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/BuyIQ.user.js', 'utf8');
const config = {enabled:true,key:'abcdefghijklmnop',discount:3,reserve:1000000,maxQty:10000,maxSpend:0,position:'right',y:42,excludeEquipment:true};
const catalog = {items:[{id:180,name:'Bottle of Beer',type:'Alcohol',value:{market_price:1000}},
    {id:181,name:'Empty Blood Bag',type:'Medical',value:{market_price:16000}}]};
const html = kind => `<html><head></head><body style="margin:12px"><div id="user-money" data-money="5000000">$5,000,000</div>
<div ${kind==='bazaar'?'data-testid="bazaar-items"':'id="item-market-root"'}>
<ul style="padding:0"><li class="${kind==='bazaar'?'item___test':'rowWrapper___test'}" data-item="180" style="padding:12px;margin:8px 0;border:1px solid #aaa">
<span>Bottle of Beer</span><span class="price___test">$950</span><span class="${kind==='bazaar'?'amount___test':'available___test'}">500</span>
${kind==='bazaar'?'<input class="buyAmountInput_test" value="1" max="500">':''}
<button class="${kind==='bazaar'?'buy___test':'buyButton_test'}" id="native-buy">Buy</button><button id="native-yes" hidden>Accept</button></li>
<li class="${kind==='bazaar'?'item___test':'rowWrapper___test'}" data-item="181" style="padding:12px;margin:8px 0;border:1px solid #aaa"><span>Empty Blood Bag</span><span class="price___test">$15,200</span><span class="${kind==='bazaar'?'amount___test':'available___test'}">100</span><input class="buyAmountInput_test" value="1"><button>Buy</button></li></ul></div>
<script>window.calls={open:0,buy:0,confirm:0,api:0};
document.querySelector('#native-buy').onclick=()=>{const row=document.querySelector('#native-buy').parentNode;
if(!row.querySelector('input')){calls.open++;const x=document.createElement('input');x.className='buyAmountInput_test';x.value='1';row.appendChild(x);return;}
calls.buy++;document.querySelector('#native-yes').hidden=false;document.querySelector('#native-buy').hidden=true;};
document.querySelector('#native-yes').onclick=()=>{calls.confirm++;document.querySelector('#native-yes').hidden=true;
document.querySelector('#user-money').dataset.money='4525000';};</script></body></html>`;
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 const page=await context.newPage(); let kind='bazaar', errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://www.torn.com/**',r=>r.fulfill({contentType:'text/html',body:html(kind)}));
 async function setup(k='bazaar', cfg=config){
  kind=k;await page.goto(k==='bazaar'?'https://www.torn.com/bazaar.php?userId=123':'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=180');
  await page.evaluate(({cfg,catalog})=>{localStorage.setItem('buyiq_settings_v1',JSON.stringify(cfg));window.PDA_httpGet=async()=>{calls.api++;return {status:200,responseText:JSON.stringify(catalog)}};},{cfg,catalog});
  await page.addScriptTag({content:source});await page.waitForSelector('#buyiq:not([hidden])');
 }
 async function tap(selector='.bqi-action'){await page.locator(selector).click();await page.waitForTimeout(650);}
 async function counts(){return page.evaluate(()=>calls)}
 await setup();await tap();assert.equal((await counts()).api,1);assert.equal((await counts()).buy,0);
 await tap();assert.equal(await page.locator('.buyAmountInput_test').first().inputValue(),'500');assert.equal((await counts()).buy,0);
 await tap();assert.equal((await counts()).buy,1);assert.equal((await counts()).confirm,0);
 await tap();assert.equal((await counts()).confirm,1);await page.waitForTimeout(800);assert.equal((await counts()).buy,1);
 await tap();await tap();assert.match(await page.locator('.bqi-info').innerText(),/Empty Blood Bag/);
 console.log('PASS Bazaar: scan, fill, review, confirm each require a tap; next row waits; submitted row excluded.');
 await setup('market');await tap();await tap();assert.equal((await counts()).open,1);assert.equal((await counts()).buy,0);
 await tap();assert.equal((await counts()).buy,0);await tap();assert.equal((await counts()).buy,1);await tap();assert.equal((await counts()).confirm,1);
 console.log('PASS Item Market: opening, filling, buying and confirmation remain separate.');
 await setup();await tap();await tap();await page.locator('.price___test').first().evaluate(el=>el.textContent='$999');await tap();assert.equal((await counts()).buy,0);
 console.log('PASS Changed price blocks purchase.');
 await setup();await tap();await tap();await page.locator('.buyAmountInput_test').first().fill('501');await tap();assert.equal((await counts()).buy,0);
 console.log('PASS Changed quantity blocks purchase.');
 await setup();await tap();await tap();await page.locator('.bqi-action').dblclick();assert.equal((await counts()).buy,1);assert.equal((await counts()).confirm,0);
 await page.evaluate(()=>document.querySelector('.bqi-action').click());assert.equal((await counts()).confirm,0);
 console.log('PASS Double-tap and synthetic clicks cannot chain purchases.');
 await setup('bazaar',{...config,reserve:4999999});await tap();assert.equal((await counts()).buy,0);assert.match(await page.locator('.bqi-message').innerText(),/reserve/);
 console.log('PASS Cash reserve prevents unaffordable preparation.');
 await setup();await tap();await tap();await page.evaluate(()=>document.querySelector('#user-money').dataset.money='1000000');await tap();assert.equal((await counts()).buy,0);
 console.log('PASS Cash changed before purchase blocks submission.');
 await setup();await tap();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await page.locator('#buyiq').isVisible(),false);
 await page.goto('https://www.torn.com/index.php');await page.addScriptTag({content:source});assert.equal(await page.locator('#buyiq').isVisible(),false);
 console.log('PASS Button hidden off shopping pages and on blur.');
 await setup();await page.evaluate(()=>window.PDA_httpGet=async()=>({status:200,responseText:'{"error":{"code":2}}'}));await tap();assert.equal((await counts()).buy,0);assert.match(await page.locator('.bqi-message').innerText(),/API error/);
 console.log('PASS Invalid API response blocks preparation.');
 await page.goto('https://www.torn.com/profiles.php?XID=3979390');
 await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div class="profile-wrapper">Profile</div>')});
 await page.addScriptTag({content:source});await page.locator('#buyiq-profile > summary').click();
 await page.locator('#buyiq-profile [name="discount"]').fill('7');await page.locator('#buyiq-profile [data-save]').click();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('buyiq_settings_v1')).discount),7);
 assert.equal(await page.locator('#buyiq').isVisible(),false);
 console.log('PASS Profile settings save correctly; shopping button stays hidden.');
 await setup();await tap();for (const width of [320,390,1024]){
   await page.setViewportSize({width,height:844});await page.screenshot({path:__dirname+`/preview-${width}.png`});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const bounds=await page.locator('.bqi-box').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
 }
 assert.deepEqual(errors,[]);console.log('PASS Mobile 320px/390px and desktop layout; no runtime errors.');
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
