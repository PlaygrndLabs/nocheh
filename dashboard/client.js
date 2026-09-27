export async function authedFetch(path,options={}) {
  const response=await fetch(path,{...options,credentials:'same-origin',headers:{...options.headers,'X-Nocheh-CSRF':window.__NOCHEH_CSRF__}});
  return response;
}
export async function fetchJSON(path,options={}) {
  const response=await authedFetch(path,options);
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'request_failed');
  return value;
}
