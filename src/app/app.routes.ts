import type { CanMatchFn, Routes } from '@angular/router';
import { QITS_CATEGORIES, QitsMainLayout, type QitsCategory } from '@qits/ui-components';
import { WorkspaceDetailPage } from './detail/workspace-detail-page';
import { EditorPage } from './editor/editor-page';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './overview/workspaces-page';

/**
 * The three pages this application owns.
 *
 * **The root view is intentionally small.** It lists the active workspaces of whatever repository
 * is in scope and offers the create flow. Unscoped it falls back to a picker, one wrapper per
 * project — the row qits-projects names as the wrapper — and `?repository=<id>` preselects one.
 *
 * **The detail route names a repository and then a workspace**, and the repository segment is not
 * decoration: qits-workspaces' listing takes a mandatory `repositoryId` and answers 404 without one,
 * so a detail page that could not name its repository could not read its own header. The workspace
 * id is the generated one every route addresses, never the branch-derived label — the label is
 * unique only among active workspaces in one repository and is reusable once one resolves.
 *
 * **`editor` names nothing but itself**, which is why it is a bare literal beside the other two
 * rather than a segment under a repository. There is one editor for the whole platform — a single
 * container holding every project's wrapper side by side — so the page needs no scope to have a
 * subject, and `/editor` is the plain address of it. A project in front, `/qits/editor`, is a
 * convenience and not a second subject: it opens the same editor at that project's folder, and a
 * repository segment on top of that would be a third answer to a question the project already
 * settled. The literal joins the closed vocabulary of first segments below, so no project may be
 * called `editor`, exactly as none may be called `repositories`.
 *
 * **Which tab is open rides in `?tab=`, not in a trailing segment.** A trailing segment would make a
 * tab switch free (Angular reuses a component across a parameter change) and would make a *workspace*
 * switch free too — which is the bug, not the feature. Keeping the tab in the query string leaves the
 * path meaning "which workspace", makes a bare URL mean "no tab pinned" by simple absence, and keeps
 * every tab a shareable link.
 */
const own: Routes = [
  { path: '', component: WorkspacesPage },
  { path: 'editor', component: EditorPage },
  {
    path: 'repositories/:repositoryId/workspaces/:workspaceId',
    component: WorkspaceDetailPage,
  },
];

/** The first segments this application's own routes spell, which no project and no group can be. */
const OWN_SEGMENTS: ReadonlySet<string> = new Set(
  own.map((route) => (route.path ?? '').split('/')[0]).filter((segment) => segment.length > 0),
);

/**
 * Is `<project>/<group>/<repository>` a repository address, or this application's own three
 * segments?
 *
 * The middle segment is the repository's **group** — its component where the platform gives it one,
 * its archetype category where it does not. Components are an **open** set that only the platform
 * knows, so the guard cannot test the segment against a list: a reader landing on a deep link has
 * no repository list yet, and a guard that waited for one would 404 the address it was asked about.
 * The closed vocabulary left is this application's own, so that is what decides —
 * `/qits/repositories/r1/workspaces/12` is this app's page under a project, and three segments that
 * spell none of ours are a repository address.
 *
 * A first segment of ours is never a project either, and neither is a category: that is the same
 * rule `parseScope` applies, so `/services` stays this app's own page. The chrome settles an
 * unknown group as the project alone once the repository list answers, rather than as a 404.
 *
 * `segments` are the ones left at this level, so the group is `segments[1]` — the parent route is
 * the layout's `''` and consumes nothing.
 */
export const isRepositoryAddress: CanMatchFn = (_route, segments) => {
  const project = segments[0]?.path;
  const group = segments[1]?.path;
  if (!project || !group) return false;
  if (OWN_SEGMENTS.has(project) || QITS_CATEGORIES.includes(project as QitsCategory)) return false;
  return !OWN_SEGMENTS.has(group);
};

/**
 * Every route inside the platform chrome, three times: bare, under a project, under a repository.
 *
 * `QitsMainLayout` is a route component rather than something wrapped around the shell so that it
 * is entered once and then kept: every page this app grows lands in `children`, beneath the
 * layout's own outlet, and moving between them never rebuilds the sidebar.
 *
 * **The same components serve all three forms.** `/qits/qits-ci/qits-ci-service/` is the workspaces
 * of one repository, `/qits/` is the picker over that project's wrappers and `/` is the picker over
 * every project; the pages read that from `QITS_SCOPE` rather than from route parameters, which is
 * why the scoped branches declare no readers of `:project`, `:group` or `:repository`.
 *
 * **The project form is what the chrome's project picker navigates to.** `UrlScope.select(slug)`
 * goes to `/<slug>/`, so without this route picking a project here would land on the 404 page.
 *
 * **Order is the whole grammar**, and it works because the three vocabularies cannot collide: a
 * group is never a slug, and neither is ever one of this app's own first segments. Own routes
 * first, so `repositories/…` stays this application's literal rather than a project called
 * `repositories`; the repository form next, guarded on the group; the project form last, which
 * takes what is left.
 *
 * The `**` route sits *inside* the layout: this application is served at the root of its own host,
 * so an unknown URL under it is an ordinary 404 and is drawn with the chrome around it.
 */
export const routes: Routes = [
  {
    path: '',
    component: QitsMainLayout,
    children: [
      ...own,
      { path: ':project/:group/:repository', canMatch: [isRepositoryAddress], children: own },
      { path: ':project', children: own },
      { path: '**', component: NotFound },
    ],
  },
];
