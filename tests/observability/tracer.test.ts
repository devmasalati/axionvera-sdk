import { Tracer } from '../../src/observability/tracer';

describe('Tracer', () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer('debug', 50);
  });

  it('starts and ends a span', () => {
    const id = tracer.startSpan('test_op');
    expect(id).toBeTruthy();
    expect(tracer.getActiveSpans()).toHaveLength(1);

    tracer.endSpan(id);
    expect(tracer.getActiveSpans()).toHaveLength(0);
    expect(tracer.getAllSpans()).toHaveLength(1);
  });

  it('records span duration', () => {
    const id = tracer.startSpan('timed_op');
    tracer.endSpan(id);

    const span = tracer.getSpan(id);
    expect(span?.duration).toBeGreaterThanOrEqual(0);
  });

  it('adds tags to span', () => {
    const id = tracer.startSpan('tagged_op');
    tracer.addTag(id, 'key', 'value');
    tracer.addTag(id, 'status', 'ok');
    tracer.endSpan(id);

    const span = tracer.getSpan(id);
    expect(span?.tags.key).toBe('value');
    expect(span?.tags.status).toBe('ok');
  });

  it('returns undefined for unknown span', () => {
    expect(tracer.getSpan('nonexistent')).toBeUndefined();
  });

  it('does not create spans when level is off', () => {
    tracer.setLevel('off');
    const id = tracer.startSpan('off_op');
    expect(id).toBe('');
    expect(tracer.getActiveSpans()).toHaveLength(0);
  });

  it('evicts oldest spans when over capacity', () => {
    const smallTracer = new Tracer('debug', 3);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = smallTracer.startSpan(op_);
      smallTracer.endSpan(id);
      ids.push(id);
    }
    expect(smallTracer.getAllSpans()).toHaveLength(3);
  });

  it('clears all spans', () => {
    tracer.startSpan('op1');
    tracer.startSpan('op2');
    tracer.clear();
    expect(tracer.getActiveSpans()).toHaveLength(0);
    expect(tracer.getAllSpans()).toHaveLength(0);
  });
});
