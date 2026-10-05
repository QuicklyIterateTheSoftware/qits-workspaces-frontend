import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  CreateRunnerRequest,
  PatchRunnerRequest,
  RunnerRegistrationDto,
  WorkspaceRunnerDto,
} from './dto';

/** Where every runner door lives. */
export const RUNNERS_PATH = '/workspaces/api/runners';

/**
 * The calls this app makes against qits-workspaces' runner registry.
 *
 * Reads answer anyone who can read workspaces. Create, PATCH, token rotation and delete take
 * `qits:admin` (or `qits:system`); greenlight, health check and login check take `qits:admin`
 * alone. The page hides what it knows the viewer cannot press, but the service is the gate: every
 * method rejects with the `HttpErrorResponse`, and a 403 is the caller's to read.
 *
 * Unlike the workspace list, the runner list is a bare array rather than an `entries` envelope —
 * copied as the service answers it.
 */
@Injectable({ providedIn: 'root' })
export class RunnersApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  async runners(): Promise<readonly WorkspaceRunnerDto[]> {
    return firstValueFrom(this.http.get<WorkspaceRunnerDto[]>(`${this.base}${RUNNERS_PATH}`));
  }

  /** Register a runner. The answer's token and install line are shown once and never again. */
  async createRunner(request: CreateRunnerRequest): Promise<RunnerRegistrationDto> {
    return firstValueFrom(
      this.http.post<RunnerRegistrationDto>(`${this.base}${RUNNERS_PATH}`, request),
    );
  }

  /** A fresh single-use registration token and install line; the previous token stops working. */
  async rotateToken(id: string): Promise<RunnerRegistrationDto> {
    return firstValueFrom(
      this.http.post<RunnerRegistrationDto>(`${this.runner(id)}/registration-token`, {}),
    );
  }

  async patchRunner(id: string, request: PatchRunnerRequest): Promise<WorkspaceRunnerDto> {
    return firstValueFrom(this.http.patch<WorkspaceRunnerDto>(this.runner(id), request));
  }

  /**
   * Delete a runner. Refused with a 409 `RUNNER_OWNS_WORKSPACES`, carrying the owning workspaces'
   * row ids in `workspaceIds`, while any ACTIVE workspace is placed on it — a workspace is sticky to
   * its runner, so the runner cannot go before they do.
   */
  async deleteRunner(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.runner(id)));
  }

  /** Lift a quarantine by hand, without waiting for a health check to pass. */
  async greenlight(id: string): Promise<WorkspaceRunnerDto> {
    return firstValueFrom(this.http.post<WorkspaceRunnerDto>(`${this.runner(id)}/greenlight`, {}));
  }

  /** Ask the runner to run its health check now. 409 `RUNNER_UNAVAILABLE` when it is not connected. */
  async healthCheck(id: string): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${this.runner(id)}/healthcheck`, {}));
  }

  /** Ask the runner to probe its node's agent logins again. 409 `RUNNER_UNAVAILABLE` when offline. */
  async loginCheck(id: string): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${this.runner(id)}/login-check`, {}));
  }

  private runner(id: string): string {
    return `${this.base}${RUNNERS_PATH}/${encodeURIComponent(id)}`;
  }
}
