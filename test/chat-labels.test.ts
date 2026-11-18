import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cardName} from '../src/action-text.js';
import {blankName,calmMarks,fillLine,isolate,labelName,nameKey,placeLabel,quotedName} from '../src/chat-labels.js';
import {chatDirectory,chatShortId} from '../src/chats.js';
import {approvalLines} from '../src/prompts.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP4,NG1,NG1_TG,NG1_TOPIC,OWNER,fixtureChats} from './fixture-groups.js';

const words=approvalLines('');
/** “name”, isolated, as code quotes a name. */
const q=(name:string)=>'\u2068\u201c'+name+'\u201d\u2069';

test('a name\'s quote, bracket and angle look-alikes show as plain \' [ ] < >',()=>{
  const cases:[string,string][]=[['"',"'"],['(','['],[')',']'],['\u203a','>'],['\u02ba',"'"],['\u02dd',"'"],['\u3003',"'"],['\uff08','['],['\ufe59','['],
    ['\u2768','['],['\u276f','>'],['\u1433','>'],['\u3009','>'],['\u00ab',"'"],['\u00bb',"'"],['\u{1f677}',"'"],['\u201c',"'"],['\u201d',"'"],['\u2039','<'],
    ['\u276e','<'],['\u3008','<'],['\u201e',"'"],['\u301d',"'"]];
  for(const [char,plain] of cases)assert.equal(labelName('a'+char+'b'),'a'+plain+'b',char.codePointAt(0)!.toString(16));
  assert.equal(labelName('Sara\u02ba \uff08a member in \u02baFamily'),"Sara' [a member in 'Family",
    'a name cannot close the quotes or open the brackets a card puts around it');
  assert.equal(labelName('Wait\u2026'),'Wait...','only a cut ends in an ellipsis');
  assert.equal(labelName('x\u2068y\u202ez'),'x[U+2068]y[U+202E]z','a direction mark is written out, never kept');
});

test('a name keeps Persian half-spaces and emoji, and writes out what a reader would not see',()=>{
  const persian=['\u06a9\u0627\u0631\u200c\u0647\u0627','\u06a9\u062a\u0627\u0628\u200c\u0647\u0627'];
  for(const name of persian)assert.equal(labelName(name),name,'the half-space stays');
  const family='\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
  assert.equal(labelName(family+' Family'),family+' Family','an emoji keeps its joiners');
  assert.equal(cardName('\u3164'),'[U+3164]');assert.equal(blankName('[U+3164]'),true);assert.equal(labelName('\u3164'),null,'a blank filler is no name');
  assert.equal(labelName(' \u3164 \u200b '),null);assert.equal(labelName(7),null);assert.equal(blankName(null),true);assert.equal(blankName('[U+3164] x'),false);
});

test('at most three marks stay on a letter, and a name is cut whole',()=>{
  const smeared=labelName('S'+'\u0301'.repeat(60))!;
  assert.ok(smeared.startsWith('S\u0301\u0301\u0301[U+0301][U+0301]'),smeared);
  assert.ok(smeared.endsWith(']\u2026'),'the cut never splits a written-out mark');
  assert.equal(Array.from(smeared).length,61);
  assert.equal(calmMarks('\u0628\u0651\u064e'),'\u0628\u0651\u064e','a shadda and a vowel stay');
  assert.equal(calmMarks('e\u0301\u0302\u0303\u0304'),'e\u0301\u0302\u0303[U+0304]');
  assert.equal(labelName('a'.repeat(64)),'a'.repeat(64));
  assert.equal(labelName('a'.repeat(100)),'a'.repeat(63)+'\u2026','64 characters at most');
  assert.equal(labelName('abcdef',4),'abc\u2026');
});

test('names that read alike share a key',()=>{
  assert.equal(nameKey('BiII'),nameKey('Bill'));assert.equal(nameKey('PauI'),nameKey('Paul'));
  assert.equal(nameKey('F\u0430mily'),nameKey('family'),'a Cyrillic a');
  assert.notEqual(nameKey('Family'),nameKey('Plans'));
});

test('a line is filled in one pass and never dropped',()=>{
  assert.equal(fillLine('Set by {who} in {place}',{who:'Sara {place}',place:'group'}),'Set by Sara {place} in group','a {place} from a value stays as written');
  assert.equal(fillLine('{who} at {time}',{who:''}),' at {time}','a missing value leaves its name, and the line stays');
  assert.equal(fillLine('{constructor}',{}),'{constructor}');
  assert.equal(quotedName('Bob'),q('Bob'));assert.equal(isolate('x'),'\u2068x\u2069');
});

test('a chat is named in fixed words, its name quoted, with its short id where it reads like another served group',()=>{
  const fixture=fixtureChats([GP1,GP3,GP4,NG1_TG]);
  const titles:Record<string,string|null>={[GP1]:'Family',[GP3]:'Family',[GP4]:'F\u0430mily',[GP1_TOPIC]:'Plans',[NG1]:null,[GP2]:'Team {place}'};
  const d=chatDirectory({...fixture,chats:fixture.chats.map(chat=>chat.id in titles?{...chat,title:titles[chat.id]!}:chat)});
  const id=(chat:string)=>' (\u2026'+chatShortId(chat)+')';
  assert.equal(placeLabel(OWNER,words,d),'your private chat');
  assert.equal(placeLabel(createHash('sha256').update('made-up chat').digest('hex'),words,d),'a chat Nocheh no longer knows');
  assert.equal(placeLabel(GP1,words,d),'group '+q('Family')+id(GP1),'two served groups both titled Family');
  assert.equal(placeLabel(GP3,words,d),'group '+q('Family')+id(GP3));
  assert.equal(placeLabel(GP4,words,d),'group '+q('F\u0430mily')+id(GP4),'a look-alike title collides too');
  assert.equal(placeLabel(GP1_TOPIC,words,d),'group '+q('Family')+id(GP1)+' \u203a topic '+q('Plans'));
  assert.equal(placeLabel(GP2,words,d),'group '+q('Team [place]')+' (not served now)','an off group; braces in a name show as brackets, so it never holds a value\'s name');
  assert.equal(placeLabel(NG1,words,d),'a Telegram group'+id(NG1),'an unnamed group always gets its short id');
  assert.equal(placeLabel(NG1_TOPIC,words,d),'a Telegram group'+id(NG1)+' \u203a a topic');
  assert.equal(placeLabel(BOB_CHAT,words,d),'private chat with '+q('Bob'));
  assert.equal(placeLabel(GP1,words,d,{general:true}),'group '+q('Family')+id(GP1)+' \u203a General','a forum group as its General topic');
  // The owner's words are used as edited; a topic line without {topic} is shown as written, as on a card today.
  const edited={...words,group_chat:'the {name} group',topic:'(a topic)',not_served:'[off]'};
  assert.equal(placeLabel(GP1_TOPIC,edited,d),'the '+q('Family')+id(GP1)+' group (a topic)');
  assert.equal(placeLabel(GP2,edited,d),'the '+q('Team [place]')+' group [off]');
  const unnamed=chatDirectory({...fixture,chats:fixture.chats.map(chat=>chat.id===BOB_CHAT?{...chat,title:'\u3164'}:chat)});
  assert.equal(placeLabel(BOB_CHAT,words,unnamed),'private chat with a person \u2026'+chatShortId(BOB_CHAT));
});
