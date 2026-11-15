import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/archive.js';
import {accountIdFor,chatDirectory,chatShortId} from '../src/chats.js';
import {approvalLines,reminderLines,taskReminder} from '../src/prompts.js';
import {fitMessage,mergedReminder,nameKeys,noteLines,reminderText,setByLine,shownCut,unitCut,wellFormed,whoLabel,
  type Names,type ReminderRow,type Who,type Words} from '../src/task-reminder-text.js';
import {BOB_CHAT,GP1,GP1_TOPIC,fixtureChats} from './fixture-groups.js';

/** “name”, isolated, as code quotes a name. */
const q=(name:string)=>'\u2068\u201c'+name+'\u201d\u2069';
const words:Words={lines:reminderLines(undefined),places:approvalLines(undefined),template:taskReminder};
const fixture=fixtureChats([GP1]);
const directory=chatDirectory({...fixture,chats:fixture.chats.map(chat=>chat.id===GP1?{...chat,title:'Family'}:chat.id===GP1_TOPIC?{...chat,title:'Plans'}:chat)});
const sara=accountIdFor('telegram','4561'),omid=accountIdFor('telegram','4562'),twin=accountIdFor('telegram','4563'),gone=accountIdFor('telegram','4564');
const names=(people:Record<string,{display_name:string|null;username:string|null}>,allowed=[sara,omid,twin]):Names=>
  ({directory,allowed:new Map(allowed.map(account=>[account,[GP1]])),people:new Map(Object.entries(people))});
const people={[sara]:{display_name:'Sara',username:'sara_example'},[omid]:{display_name:'Omid',username:null}};
const person=(account:string|null,name:string|null=null):Who=>({by:'person',account,name});
const owner:Who={by:'owner',account:null,name:null};
let serial=0;
const reminder=(fields:Partial<ReminderRow>):ReminderRow=>({id:String(++serial).padStart(64,'0'),at:Date.UTC(2030,0,4,9,0)+serial,setter:owner,chat:null,title:'Book the hall',
  notes:'',due:null,list:null,closed:false,writers:[],...fields});

test('cuts keep whole characters: a reminder is never refused for half an emoji',()=>{
  assert.equal(unitCut('a'.repeat(499)+'\u{1f600}',500),'a'.repeat(499),'the emoji that would be split goes whole');
  assert.equal(unitCut('a'.repeat(498)+'\u{1f600}',500),'a'.repeat(498)+'\u{1f600}');
  assert.equal(unitCut('short',500),'short','text that fits is exactly as before');
  assert.equal(wellFormed('a\ud83d b\ude00'),'a\ufffd b\ufffd');assert.equal(wellFormed('\u{1f600}'),'\u{1f600}');
  assert.equal(shownCut('ab[U+3164]cd',12),'ab[U+3164]cd');
  assert.equal(shownCut('ab[U+3164]cd',11),'ab[U+3164]\u2026');
  assert.equal(shownCut('ab[U+3164]cd',10),'ab\u2026','a written-out character is never split');
  assert.equal(shownCut('ab[U+3164]cd',5),'ab\u2026');
});

test('a person\'s notes are collapsed and every line is marked, so none passes for a line code wrote',()=>{
  const mark=words.lines.note_line;
  assert.equal(noteLines('Pay   now\r\n\n\n\n\u3164\n\tfake \t line\n',mark),'\u2506 Pay now\n\u2506\n\u2506 fake line');
  assert.equal(noteLines('\n\n\n\nfake',mark),'\u2506 fake','blank lines before the first go');
  assert.equal(noteLines('x\u200by',mark),'\u2506 x[U+200B]y','hidden characters are written out');
  const many=noteLines(Array.from({length:30},(_,i)=>'line '+i).join('\n'),mark).split('\n');
  assert.equal(many.length,20);assert.equal(many.at(-1),'\u2506 \u2026');
  assert.ok(Array.from(noteLines('word '.repeat(300),mark)).length<=500);
});

