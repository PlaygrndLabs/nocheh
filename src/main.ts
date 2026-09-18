import {storageLayout} from './stores/config.js';
if(storageLayout()==='original-only-v1')await import('./stores/main.js');
else await import('./legacy-main.js');
