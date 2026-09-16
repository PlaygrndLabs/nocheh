<adr>

# ADR-0050: Dashboard components and workflow metrics

<decision>
The owner accepted a whole-dashboard refactor with shadcn/ui, Recharts, adaptive
light/dark themes, and historical workflow charts. Nocheh retains React, esbuild,
npm, its existing owner API, and independent native Hermes/CPA pages.

Use locally owned Radix-based components, Tailwind compilation, semantic theme
and status tokens, shared request subscriptions, and lazy ESM bundles. The asset
server accepts bounded generated chunk filenames. Browser TypeScript checks are
separate from service checks. Page refresh invalidates subscribed data rather
than remounting the page.

Historical metrics aggregate existing workflow registry records. They describe
admissions and the current confirmed outcomes by registry confirmation time;
they are not a transition log. Duration includes queueing and retries. Late
reconciliation can move an outcome to its confirmed time. No new collector,
provider request logging, or runtime execution authority is introduced.
</decision>

<verification>
The synthetic Compose preview owns a separate database, network, image and port,
with no poller, provider login, scheduler or external-effect executor. Production
owner-authentication and proxy tests remain separate from synthetic visual checks.
Acceptance and integration evidence are recorded in TASK.md.
</verification>

</adr>