test('who set a reminder: you, a person you allowed by the name Telegram shows, or someone you allowed',()=>{
  const all=names({...people,[twin]:{display_name:'Sara',username:null},[gone]:{display_name:'Gone',username:null},
    [omid]:{display_name:'\u0645\u0647\u0631\u200c\u0646\u0627\u0632',username:null}}),keys=nameKeys(all,[person(gone)]);
  assert.equal(whoLabel(owner,words,all,keys),'you');
  assert.equal(whoLabel(person(sara),words,all,keys),q('Sara')+' @sara_example, a person you allowed','two people named Sara: one by @username');
  assert.equal(whoLabel(person(twin),words,all,keys),q('Sara')+' (\u2026'+digest(canonical(['account-label-v1',twin])).slice(0,4)+'), a person you allowed',
    'the other, with no username or private chat, by a short id of their account');
  assert.equal(whoLabel(person(omid),words,all,keys),q('\u0645\u0647\u0631\u200c\u0646\u0627\u0632')+', a person you allowed','a Persian half-space stays');
  assert.equal(whoLabel(person(gone),words,all,keys),q('Gone')+', a person you no longer allow');
  const blank=names({[sara]:{display_name:'\u3164',username:null}});
  assert.equal(whoLabel(person(sara),words,blank,nameKeys(blank,[])),'someone you allowed','a blank filler is no name');
  assert.equal(whoLabel(person(sara,'Sara'),words,blank,nameKeys(blank,[])),q('Sara')+', a person you allowed','then the name Telegram showed when it was set');
  const byUsername=names({[sara]:{display_name:null,username:'sara_example'}});
  assert.equal(whoLabel(person(sara),words,byUsername,nameKeys(byUsername,[])),q('@sara_example')+', a person you allowed');
  assert.equal(whoLabel(person(null,'Sara'),words,all,keys),'someone you allowed','a person Nocheh could not tell is never named by what they typed');
  // A name that reads like the owner's chat or a served group gets its short id.
  const owners=names({[sara]:{display_name:'0wner',username:null},[omid]:{display_name:'Fam\u0456ly',username:null}});
  const ownerKeys=nameKeys(owners,[]);
  assert.match(whoLabel(person(sara),words,owners,ownerKeys),/^\u2068\u201c0wner\u201d\u2069 \(\u2026[0-9a-f]{4}\), a person you allowed$/);
  assert.match(whoLabel(person(omid),words,owners,ownerKeys),/\(\u2026[0-9a-f]{4}\)/);
  // A person's short id is their private chat's, the one the dashboard's chat list shows.
  const bob=accountIdFor('telegram','456'),bobs=names({[bob]:{display_name:'Owner',username:null}},[bob]);
  assert.equal(whoLabel(person(bob),words,bobs,nameKeys(bobs,[])),q('Owner')+' (\u2026'+chatShortId(BOB_CHAT)+'), a person you allowed');
});

test('a {place} inside a name stays as typed and never takes a value',()=>{
  const all=names({[sara]:{display_name:'Sara {place}',username:null}});
  const line=setByLine({setter:person(sara),chat:GP1_TOPIC},words,all,nameKeys(all,[]))!;
  assert.equal(line,'\u{1f464} Set by '+q('Sara [place]')+', a person you allowed in group '+q('Family')+' \u203a topic '+q('Plans'));
  assert.equal(setByLine({setter:owner,chat:null},words,all,nameKeys(all,[])),null,'set in the private chat or the dashboard: no line');
});

test('the owner\'s own reminder reads exactly as before; one written elsewhere names who wrote it, its title on one line',()=>{
  const all=names(people);
  assert.equal(reminderText(reminder({title:'Book\nthe hall',notes:'Two rooms\n\n\n\nfake',due:'Fri, 4 Jan 2030',list:'Home'}),words,all),
    '\u23f0 Book\nthe hall\n\u{1f4c5} Fri, 4 Jan 2030\n\u{1f4c1} Home\n\nTwo rooms\n\nfake','unchanged when nobody else wrote it');
  const written=reminder({title:'Book\nPay now',notes:'Two rooms\n\n\n\nfake',writers:[{...person(omid),field:'title',chat:GP1},{...person(omid),field:'notes',chat:GP1}]});
  assert.equal(reminderText(written,words,all),'\u270f\ufe0f Last written by '+q('Omid')+', a person you allowed in group '+q('Family')+': title, notes\n'+
    '\u23f0 Book Pay now\n\n\u2506 Two rooms\n\u2506\n\u2506 fake');
  const closed=reminder({closed:true,writers:[{...person(sara),field:'closed',chat:GP1_TOPIC}]});
  assert.equal(reminderText(closed,words,all),'\u2611\ufe0f Closed by '+q('Sara')+', a person you allowed in group '+q('Family')+' \u203a topic '+q('Plans')+
    '\n\u23f0 Book the hall');
  const inGroup=reminder({chat:GP1,writers:[{...owner,field:'title',chat:GP1}]});
  assert.equal(reminderText(inGroup,words,all),'\u{1f464} Set by you in group '+q('Family')+'\n\u23f0 Book the hall','the setter writing where it set it adds no line');
  // Notes are cut at 500 UTF-16 units without splitting a character.
  assert.equal(reminderText(reminder({title:'Pay',notes:'a'.repeat(499)+'\u{1f600}'}),words,all),'\u23f0 Pay\n\n'+'a'.repeat(499));
});

