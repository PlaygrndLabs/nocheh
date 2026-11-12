import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readTaskSettings,storedTaskSettings} from '../src/stores/task-settings.js';

test('the owner\'s columns are private to the owner until shared with project chats',()=>{
  const columns=readTaskSettings({properties:[{id:'effort',name:'Effort',type:'number',shared:true},{id:'secret',name:'Secret',type:'text'}]}).properties;
  assert.deepEqual(columns.map(item=>[item.id,item.shared]),[['effort',true],['secret',false]],'a column with no choice is not shared');
  assert.throws(()=>readTaskSettings({properties:[{id:'effort',name:'Effort',type:'number',shared:'yes'}]}),{code:'invalid_task_property'});
  assert.throws(()=>readTaskSettings({properties:[{id:'effort',name:'Effort',type:'number',shared:1}]}),{code:'invalid_task_property'});
  // Settings saved before a column could be shared read as not shared.
  assert.deepEqual(storedTaskSettings({properties:[{id:'area',name:'Area',type:'select',options:[{id:'home',name:'Home'}]}]}).properties,
    [{id:'area',name:'Area',type:'select',options:[{id:'home',name:'Home',color:'neutral'}],shared:false}]);
});
