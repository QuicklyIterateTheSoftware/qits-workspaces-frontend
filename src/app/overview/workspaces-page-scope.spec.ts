import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { signal, type EnvironmentProviders, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  QITS_SCOPE,
  provideQitsRepositoryList,
  provideQitsScope,
  type QitsScope,
  type QitsScopeSource,
} from '@qits/ui-components';
import type { ProjectDto, RepositoryDto } from '../api/dto';
import { routes } from '../app.routes';
import { WorkspacesPage } from './workspaces-page';

/**
 * What a scoped address does to the front door.
 *
 * The page's whole job is "whose workspaces are these", and the address answers it: a repository in
 * the URL is that repository's workspaces, a project alone is that project's wrapper — the row an
 * aggregate workspace actually branches. Either way the picker is not drawn, because a control that
 * can contradict the URL is a second source of truth.
 *
 * The scope is a literal here rather than a navigation. Which URLs carry which scope is
 * `app.routes.spec.ts`' question; this file is about what the page does once it has one, including
 * the project-only scope that arrives when the picker in the chrome sends a reader to `/<slug>/`.
 */
describe('WorkspacesPage in scope', () => {
  let http: HttpTestingController;

  const PROJECT: ProjectDto = {
    id: 'p1',
    name: 'qits',
    slug: 'qits',
    description: null,
    dns: null,
  };

  const repository = (id: string): RepositoryDto => ({
    id,
    name: id,
    backupUrl: `https://example.invalid/${id}.git`,
    mainBranch: 'main',
    archetype: 'SERVICE',
    projectId: 'p1',
  });

  /** A scope stated outright, the way the URL would have stated it. */
  const scopeSource = (scope: QitsScope, repositoryId?: string): Provider => {
    const source: QitsScopeSource = {
      scope: signal(scope),
      projectId: signal(scope.project ? 'p1' : undefined),
      repositoryId: signal(repositoryId),
      routing: 'repository',
      select: () => undefined,
    };
    return { provide: QITS_SCOPE, useValue: source };
  };

  function configure(scope: Provider | EnvironmentProviders): void {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        // The wrapper the chrome names for the scoped project: what a project-only scope lists.
        provideQitsRepositoryList(
          [{ id: 'qits-ci', name: 'qits-ci', category: 'services' }],
          'qits-qits',
        ),
        scope,
      ],
    });
    http = TestBed.inject(HttpTestingController);
  }

  const settle = async (component: ComponentFixture<WorkspacesPage>): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await component.whenStable();
    component.detectChanges();
  };

  /** Mount the page and answer the two listings it reads to know the repository rows. */
  const open = async (): Promise<ComponentFixture<WorkspacesPage>> => {
    const component = TestBed.createComponent(WorkspacesPage);
    await settle(component);
    http.expectOne('/projects/api/projects').flush({ entries: [{ project: PROJECT }] });
    await settle(component);
    http.expectOne('/projects/api/projects/p1/repositories').flush({
      entries: [repository('qits-qits'), repository('qits-ci')].map((row) => ({ repository: row })),
      wrapper: { repositoryId: 'qits-qits', branch: 'main', entries: [] },
    });
    await settle(component);
    return component;
  };

  function html(component: ComponentFixture<WorkspacesPage>): HTMLElement {
    return component.nativeElement as HTMLElement;
  }

  it('lists the scoped repository and draws no picker', async () => {
    configure(
      scopeSource({ project: 'qits', category: 'services', repository: 'qits-ci' }, 'qits-ci'),
    );
    const component = await open();

    http.expectOne('/workspaces/api/workspaces?repositoryId=qits-ci').flush({ entries: [] });
    await settle(component);

    expect(html(component).querySelector('select[name="project"]')).toBeNull();
    expect(html(component).textContent).toContain('qits · qits-ci');
    http.verify();
  });

  it("lists the scoped project's wrapper when the address names no repository", async () => {
    configure(scopeSource({ project: 'qits' }));
    const component = await open();

    http.expectOne('/workspaces/api/workspaces?repositoryId=qits-qits').flush({ entries: [] });
    await settle(component);

    expect(html(component).querySelector('select[name="project"]')).toBeNull();
    http.verify();
  });

  it('keeps the picker when nothing is scoped', async () => {
    configure(provideQitsScope('repository'));
    const component = await open();

    // Unscoped, the page falls back to its own first admitted wrapper.
    http.expectOne('/workspaces/api/workspaces?repositoryId=qits-qits').flush({ entries: [] });
    await settle(component);

    expect(html(component).querySelector('select[name="project"]')).not.toBeNull();
    http.verify();
  });
});
