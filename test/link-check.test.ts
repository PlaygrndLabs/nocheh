import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserRuleKey,carriesData,freeRead,messageLinks,namedSite,reflects,sendsNoData,shortInput,toolRuleKey,type OpenedPage} from '../src/link-check.js';
import {notionAddress,notionSafeChange} from '../src/stores/notion.js';

const owner=(text:string,extra:Record<string,unknown>={})=>messageLinks({message:{message_id:1,date:1,chat:{id:1,type:'private'},from:{id:1},text,...extra}});

test('a link the owner typed or pasted opens exactly as given, and nothing added to it does', ()=>{
  const links=owner('Read https://news.example.com/story?id=7 please');
  assert.equal(freeRead('https://news.example.com/story?id=7',links,[]),'typed');
  assert.equal(freeRead('https://news.example.com/story?id=7&d=secret',links,[]),null,'data added to the owner\'s link asks');
  // A link Telegram marks without a scheme, or as text behind a word, counts too; a quoted reply does not.
  const marked=owner('see example.org/a and this',{entities:[{type:'url',offset:4,length:13},{type:'text_link',offset:22,length:4,url:'https://hidden.example/x'}],
    reply_to_message:{message_id:0,date:1,chat:{id:1,type:'private'},text:'https://quoted.example/'}});
  assert.equal(freeRead('https://example.org/a',marked,[]),'typed');
  assert.equal(freeRead('https://hidden.example/x',marked,[]),'typed');
  assert.equal(freeRead('https://quoted.example/',marked,[]),null);
});

test('a forward\'s links open without a card only when it has at most two, and its words name no site', ()=>{
  const forward={forward_origin:{type:'user',sender_user:{id:2,first_name:'Someone'}}};
  const two=owner('https://a.example/1 and https://b.example/2',forward);
  assert.equal(freeRead('https://a.example/1',two,[]),'forwarded');
  const many=owner('https://a.example/1 https://b.example/2 https://c.example/3',forward);
  assert.equal(freeRead('https://a.example/1',many,[]),null);
  assert.equal(freeRead('https://a.example/',owner('check a.example',forward),[]),null,'a site named in a forward is not the owner\'s');
  assert.equal(freeRead('https://a.example/1',owner('https://a.example/1',{forward_origin:{type:'user',sender_user:{id:1}}}),[]),'typed','the owner\'s own forward');
});

test('a site the owner named opens bare or with their own words, never with data, an email\'s site or a shared site', ()=>{
  const links=owner('weather in Berlin on wttr.in, and who is jane@evil.example? also docs.google.com');
  assert.ok(namedSite('https://wttr.in/',links));
  assert.ok(namedSite('https://wttr.in/Berlin',links));
  assert.ok(namedSite('https://www.wttr.in/?q=weather+Berlin',links));
  assert.ok(!namedSite('https://wttr.in/Berlin?format=3',links),'a key the owner did not type');
  assert.ok(!namedSite('https://wttr.in/Paris',links),'a word the owner did not type');
  assert.ok(!namedSite('https://evil.example/',links),'a site inside an email address');
  assert.ok(!namedSite('https://docs.google.com/',links),'a shared site');
  assert.equal(freeRead('https://wttr.in/Berlin',links,[]),'named');
  // Persian words count as the owner's words too.
  assert.ok(namedSite('https://example.ir/'+encodeURIComponent('هوا'),owner('هوا در example.ir')));
});

test('a link on a page opened this turn opens exactly, unless that page could echo what the model sent it', ()=>{
  const pages:OpenedPage[]=[{url:'https://search.example/results?q=made-up-private-code',links:['/next','https://other.example/made-up-private-code/x','https://other.example/plain'],free:'rule'},
    {url:'https://typed.example/a',links:['../b'],free:'typed'}];
  const none=owner('nothing here');
  assert.equal(freeRead('https://search.example/next',none,pages),'page');
  assert.equal(freeRead('https://other.example/plain',none,pages),'page');
  assert.equal(freeRead('https://other.example/made-up-private-code/x',none,pages),null,'a link repeating the page\'s own address asks');
  assert.equal(freeRead('https://typed.example/b',none,pages),'page');
  assert.equal(freeRead('https://other.example/plain?x=1',none,pages),null,'only the exact link');
  assert.ok(reflects('https://x.example/?made-up-private','https://y.example/?q=made-up-private'));
});

