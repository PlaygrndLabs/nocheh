import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const root=process.argv[2];
if(!root)throw new Error('CPA Manager Plus source path is required');
function patch(relative,changes) {
  const path=join(root,relative);let text=readFileSync(path,'utf8');
  for(const [before,after] of changes) {
    if(!text.includes(before))throw new Error(`CPA Manager Plus patch anchor missing: ${relative}`);
    text=text.replace(before,after);
  }
  writeFileSync(path,text);
}

patch('apps/web/src/utils/connection.ts',[[
  '    const { protocol, hostname, port } = window.location;\n    const normalizedPort = port ? `:${port}` : \'\';\n    return normalizeApiBase(`${protocol}//${hostname}${normalizedPort}`);',
  '    const { protocol, hostname, port, pathname } = window.location;\n    const normalizedPort = port ? `:${port}` : \'\';\n    const ownerPrefix = pathname.startsWith(\'/providers/\') ? \'/providers\' : \'\';\n    return normalizeApiBase(`${protocol}//${hostname}${normalizedPort}${ownerPrefix}`);'
]]);

patch('apps/web/src/stores/useAuthStore.ts',[
  [
    'let restoreSessionPromise: Promise<RestoreSessionResult> | null = null;',
    "const NOCHEH_OWNER_PROXY = typeof window !== 'undefined' && window.location.pathname.startsWith('/providers/');\nconst NOCHEH_PROXY_KEY = 'nocheh-owner-session';\nconst nochehProxyBase = () => detectApiBaseFromLocation();\nlet restoreSessionPromise: Promise<RestoreSessionResult> | null = null;"
  ],
  [
    "      isAuthenticated: false,\n      apiBase: '',\n      managementKey: '',\n      rememberPassword: false,",
    "      isAuthenticated: NOCHEH_OWNER_PROXY,\n      apiBase: NOCHEH_OWNER_PROXY ? nochehProxyBase() : '',\n      managementKey: NOCHEH_OWNER_PROXY ? NOCHEH_PROXY_KEY : '',\n      rememberPassword: false,"
  ],
  [
    "      sessionMode: '',\n      sessionPanelBase: '',\n      connectionStatus: 'disconnected',",
    "      sessionMode: NOCHEH_OWNER_PROXY ? 'manager_embedded' : '',\n      sessionPanelBase: NOCHEH_OWNER_PROXY ? nochehProxyBase() : '',\n      connectionStatus: NOCHEH_OWNER_PROXY ? 'connected' : 'disconnected',"
  ],
  [
    "      logout: () => {\n        restoreSessionPromise = null;",
    "      logout: () => {\n        if (NOCHEH_OWNER_PROXY) return;\n        restoreSessionPromise = null;"
  ],
  [
    "        getItem: (name) => {\n          const data = obfuscatedStorage.getItem<AuthStoreState>(name);",
    "        getItem: (name) => {\n          if (NOCHEH_OWNER_PROXY) return null;\n          const data = obfuscatedStorage.getItem<AuthStoreState>(name);"
  ],
  [
    "        setItem: (name, value) => {\n          obfuscatedStorage.setItem(name, JSON.parse(value));",
    "        setItem: (name, value) => {\n          if (NOCHEH_OWNER_PROXY) return;\n          obfuscatedStorage.setItem(name, JSON.parse(value));"
  ],
  [
    "        removeItem: (name) => {\n          obfuscatedStorage.removeItem(name);",
    "        removeItem: (name) => {\n          if (NOCHEH_OWNER_PROXY) return;\n          obfuscatedStorage.removeItem(name);"
  ],
  [
    '// 监听全局未授权事件',
    "if (NOCHEH_OWNER_PROXY) apiClient.setConfig({apiBase: nochehProxyBase(), managementKey: NOCHEH_PROXY_KEY});\n\n// 监听全局未授权事件"
  ],
]);

patch('apps/web/src/services/api/client.ts',[[
  "        if (!scopedRequest && this.managementKey) {\n          config.headers.Authorization = `Bearer ${this.managementKey}`;\n        }",
  "        if (!scopedRequest && this.managementKey) {\n          config.headers.Authorization = `Bearer ${this.managementKey}`;\n        }\n        const nochehCsrf = (window as Window & {__NOCHEH_CSRF__?: string}).__NOCHEH_CSRF__;\n        if (nochehCsrf && window.location.pathname.startsWith('/providers/')) {\n          config.headers['X-Nocheh-CSRF'] = nochehCsrf;\n        }"
]]);

patch('apps/web/src/services/api/usageService.ts',[[
  "const authHeaders = (managementKey?: string) =>\n  managementKey ? { Authorization: `Bearer ${managementKey}` } : undefined;",
  "const authHeaders = (managementKey?: string) => {\n  const nochehCsrf = typeof window === 'undefined' ? '' :\n    (window as Window & {__NOCHEH_CSRF__?: string}).__NOCHEH_CSRF__;\n  return {\n    ...(managementKey ? { Authorization: `Bearer ${managementKey}` } : {}),\n    ...(nochehCsrf && window.location.pathname.startsWith('/providers/')\n      ? {'X-Nocheh-CSRF': nochehCsrf} : {}),\n  };\n};"
]]);
