/**
 * Build-time stand-in for `@sentry/browser` and `@sentry/integrations`
 * (see vite.config.ts). Atlaskit's editor-common reports renderer errors to
 * Atlassian's own Sentry project from the browser; this app never sends
 * anything to a third party, so the reporter gets inert classes instead.
 */
export class BrowserClient { close() { return Promise.resolve(true); } }
export const defaultIntegrations: unknown[] = [];
export const getCurrentHub = () => ({ bindClient() {}, withScope() {}, captureException() {} });
export const Integrations = { Breadcrumbs: class {} };
export class ExtraErrorData {}
export const init = () => {};
export const captureException = () => {};
export default {};
