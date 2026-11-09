import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../src/archive.js';
import {cut,linked,operationCard,operationText} from '../src/action-text.js';
import {approvalAction,approvalLines} from '../src/prompts.js';

const words=approvalLines('');
/** What a card shows for an operation; it fails a test when the operation gets no card. */
const shown=(kind:string,args:Record<string,any>)=>{const text=operationText(kind,args,words);assert.ok(text,'the operation fits a card');return text;};
/** A card as Telegram gets it: plain text and its entities. */
const card=(kind:string,args:Record<string,any>)=>linked(operationCard(approvalAction,shown(kind,args),null));
const spans=(shown:{text:string;links:any[]},type:string)=>shown.links.filter(link=>link.type===type).map(link=>shown.text.slice(link.offset,link.offset+link.length));
/** The lines of a card's arguments, after its name. */
const body=(input:Record<string,any>)=>card('mcp',{connection:'notion',tool:'notion-update-page',input}).text.split('\n').slice(2);

test('a tool card says what it does and shows every field in words, long text in a quote',()=>{
  const content='Made-up summary of a synthetic chat.\n\n## Open requests\n- [ ] Weather for a made-up city.\n- [ ] Three names for a hiking group.\n\n'+
    Array(4).fill('A made-up note that runs on.').join(' ');
  const pages=card('mcp',{connection:'notion',tool:'notion-create-pages',input:{pages:[{content,properties:{title:'Open items from the test group'}}]}});
  assert.equal(pages.text,'⚙️ Notion · create pages\n\npages › properties › title: Open items from the test group\npages › content:\n'+content);
  assert.deepEqual(spans(pages,'bold'),['Notion · create pages','pages › properties › title:','pages › content:'],'the name and labels are bold, values never are');
  assert.deepEqual(spans(pages,'expandable_blockquote'),[content],'the long text is quoted whole, as written, and opens on a tap');
  assert.doesNotMatch(pages.text,/[{}"\\]/,'no JSON punctuation or escapes');
  // Several items each get a numbered group; a short list is one numbered line per value.
  const many=card('mcp',{connection:'notion',tool:'notion-create-pages',input:{parent:{page_id:'p1'},pages:[{properties:{title:'A'}},{properties:{title:'B'},content:'x\ny'}]}});
  assert.equal(many.text,'⚙️ Notion · create pages\n\nparent › page_id: p1\n\npages › 1\nproperties › title: A\n\npages › 2\nproperties › title: B\ncontent:\nx\ny');
  assert.deepEqual([spans(many,'blockquote'),spans(many,'expandable_blockquote')],[['x\ny'],[]],'short text with a line break is shown whole, never behind a tap');
  assert.equal(card('mcp',{connection:'notion',tool:'notion-move-pages',input:{new_parent:{page_id:'p2'},page_or_database_ids:['a','b, c']}}).text,
    '⚙️ Notion · move pages\n\nnew_parent › page_id: p2\npage_or_database_ids:\n1. a\n2. b, c');
  assert.equal(card('mcp',{url:'https://mcp.example.test/mcp',tool:'search_docs',input:{query:'made-up',limit:5,exact:false,empty:'',none:null}}).text,
    '⚙️ mcp.example.test · search_docs\n\nhttps://mcp.example.test/mcp\n\nquery: made-up\nlimit: 5\nexact: false\nempty: ""\nnone: null',
    'another server is named by its address, shown in full, and its tool by its exact name');
  assert.equal(card('mcp',{connection:'notion',operation:'list'}).text,'⚙️ Notion · list its tools');
  const shell=card('shell',{command:'printf ok'});
  assert.equal(shell.text,'⚙️ Run a command\n\nprintf ok');assert.deepEqual(spans(shell,'pre'),['printf ok']);
  assert.equal(card('shell',{command:'printf a\n\n\n  printf b'}).text,'⚙️ Run a command\n\nprintf a\n\n\n  printf b','filling the card never changes the command');
  assert.equal(card('browser',{url:'https://example.test/a'}).text,'⚙️ Open a web page · example.test\n\nhttps://example.test/a');
  // A host not written in plain ASCII, which tools can read as different hosts, shows exactly, every letter as its code.
  assert.equal(card('browser',{url:'https://p\u0430ypal.test/login'}).text,'⚙️ Open a web page · "p\\u0430ypal.test"\n\n"https://p\\u0430ypal.test/login"');
  for(const [url,host] of <[string,string][]>[['https://stra\u00dfe.test/','"stra\\u00dfe.test"'],['https://other.test\\@docs.example.test/x','"other.test\\\\@docs.example.test"'],
    ['https://%65xample.test/','"%65xample.test"'],['https://EXAMPLE.test:443/a','example.test'],['https:///example.test/',''],['https://gi\thub.test/','gihub.test'],
    ['https:/\t/other.test/','other.test'],['https://8.8.8.8./','"8.8.8.8."'],['https://0x08080808/','"0x08080808"'],['https://"example.test"/','"\\"example.test\\""']])
    assert.equal(shown('browser',{url}).title,'Open a web page'+(host?' · '+host:''),url);
  assert.equal(shown('mcp',{url:'https://stra\u00dfe.test/mcp',tool:'search',input:{}}).title,'"stra\\u00dfe.test" · search');
  // The owner words the kinds in Settings › Instructions.
  assert.equal(operationText('shell',{command:'ls'},approvalLines('kind_shell: Run this'))?.title,'Run this');
});

test('a connected service\'s tool reads in words only in its usual form, so no two tools read alike',()=>{
  const title=(tool:string)=>shown('mcp',{connection:'notion',tool,input:{}}).title;
  assert.equal(title('notion-search'),'Notion · search');
  for(const [tool,exact] of <[string,string][]>[['search','"search"'],['create_pages','"create_pages"'],['notion_create-pages','"notion_create-pages"'],['NOTION-search','"NOTION-search"'],['notion-search-','"notion-search-"']])
    assert.equal(title(tool),'Notion · '+exact,tool);
});

test('no argument can pass for a label, a field, a change or formatting',()=>{
  const sneaky='Harmless\n\nproperties › title: Something else';
  const shown=card('mcp',{connection:'notion',tool:'notion-update-page',input:{'title\n\nstatus':'v','a › b':'c','':'k',' x':'y',page:'\u0001b\u0002fake\u0003',notes:sneaky}});
  assert.match(shown.text,/^"title\\n\\nstatus": v$/m,'a key with a line break is quoted on one line');
  assert.match(shown.text,/^"a › b": c$/m);assert.match(shown.text,/^"": k$/m);assert.match(shown.text,/^" x": y$/m);
  assert.match(shown.text,/^page: "\\u0001b\\u0002fake\\u0003"$/m,'control characters never make an entity, and show');
  assert.deepEqual(spans(shown,'blockquote'),[sneaky],'text with a line break stays inside its quote');
  assert.ok(spans(shown,'bold').every(label=>!label.includes('\n')));
  assert.ok(!spans(shown,'bold').includes('properties › title:'),'the quoted line is not a label');
  // A key that is not plain words is quoted, so no look-alike of › or : and no change's name passes for structure.
  assert.deepEqual(body({'parent ˃ page_id':'x','page_idː':'y','2. ⚙️ Notion · create pages':'z','12':'n','Due date':'d','وضعیت':'باز',
    tags:['x','⚙️ Notion · create pages']}),
  ['"12": n','"parent ˃ page_id": x','"page_idː": y','"2. ⚙\ufe0f Notion · create pages": z','Due date: d','وضعیت: باز','tags:','1. x','2. "⚙\ufe0f Notion · create pages"']);
  // A key's letters come from one script, so no look-alike from another passes for a letter, a digit, › or :.
  assert.deepEqual(body({'page_id\u0903':'a','parent \u1433 page_id':'b','St\u0430tus':'c','Статус':'d','Café':'e','状態':'f','کتاب\u200cها':'g',
    'وظیفه ۱۲':'h','fi\u0661e':'i'}),
  ['"page_id\u0903": a','"parent \u1433 page_id": b','"St\u0430tus": c','Статус: d','Café: e','状態: f','کتاب\u200cها: g','وظیفه ۱۲: h','"fi\u0661e": i']);
  assert.deepEqual(body({'Cafe\u064e':'j'}),['"Cafe\u064e": j']);
  // Another form of the same text, such as an accent written apart, a sign for a letter or a ligature, never passes for it.
  assert.deepEqual(body({'Cafe\u0301':'a','\u212a':'b','\ufb01le':'c',v:'Cafe\u0301'}),['"Cafe\\u0301": a','"\\u212a": b','"\ufb01le": c','v: "Cafe\\u0301"']);
  assert.deepEqual(spans(card('shell',{command:'rm Cafe\u0301'}),'pre'),['"rm Cafe\\u0301"']);
  // The one field of an input is named too, so inputs that run differently never read alike.
  assert.deepEqual([body({create:{name:'Lunch'}}),body({delete:{name:'Lunch'}})],[['create › name: Lunch'],['delete › name: Lunch']]);
  // Every value shows, however the input is split.
  assert.deepEqual(body({a:{b:[1,{c:'d'}],e:[]},f:{},g:[[1,2],['h']]}),
    ['a › e: []','f: {}','','a › b › 1','1','','a › b › 2','c: d','','g › 1','1. 1','2. 2','','g › 2','h']);
});

test('a hidden character is written out, so the card never shows less than what runs',()=>{
  const shell=card('shell',{command:'printf ok\rprintf no'});
  assert.deepEqual(spans(shell,'pre'),['"printf ok\\rprintf no"'],'a carriage return could hide what comes before it');
  assert.deepEqual(spans(card('shell',{command:'"printf ok\\rprintf no"'}),'pre'),['"\\"printf ok\\\\rprintf no\\""'],'text that looks written out is quoted itself');
  // A space at the end of a line never shows: with it, `\\` no longer continues the line, and a tab reads like spaces.
  assert.deepEqual(spans(card('shell',{command:'echo safe \\ \nrm -rf ~/made-up'}),'pre'),['"echo safe \\\\ \\nrm -rf ~/made-up"']);
  assert.deepEqual(spans(card('shell',{command:'echo safe \\\nrm -rf ~/made-up'}),'pre'),['echo safe \\\nrm -rf ~/made-up']);
  assert.deepEqual(spans(card('shell',{command:'cat <<-EOF\n\tEOF'}),'pre'),['"cat <<-EOF\\n\\tEOF"']);
  assert.deepEqual(body({long:'line one \nline two'}),['long:','"line one \\nline two"'],'long text too');
  assert.deepEqual(body({long:'\n  \nline one\nline two \n '}),['long:','line one','line two'],'but blank lines before it and spaces after it are left out');
  assert.deepEqual(body({'ti\u200btle':'zero width',name:'plain',reversed:'\u202etxt.exe',spaced:'a\u00a0b','Status\u034f':'s',note:'line one\nline\u200b two'}),
    ['"ti\\u200btle": zero width','name: plain','reversed: "\\u202etxt.exe"','spaced: "a\\u00a0b"','"Status\\u034f": s','note:','"line one\\nline\\u200b two"']);
  // A joiner or selector stays as written only where it shows: inside a Persian word whose letters it keeps apart, or inside a whole emoji.
  const value=(text:string)=>body({v:text})[0];
  for(const kept of ['می\u200cخواهم','ب\u200cا','👩\u200d💻','🏳\ufe0f\u200d🌈','1\ufe0f\u20e3','❤\ufe0f'])assert.equal(value(kept),'v: '+kept,JSON.stringify(kept));
  for(const [text,exact] of <[string,string][]>[['دیوار\u200cها','"دیوار\\u200cها"'],['ب\u200c\ufe8d','"ب\\u200c\ufe8d"'],['a\u{1d159}b','"a\\ud834\\udd59b"'],['é\u200cé','"é\\u200cé"'],['ad\u200cmin','"ad\\u200cmin"'],['😀\u200d😀','"😀\\u200d😀"'],
    ['😀\ufe0f','"😀\\ufe0f"'],['Lunch \u{e0100}','"Lunch \\udb40\\udd00"'],['a\u034fb','"a\\u034fb"'],['\ue000','"\\ue000"'],['\u0378','"\\u0378"']])
    assert.equal(value(text),'v: '+exact,JSON.stringify(text));
  // They stay as written in quoted text, a command written out, and the JSON shown instead.
  assert.deepEqual(body({' می\u200cخواهم':'a',v:'"می\u200cخواهم 👩\u200d💻"',w:' ❤\ufe0f'}),['" می\u200cخواهم": a','v: "\\"می\u200cخواهم 👩\u200d💻\\""','w: " ❤\ufe0f"']);
  assert.deepEqual(spans(card('shell',{command:'echo 👩\u200d💻\rx'}),'pre'),['"echo 👩\u200d💻\\rx"']);
  assert.deepEqual(spans(card('shell',{command:'printf \u0001\ufe0f\u20e3'}),'pre'),['"printf \\u0001\\ufe0f\u20e3"'],'a selector never joins the code before it');
  assert.equal(value('\u0645\u0647\u0645\u0651\u200c\u062a\u0631\u06cc\u0646'),'v: \u0645\u0647\u0645\u0651\u200c\u062a\u0631\u06cc\u0646','a non-joiner after a letter with a shadda');
  assert.equal(value('\u062f\u0651\u200c\u0647\u0627'),'v: "\u062f\u0651\\u200c\u0647\u0627"','but not after a letter that does not join the next');
  assert.equal(value('\u0645\u062a\u0646\u0008\u0307'),'v: "\u0645\u062a\u0646\\b\u0307"','an escape never composes with the mark after it');
  assert.equal(value('\u0645\u062d\u0645\u0651\u064e\u062f'),'v: \u0645\u062d\u0645\u0651\u064e\u062f','marks on one letter in another order read the same');
  assert.equal(card('browser',{url:'https://example.test/a\u200b'}).text,'⚙️ Open a web page · example.test\n\n"https://example.test/a\\u200b"');
  const fallback=Object.fromEntries(Array.from({length:120},(_,index)=>['field'+index,index>1?'v':index?'می\u200cخواهم 👩\u200d💻':'\u202ev']));
  assert.match(shown('mcp',{connection:'notion',tool:'t',input:fallback}).body,/"field0":"\\u202ev"/,'the JSON shown instead escapes them too');
  assert.ok(shown('mcp',{connection:'notion',tool:'t',input:fallback}).body.includes('"field1":"می\u200cخواهم 👩\u200d💻"'));
  assert.equal(operationText('shell',{command:'x'+'\u00a0'.repeat(2000)},words),null,'written out, they can make an operation too long for a card');
});

test('a value that reads like another value or has spaces at its ends is quoted',()=>{
  const lines=card('mcp',{connection:'notion',tool:'t',input:{count:'5',number:5,flag:'true',none:'null',list:'[]',quote:'"hi"',
    spaces:'  ',edge:' x','1':'one',blank:' '.repeat(250),long:'"'+'x'.repeat(250)+'"'}});
  for(const line of ['count: "5"','number: 5','flag: "true"','none: "null"','list: "[]"','quote: "\\"hi\\""','spaces: "  "','edge: " x"','"1": one'])
    assert.ok(lines.text.split('\n').includes(line),line);
  assert.deepEqual(spans(lines,'expandable_blockquote'),[JSON.stringify(' '.repeat(250)),JSON.stringify('"'+'x'.repeat(250)+'"')],'text that is only spaces still shows; quoted text is quoted again');
});

test('keys that read alike show the input as JSON with every character beyond plain ASCII written out',()=>{
  const ascii=(input:Record<string,any>)=>{
    const args={connection:'notion',tool:'t',input},shownCard=linked(operationCard(approvalAction,shown('mcp',args),null)),[text]=spans(shownCard,'pre');
    assert.ok(text&&shownCard.text.endsWith(text),'in code, where each letter keeps its own shape');
    assert.match(text,/^[\x20-\x7e]+$/,JSON.stringify(input));assert.deepEqual(JSON.parse(text),args,'and nothing else changes');return text;
  };
  assert.equal(ascii({page:'a','p\u0430ge':'b'}),'{"connection":"notion","input":{"page":"a","p\\u0430ge":"b"},"tool":"t"}');
  // Letters of other scripts or small capitals drawn as Latin ones, the Persian and Arabic forms of one letter or digit,
  // other forms of one text, a dot over an i, a selector, and plain letters drawn alike, as Unicode lists them.
  for(const [one,two] of <[string,string][]>[['\u0440\u043e\u0435','poe'],['St\u03bfp','Stop'],['\u00b5s','\u03bcs'],['t\u1d0f','to'],['ta\u0261s','tags'],
    ['\u037f\u039f\u0392','JOB'],['$t\u0585p','$top'],['$\ua4e2elect','$Select'],['\u041f\u041e\u0420\u0422','\u03a0\u039f\u03a1\u03a4'],['\u0417a','3a'],
    ['\u0645\u0631\u062d\u0644\u0647 \u06f1','\u0645\u0631\u062d\u0644\u0647 \u0661'],['\u0628\u06cc\u062a','\u0628\u064a\u062a'],['\u06a9\u062a\u0627\u0628','\u0643\u062a\u0627\u0628'],
    ['\u0647\u0632\u06cc\u0646\u0647','\u06be\u0632\u06cc\u0646\u0647'],['\u0131\u0307d','id'],['i\u0307d','id'],['categor\u0131\u0301a','categor\u00eda'],['f\u00f8r','fo\u0338r'],
    ['Cafe\u0301','Caf\u00e9'],['\ufb01le','file'],['\u00b9','l'],['1\u20e3','1\ufe0f\u20e3'],['Iimit','limit'],['rnodel','model'],['i\u0327\u0307','i\u0327'],['\u067e','\u0752'],['\u0131\u1df8d','id'],['\u08be','\u067e\u065a'],['\u08b7','\u067e\u06e2'],
    ['\u0645\u062d\u0645\u0651\u064e\u062f','\u0645\u062d\u0645\u064e\u0651\u062f']])
    ascii({[one]:'a',[two]:'b'});
  // Keys deep in the input, or naming numbered groups, too.
  ascii({pages:[{'\u00b5s':[{a:1},{a:2}],'\u03bcs':[{a:3},{a:4}]},{x:1}]});
  // Keys that look different stay in words, and a mark drawn over a letter quotes its key.
  assert.deepEqual(body({for:'a','f\u00f8r':'b',page:'c',Page:'d',title:'e',name:'f'}),['for: a','f\u00f8r: b','page: c','Page: d','title: e','name: f']);
  assert.deepEqual(body({'o\u0338':'a','\u0131\u0307d':'b','i\u0307':'c','o\u20eb':'d','\u0237\u0307ob':'e','i\u0327\u0307':'f'}),
    ['"o\u0338": a','"\u0131\u0307d": b','"i\u0307": c','"o\u20eb": d','"\u0237\u0307ob": e','"i\u0327\u0307": f']);
  assert.deepEqual([body({'\u0131\u0358d':'a'}),body({'\u0269\u0307d':'b'}),body({'\u0131\u1df8d':'d'}),body({'\u0110\u1ecba ch\u1ec9':'c'})],[['"\u0131\u0358d": a'],['"\u0269\u0307d": b'],['"\u0131\u1df8d": d'],['\u0110\u1ecba ch\u1ec9: c']]);
  // Persian letters whose dots differ stay apart, though Unicode makes one of پ and ث.
  assert.deepEqual(body({'\u0627\u0644\u0641':'a','\u0628':'b','\u067e':'c','\u062a':'d','\u062b':'e'}),['\u0627\u0644\u0641: a','\u0628: b','\u067e: c','\u062a: d','\u062b: e']);
});

test('an input too long or too finely split for words is shown as its exact JSON',()=>{
  const fields=Object.fromEntries(Array.from({length:120},(_,index)=>['field'+index,'v']));
  const args={connection:'notion',tool:'t',input:fields};
  assert.equal(shown('mcp',args).body,canonical(args),'more fields than Telegram has entities');
  const wide={connection:'notion',tool:'t',input:{deeply:{nested:Object.fromEntries(Array.from({length:60},(_,index)=>['k'+index,'v'.repeat(40)]))}}};
  assert.equal(shown('mcp',wide).body,canonical(wide),'longer in words than a card holds');
});

test('a card cut to fit keeps only the entities on what is left',()=>{
  const shown=linked('ab\u0001b\u0002cdef\u0003gh\u0001q\u0002ij\u0003');
  assert.deepEqual(shown,{text:'abcdefghij',links:[{type:'bold',offset:2,length:4},{type:'expandable_blockquote',offset:8,length:2}]});
  assert.deepEqual(cut(shown,6),{text:'abcde…',links:[{type:'bold',offset:2,length:3}]});
  assert.equal(cut(shown,20),shown);
  assert.deepEqual(cut(linked('ab\u0001q\u0002x📌y\u0003'),5),{text:'abx…',links:[{type:'expandable_blockquote',offset:2,length:1}]},'a character is never cut in two');
});

test('a summary from the asker leads the card, and the exact fields fold under it',()=>{
  const said=(kind:string,args:Record<string,any>,summary:string|null,template=approvalAction)=>{
    const text=operationText(kind,args,words,summary);assert.ok(text,'the operation fits a card');return linked(operationCard(template,text,null));
  };
  const content='- [ ] Made-up task one\n- [ ] Made-up task two';
  const pages=said('mcp',{connection:'notion',tool:'notion-create-pages',input:{parent:{page_id:'p1'},pages:[{properties:{title:'Plans'},content}]}},'Add a page “Plans” with two made-up tasks.');
  assert.equal(pages.text,'⚙️ Notion · create pages\n📝 Add a page “Plans” with two made-up tasks.\n\nExact details\nparent › page_id: p1\npages › properties › title: Plans\n'+
    'pages › content:\n  - [ ] Made-up task one\n  - [ ] Made-up task two');
  assert.deepEqual(spans(pages,'expandable_blockquote'),[pages.text.slice(pages.text.indexOf('Exact details'))],'every field folds into one quote that opens on a tap');
  assert.deepEqual(spans(pages,'blockquote'),[],'with no quote inside it, which Telegram forbids');
  assert.deepEqual(spans(pages,'bold'),['Notion · create pages','Exact details','parent › page_id:','pages › properties › title:','pages › content:'],
    'the summary is never bold; the labels in the fold still are');
  // Inside the fold a long value has no quote of its own: its lines are indented, so none starts a line as a label.
  const sneaky=said('mcp',{connection:'notion',tool:'notion-update-page',input:{notes:'Harmless\n\nproperties › title: Something else'}},'Update the notes.');
  assert.match(sneaky.text,/^  properties › title: Something else$/m);
  assert.ok(!spans(sneaky,'bold').includes('properties › title:'));
  // A command, and an input whose keys read alike, stay open in code, which Telegram cannot put in a quote.
  const shell=said('shell',{command:'ls -la'},'List the files here.');
  assert.equal(shell.text,'⚙️ Run a command\n📝 List the files here.\n\nls -la');
  assert.deepEqual([spans(shell,'pre'),spans(shell,'expandable_blockquote')],[['ls -la'],[]]);
  const twins=said('mcp',{connection:'notion',tool:'t',input:{page:'a','p\u0430ge':'b'}},'Update a page.');
  assert.deepEqual([spans(twins,'pre').length,spans(twins,'expandable_blockquote')],[1,[]]);
  // Without a summary the card is as before; a template without a place for one gets it under the name.
  assert.equal(said('browser',{url:'https://example.test/'},null).text,'⚙️ Open a web page · example.test\n\nhttps://example.test/');
  assert.equal(said('browser',{url:'https://example.test/'},'Read the page.','{kind}\n\n{arguments}').text,'Open a web page · example.test\n📝 Read the page.\n\nExact details\nhttps://example.test/');
  assert.match(said('browser',{url:'https://example.test/'},'Read the page.','Approve this?\n\n{arguments}').text,/^📝 Read the page\.\nApprove this\?\n/);
  assert.deepEqual(said('browser',{url:'https://example.test/'},'Read it.','⚙️ {kind}\u0004\n📝 {summary}\u0005\n\n{arguments}').links.length,3,'owner text never opens a fold');
  assert.equal(said('browser',{url:'https://example.test/'},'Read the page.','⚙️ {kind}\n📝 {summary} · {origin}\n\n{arguments}').text,
    '⚙️ Open a web page · example.test\n📝 Read the page.\n\nExact details\nhttps://example.test/','nor when its own line is left out for a missing value');
  // Folded, long values need no quote each, so an input can fit a card only with its summary; without one it may not.
  const input={notes:Object.fromEntries(Array.from({length:46},(_,index)=>['k'+index,'س'.repeat(16)+'\n'+'د'.repeat(16)])),z:'e\u0301'};
  assert.ok(operationText('mcp',{connection:'notion',tool:'notion-update-page',input},words,'Update the notes.')?.body.startsWith('\u0004'));
  assert.equal(operationText('mcp',{connection:'notion',tool:'notion-update-page',input},words),null);
});

test('a summary is one line, written out when it hides a character or could pass for structure',()=>{
  const line=(summary:string)=>operationText('browser',{url:'https://example.test/'},words,summary)?.summary;
  assert.equal(line('  Read   the\nweather\tpage. '),'Read the weather page.');
  assert.equal(line('مرور صفحه\u200cی هوا'),'مرور صفحه\u200cی هوا','a Persian half-space between joined letters shows');
  assert.equal(line('Read \u200bthe page'),'"Read \\u200bthe page"');
  assert.equal(line('Read\u0004 it'),'"Read\\u0004 it"','a control character never makes a fold, and shows');
  assert.equal(line('"Approved"'),'"\\"Approved\\""');
  assert.match(line('⚙️ Notion · delete pages')!,/^"⚙/,'it never passes for a change on a list card');
  assert.equal(line('   '),null);assert.equal(line('x'.repeat(601)),null,'too long for a line, it is left out');
  assert.equal(operationText('browser',{url:'https://example.test/'},words,'x'.repeat(601))?.body,'https://example.test/','and the fields stay open');
});

test('a fold holds the entities inside it and closes at the end of the text',()=>{
  assert.deepEqual(linked('a\u0004\u0001b\u0002bc\u0003d\u0005e'),{text:'abcde',links:[{type:'expandable_blockquote',offset:1,length:3},{type:'bold',offset:1,length:2}]});
  assert.deepEqual(linked('a\u0004bc'),{text:'abc',links:[{type:'expandable_blockquote',offset:1,length:2}]});
  assert.deepEqual(linked('a\u0004\u0005b'),{text:'ab',links:[]},'an empty fold is no entity');
  assert.deepEqual(cut(linked('ab\u0004cdefgh\u0005'),5),{text:'abcd…',links:[{type:'expandable_blockquote',offset:2,length:2}]});
});
