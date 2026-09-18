import {storageLayout} from '../stores/config.js';
if(storageLayout()==='original-only-v1')await import('../stores/security-main.js');
else await import('./legacy-main.js');
