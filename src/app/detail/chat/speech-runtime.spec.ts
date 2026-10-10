import { describe, expect, it, vi } from 'vitest';
import { activatedMicrophone, meterGraph } from './speech-runtime';

describe('activatedMicrophone', () => {
  it('starts Web Audio after permission makes Firefox an active capture document', async () => {
    const order: string[] = [];
    const context = {
      state: 'running',
      resume: vi.fn(async () => {
        order.push('resume');
      }),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    const stream = {} as MediaStream;

    const opened = await activatedMicrophone(
      async () => {
        order.push('permission');
        return stream;
      },
      () => {
        order.push('context');
        return context;
      },
    );

    expect(order).toEqual(['permission', 'context', 'resume']);
    expect(opened).toEqual([context, stream]);
    expect(context.close).not.toHaveBeenCalled();
  });

  it('does not create Web Audio when microphone permission fails', async () => {
    const denied = new DOMException('denied', 'NotAllowedError');
    const createContext = vi.fn();

    await expect(
      activatedMicrophone(async () => {
        throw denied;
      }, createContext),
    ).rejects.toBe(denied);
    expect(createContext).not.toHaveBeenCalled();
  });

  it('closes the stream and reports a context Firefox kept suspended', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const context = {
      state: 'suspended',
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;

    await expect(
      activatedMicrophone(
        async () => stream,
        () => context,
      ),
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});

describe('meterGraph', () => {
  it('retains a silently consumed path from the microphone to the context destination', () => {
    const analyser = { connect: vi.fn() } as unknown as AnalyserNode;
    const source = { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
    const sink = {
      gain: { value: 1 },
      connect: vi.fn(),
    } as unknown as GainNode;
    const destination = {} as AudioDestinationNode;
    const stream = {} as MediaStream;
    const context = {
      destination,
      createMediaStreamSource: vi.fn(() => source),
      createGain: vi.fn(() => sink),
    } as unknown as AudioContext;

    expect(meterGraph(context, stream, analyser)).toEqual([source, sink]);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(sink);
    expect(sink.connect).toHaveBeenCalledWith(destination);
    expect(sink.gain.value).toBe(0);
  });
});
