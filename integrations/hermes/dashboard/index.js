(() => {
  const {React}=window.__HERMES_PLUGIN_SDK__, h=React.createElement;
  const Back=()=>h('div',{className:'nocheh-return'},h('a',{href:'/'},'← Back to Nocheh'),h('span',null,'Hermes runtime'));
  const Home=()=>h('section',{className:'nocheh-native-home'},h('h1',null,'Hermes in Nocheh'),
    h('p',null,'Use the native navigation for your agent, profiles, tools, and sessions.'),
    h('p',null,'Nocheh manages your archive, imports, source graph, privacy, and approvals.'),h('a',{href:'/'},'Open Nocheh →'));
  window.__HERMES_PLUGINS__.register('nocheh',Home);
  window.__HERMES_PLUGINS__.registerSlot('nocheh','pre-main',Back);
})();
