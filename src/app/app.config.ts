import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import {
  provideQitsBuilds,
  provideQitsNavigation,
  provideQitsProjects,
  provideQitsScope,
} from '@qits/ui-components';

import { routes } from './app.routes';

/**
 * Seven providers, in the order spa-home documents, and the third arrived with this application's
 * first page: this client makes requests.
 *
 * - `provideBrowserGlobalErrorListeners` funnels genuinely-global errors and unhandled rejections
 *   into Angular's `ErrorHandler`.
 * - `provideRouter` carries the chosen repository in the query parameters, which is what makes one
 *   repository's workspaces bookmarkable.
 * - `withFetch` is not a preference. The default XHR backend is invisible to OTLP fetch
 *   instrumentation, so choosing it would quietly forfeit client spans the moment this deployment
 *   grows a telemetry relay. Every call this app makes is a same-origin path behind the gateway,
 *   which is what lets the browser's session cookie reach `/projects/api/…` with no machine token
 *   and no CORS: every service's segment is path-routed on every host, so an API path is
 *   same-origin wherever the page came from.
 * - `provideQitsNavigation` fills the shared layout's sidebar. It issues one `GET /main-navigation`
 *   at startup and hands the answer to `QitsMainLayout`: the platform's navigation tree is the
 *   edge's answer now, derived from the deployments it actually serves, rather than a list compiled
 *   into `@qits/ui-components` that lagged every new application. It rides on the
 *   `provideHttpClient` above.
 * - `provideQitsProjects` puts the project picker in the chrome's top-left slot, where the wordmark
 *   was, from one `GET /projects/api/projects`. Every resource on this platform belongs to a
 *   project, so which one is open is the outermost fact about a page rather than a filter inside
 *   one of them — above the links, because it scopes them. It also loads the scoped project's
 *   repositories, which is what the sidebar draws its groups from.
 * - `provideQitsScope('repository')` says how deep this application's own addresses go: a workspace
 *   belongs to one repository, so it serves `/<slug>/<group>/<repo>/…` beside its own bare paths
 *   and the picker navigates here rather than leaving for qits-projects.
 * - `provideQitsBuilds` puts the pending-builds bolt beside that picker: a popover of what qits-ci
 *   is building right now, from `GET /ci/api/runs/active`. Same-origin like the two reads above and
 *   for the same reason — the edge routes `/ci` on every host — so it needs the `provideHttpClient`
 *   too and carries no origin of its own. Providing it is what puts the bolt there; a host where
 *   `/ci` is unreachable is a decision made here rather than a dead affordance in the chrome. It
 *   asks nothing at all while the panel is closed, and polls only for as long as one is open.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideQitsNavigation(),
    provideQitsProjects(),
    provideQitsScope('repository'),
    provideQitsBuilds(),
  ],
};
