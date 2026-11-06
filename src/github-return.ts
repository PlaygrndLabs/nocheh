/**
 * GitHub sends the browser back to /connect/github after it creates Nocheh's GitHub App and after the owner picks its
 * repositories (ADR-0210). The dashboard then opens on Settings › Connections, which finishes the sign-in. Only
 * GitHub's own values, each in its own shape, go along.
 */
const forwarded: Record<string, RegExp> = {
  code: /^[A-Za-z0-9_.-]{1,200}$/,
  state: /^[A-Za-z0-9_-]{1,200}$/,
  installation_id: /^[0-9]{1,20}$/,
  setup_action: /^(?:install|update|request)$/,
};

export function githubReturn(search: URLSearchParams): string {
  const back = new URLSearchParams({connect: 'github'});
  for (const [key, shape] of Object.entries(forwarded)) {
    const value = search.get(key);
    if (value !== null && shape.test(value)) back.set(key, value);
  }
  return '/?' + back.toString();
}
