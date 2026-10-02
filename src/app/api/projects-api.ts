import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { QitsAppLinks } from '@qits/ui-components';
import { firstValueFrom } from 'rxjs';
import type {
  BranchDto,
  BranchesResponse,
  ProjectDto,
  ProjectEntriesResponse,
  RepositoryDto,
  RepositoryEntriesResponse,
  RepositoryResponse,
  WrapperDto,
} from './dto';

/** One project's repositories, and the wrapper they are members of. */
export interface ProjectComponents {
  readonly repositories: readonly RepositoryDto[];
  readonly wrapper: WrapperDto | null;
}

/**
 * The reads this app makes against qits-projects, and it makes them for one reason:
 * **qits-workspaces cannot list repositories.** Its workspace listing takes a mandatory
 * `repositoryId`, and it holds repository ids as opaque strings with no listing of its own — so the
 * only place a person can find out which repositories exist is the service that owns them.
 *
 * This service is duplicated in qits-spa-ci and qits-spa-cd rather than shared. It is roughly forty
 * lines, and the alternative — putting it in `@qits/ui-components` — would push a transport
 * dependency into seven SPAs that make no requests, and turn every change to it into a library
 * publish plus a version bump in eight applications.
 *
 * qits-projects answers on its own host, not this one: the edge routes an application's paths on
 * that application's host only. So every call here goes to `applications['qits-projects'].origin`
 * from the edge's `/main-navigation`, carries the session (`withCredentials` — the edge answers
 * credentialed CORS for any origin under the platform domain), and waits for the navigation to
 * answer rather than firing a relative path at this host first. Where the navigation names no
 * origin the path stays relative, same-origin — what an older edge still routes.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsApi {
  private readonly http = inject(HttpClient);
  private readonly links = inject(QitsAppLinks);

  /** `path` on qits-projects' own origin, once the navigation has said where that is. */
  private url(path: string): Promise<string> {
    return this.links.whenApiUrl('qits-projects', path);
  }

  /** Every project. One request, on page load. */
  async projects(): Promise<readonly ProjectDto[]> {
    const url = await this.url('/projects/api/projects');
    const response = await firstValueFrom(
      this.http.get<ProjectEntriesResponse>(url, { withCredentials: true }),
    );
    return response.entries.map((entry) => entry.project);
  }

  /**
   * One project's repositories **and** the wrapper they belong to, from one read.
   *
   * **There is no all-repositories endpoint**, so the overview fans this out — one request per
   * project, issued in parallel and rendered as each lands. That is not a shortcut waiting to be
   * replaced by a single call: repositories are listed under the project that owns them, and the
   * service offers no other way in.
   *
   * The wrapper rides along in the same answer, so the picker never has to guess which row is the
   * aggregate one. `wrapper` is null for a project that has none.
   */
  async components(projectId: string): Promise<ProjectComponents> {
    const url = await this.url(`/projects/api/projects/${encodeURIComponent(projectId)}/repositories`);
    const response = await firstValueFrom(
      this.http.get<RepositoryEntriesResponse>(url, { withCredentials: true }),
    );
    return {
      repositories: response.entries.map((entry) => entry.repository),
      wrapper: response.wrapper ?? null,
    };
  }

  /**
   * One repository, by id — and the detail view's reason for talking to qits-projects at all.
   *
   * It reads exactly one field in anger: `mainBranch`, which is what decides whether a workspace
   * offers **Integrate** or no door at all — work parented on the default branch goes home through a
   * release request in qits-projects, not from here. That reading has to come from the service that
   * owns repositories; every repository on this platform says "main" today and none of them promises
   * to, so assuming the string would put the wrong affordance on the page the day one does not.
   *
   * The detail route carries no project id, so the by-id read is not a shortcut past
   * {@link repositories} — it is the only way in from a deep link.
   */
  async repository(repositoryId: string): Promise<RepositoryDto> {
    const url = await this.url(`/projects/api/repositories/${encodeURIComponent(repositoryId)}`);
    const response = await firstValueFrom(
      this.http.get<RepositoryResponse>(url, { withCredentials: true }),
    );
    return response.repository;
  }

  /**
   * One repository's branches — the other half of the overview's tree.
   *
   * The workspace list says what is being worked on; this says what branches exist. A branch with no
   * workspace is the row that offers to make one, and it can only be found here, because
   * qits-workspaces knows nothing about refs it did not create.
   *
   * This read is cheap next to the workspace listing (it reads the mirror's refs and nothing else),
   * but it is still issued per repository and rendered on its own, so one slow repository never
   * holds up the rest of the page.
   */
  async branches(repositoryId: string): Promise<readonly BranchDto[]> {
    const url = await this.url(
      `/projects/api/repositories/${encodeURIComponent(repositoryId)}/branches`,
    );
    const response = await firstValueFrom(
      this.http.get<BranchesResponse>(url, { withCredentials: true }),
    );
    return response.branches ?? [];
  }
}