test('the code lines are never cut: a long template is, and the message stays within 4000',()=>{
  const all=names(people),long:Words={...words,template:'{title} '+'x'.repeat(20000)+'\u{1f600}'.repeat(10)};
  const text=reminderText(reminder({chat:GP1,setter:person(sara)}),long,all);
  assert.ok(text.length<=4000);assert.ok(text.startsWith('\u{1f464} Set by '+q('Sara')+', a person you allowed in group '+q('Family')+'\n'));
  assert.ok(text.endsWith('\u2026'));assert.equal(wellFormed(text),text);
  assert.equal(fitMessage(['line'],'b'.repeat(10),4000),'line\n'+'b'.repeat(10));
  assert.equal(fitMessage(['line'],'b'.repeat(10),10),'line\nbbbb\u2026');
  assert.equal(fitMessage(['l'.repeat(20)],'b',10),'l'.repeat(9)+'\u2026','only an owner\'s line past the limit is cut itself');
});

test('people\'s reminders due together are merged round-robin, one Set by line per person and place, within the limit',()=>{
  const all=names(people);
  const saras=Array.from({length:6},(_,i)=>reminder({setter:person(sara,'Sara'),chat:GP1_TOPIC,title:'Sara task '+i,notes:'n'.repeat(300),at:Date.UTC(2030,0,4,9,i)}));
  const omids=[reminder({setter:person(omid,'Omid'),chat:GP1,title:'Omid task',at:Date.UTC(2030,0,4,10,0)})];
  const rows=[...saras,...omids],{text,taken}=mergedReminder(rows,words,all,GP1,0,1200);
  assert.ok(text.length<=1200);
  assert.ok(taken.length>=2&&taken.length<rows.length,String(taken.length));
  assert.ok(taken.some(row=>row.title==='Omid task'),'one person\'s many never hold back another\'s');
  assert.ok(text.startsWith('\u{1f514} '+taken.length+' reminders set in group '+q('Family')+'\n\n'));
  assert.equal(text.split('\u{1f464} Set by '+q('Sara')).length-1,1,'one Set by line for Sara in the topic');
  assert.equal(text.split('\u{1f464} Set by '+q('Omid')+', a person you allowed in group '+q('Family')+'\n').length-1,1);
  assert.ok(text.includes('\u{1f464} Set by '+q('Sara')+', a person you allowed in group '+q('Family')+' \u203a topic '+q('Plans')+'\n\u23f0 Sara task 0'));
  assert.ok(text.endsWith('\u23f3 '+(rows.length-taken.length)+' more reminders set in group '+q('Family')+
    ' are due. They come in the next message; at most one message per group every 10 minutes.'));
  // Everything fits: no header line for the rest, and no more_waiting line.
  const whole=mergedReminder(rows,words,all,GP1);
  assert.equal(whole.taken.length,7);assert.ok(!whole.text.includes('\u23f3'));
  assert.ok(whole.text.indexOf('Sara task 5')<whole.text.indexOf('Omid task'),'sections in order of their first due reminder');
  // Reminders beyond the ones read count as waiting too.
  assert.ok(mergedReminder(omids,words,all,GP1,3).text.endsWith('\u23f3 3 more reminders set in group '+q('Family')+
    ' are due. They come in the next message; at most one message per group every 10 minutes.'));
  // One reminder alone longer than the limit is still taken, its body cut so the lines around it stay whole.
  const huge=reminder({setter:person(sara,'Sara'),chat:GP1,title:'t'.repeat(300),notes:'n'.repeat(500)});
  const cut=mergedReminder([huge,...omids],words,all,GP1,0,500);
  assert.equal(cut.taken.length,1);assert.equal(cut.taken[0]!.id,huge.id);assert.ok(cut.text.length<=500,String(cut.text.length));
  assert.ok(cut.text.startsWith('\u{1f464} Set by '+q('Sara')+', a person you allowed in group '+q('Family')+'\n\u23f0 '));
  assert.ok(cut.text.includes('\u2026\n\n\u23f3 1 more reminders'),cut.text);
  assert.ok(!cut.text.startsWith('\u{1f514}'),'one reminder has no header');
});
