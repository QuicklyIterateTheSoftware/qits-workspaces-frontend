import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { QitsAppLinks } from '@qits/ui-components';
import { firstValueFrom } from 'rxjs';

/**
 * qits-stt: one route, one field in, one field out.
 *
 * `POST /stt/api/transcriptions` takes `{audioBase64}` and answers `{text}`. qits-stt has its own
 * host (`stt.<domain>`) and the edge no longer routes its paths on this one, so the call goes to
 * `applications['qits-stt'].origin` from the edge's `/main-navigation`, waits for the navigation to
 * answer, and carries the session itself (`withCredentials` — the edge answers credentialed CORS for
 * any origin under the platform domain). Where the navigation names no origin the path stays
 * relative, same-origin — what an older edge still routes.
 *
 * **The bytes must be a WAV.** The service decodes the base64, writes it to a `.wav` file and hands
 * the path to a resident python worker; any common PCM rate is fine because the model resamples, but
 * the container is not a transcoder. Encoding is the browser's job — see `chat/recorder.ts`.
 *
 * It is a *host-side* service on purpose, which is why it is not behind the container proxy: the
 * model is loaded once and stays loaded, and transcription is not workspace-scoped — nothing here
 * takes a workspace or a repository.
 */
@Injectable({ providedIn: 'root' })
export class SpeechApi {
  private readonly http = inject(HttpClient);
  private readonly links = inject(QitsAppLinks);

  /**
   * Transcribe one WAV clip.
   *
   * A blank `audioBase64` is a 400 — and note the envelope differs from the rest of the platform:
   * this one fails validation before the controller, so the body is Quarkus' `{title, status,
   * violations}` rather than the usual `{message}`. Nothing here reads it; the caller says its own
   * sentence about a failed clip, because "the transcription service is not answering" is more use
   * than a constraint name.
   */
  async transcribe(audioBase64: string): Promise<string> {
    const url = await this.links.whenApiUrl('qits-stt', '/stt/api/transcriptions');
    const answer = await firstValueFrom(
      this.http.post<{ text?: string }>(url, { audioBase64 }, { withCredentials: true }),
    );
    return answer.text ?? '';
  }
}