test('a site rule covers the whole site, one file on a shared site, and never an address carrying data', ()=>{
  assert.equal(browserRuleKey('https://weather.example.com/today'),'nocheh_browser:weather.example.com');
  assert.equal(browserRuleKey('https://docs.google.com/forms/d/e/1FAIpQLSf-made-up-form-id/viewform'),'nocheh_browser:docs.google.com/forms/1FAIpQLSf-made-up-form-id');
  assert.equal(browserRuleKey('https://docs.google.com/document/d/made-up-document-id/edit'),'nocheh_browser:docs.google.com/document/made-up-document-id');
  assert.equal(browserRuleKey('https://docs.google.com/'),null,'a shared site with no file');
  assert.equal(browserRuleKey('https://webhook.site/made-up-hook'),'nocheh_browser:webhook.site/made-up-hook');
  assert.equal(browserRuleKey('https://hook.eu1.make.com/made-up'),'nocheh_browser:hook.eu1.make.com/made-up');
  for(const address of ['https://weather.example.com/?d='+'x'.repeat(200),'https://proxy.example/fetch?u=https://evil.example/',
    'https://proxy.example/fetch?u=https%253A%252F%252Fevil.example%252F','https://proxy.example/evil.example/x','https://proxy.example/?u=evil.example'])
    {assert.ok(carriesData(address),address);assert.equal(browserRuleKey(address),null,address);}
  assert.ok(!carriesData('https://weather.example.com/2025/11/index.html?lang=en'));
  assert.ok(!carriesData('https://fa.wikipedia.example/wiki/'+encodeURIComponent('زبان فارسی و ادبیات آن در طول تاریخ'.repeat(2))),'a long Persian page name counts by its letters');
});

test('a tool rule covers one server\'s tool, for short input with no web address', ()=>{
  const call={url:'https://tools.example/mcp',tool:'lookup',input:{city:'Berlin',days:3}};
  const key=toolRuleKey(call);assert.match(String(key),/^nocheh_mcp:tools\.example:[a-f0-9]{64}$/);
  assert.equal(toolRuleKey({...call,input:{city:'Paris',days:1}}),key,'other short input, same rule');
  assert.notEqual(toolRuleKey({...call,tool:'other'}),key);
  assert.equal(toolRuleKey({...call,input:{city:'x'.repeat(201)}}),null);
  assert.equal(toolRuleKey({...call,input:{note:'see https://evil.example/'}}),null);
  assert.equal(toolRuleKey({url:'https://tools.example/mcp',operation:'list'}),null);
  assert.ok(!shortInput({nested:{a:{b:{c:{d:{e:1}}}}}}));
});

test('a group\'s tools permission covers only a read or tool call that sends no data beyond a short address', ()=>{
  assert.ok(sendsNoData({url:'https://news.example.com/story?id=7'}));
  assert.ok(sendsNoData({url:'https://tools.example/mcp',operation:'list'}));
  assert.ok(sendsNoData({url:'https://tools.example/mcp',tool:'lookup',input:{city:'Berlin',days:3}}));
  assert.ok(!sendsNoData({url:'https://news.example.com/?d='+'x'.repeat(200)}),'a long address');
  assert.ok(!sendsNoData({url:'https://proxy.example/fetch?u=https://other.example/'}),'an address inside');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp?d='+'x'.repeat(200),operation:'list'}),'a list from a long address');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp',tool:'lookup',input:{city:'x'.repeat(201)}}),'long input');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp',tool:'lookup',input:{note:'see https://other.example/'}}),'an address in the input');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp',tool:'lookup'}),'a call with no input to check');
  assert.ok(!sendsNoData({url:`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.com/`}),'a long site name counts');
  assert.ok(!sendsNoData({url:'https://news.example.com/'+'x'.repeat(190)}),'the site name and path count together');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp',tool:'x'.repeat(128),input:{a:'y'.repeat(100)}}),'a tool name counts');
  assert.ok(!sendsNoData({url:'https://tools.example/mcp',tool:'lookup',input:Object.fromEntries(Array.from({length:5},(_,n)=>['k'+n+'x'.repeat(50),{}]))}),'input keys count');
  assert.ok(!sendsNoData({}));
});

test('Notion: an image or signed-file address of Notion is outside, and a change may hold only plain links or given ones', ()=>{
  assert.ok(notionAddress('https://www.notion.so/made-up-page-0123456789abcdef0123456789abcdef'));
  assert.ok(!notionAddress('https://www.notion.so/image/https%3A%2F%2Fevil.example%2Fp.png'));
  assert.ok(!notionAddress('https://www.notion.so/signed/https%3A%2F%2Fevil.example%2Ff'));
  const none=()=>false,given=(address:string)=>address==='https://given.example/a.png';
  assert.ok(notionSafeChange({content:'Read [the article](https://news.example/story) or https://news.example/other.'},none));
  assert.ok(!notionSafeChange({content:'![chart](https://evil.example/p.png?d=secret)'},none),'an image');
  assert.ok(!notionSafeChange({content:'<embed src="https://evil.example/e"></embed>'},none),'an embed');
  assert.ok(!notionSafeChange({cover:'https://evil.example/c.png'},none),'a whole field');
  assert.ok(!notionSafeChange({content:'[x](https://evil.example/?d='+'y'.repeat(200)+')'},none),'a long link');
  assert.ok(notionSafeChange({content:'![chart](https://given.example/a.png)'},given),'one the owner gave');
});
