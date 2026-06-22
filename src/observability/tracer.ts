import { TraceSpan, TraceLevel } from './types';



export class Tracer {
  private spans: Map<string, TraceSpan> = new Map();
  private activeSpans: Map<string, TraceSpan> = new Map();
  private level: TraceLevel;
  private maxSpans: number;
  private spanCounter = 0;

  constructor(level: TraceLevel = 'off', maxSpans = 100) {
    this.level = level;
    this.maxSpans = maxSpans;
  }

  setLevel(level: TraceLevel): void {
    this.level = level;
  }

  startSpan(name: string, tags: Record<string, string> = {}, parentId?: string): string {
    if (this.level === 'off') return '';

    this.spanCounter++;
    const id = span__;

    const span: TraceSpan = {
      id,
      name,
      startTime: Date.now(),
      tags,
      parentId,
    };

    this.activeSpans.set(id, span);

    if (this.activeSpans.size + this.spans.size > this.maxSpans) {
      this.evictOldest();
    }

    return id;
  }

  endSpan(spanId: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    this.activeSpans.delete(spanId);
    this.spans.set(spanId, span);
  }

  addTag(spanId: string, key: string, value: string): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags[key] = value;
    }
  }

  getSpan(spanId: string): TraceSpan | undefined {
    return this.activeSpans.get(spanId) ?? this.spans.get(spanId);
  }

  getAllSpans(): TraceSpan[] {
    return [...this.spans.values()];
  }

  getActiveSpans(): TraceSpan[] {
    return [...this.activeSpans.values()];
  }

  clear(): void {
    this.spans.clear();
    this.activeSpans.clear();
  }

  private evictOldest(): void {
    let oldest: string | undefined;
    let oldestTime = Infinity;
    for (const [id, span] of this.spans) {
      if (span.startTime < oldestTime) {
        oldestTime = span.startTime;
        oldest = id;
      }
    }
    if (oldest) this.spans.delete(oldest);
  }
}

export function traceMethod(level: TraceLevel = 'info') {
  return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const original = descriptor.value;
    descriptor.value = function (...args: any[]) {
      const tracer: Tracer | undefined = (this as any).__tracer;
      if (!tracer) return original.apply(this, args);

      const spanId = tracer.startSpan(propertyKey, {
        args: JSON.stringify(args).slice(0, 200),
      });

      try {
        const result = original.apply(this, args);
        if (result instanceof Promise) {
          return result.finally(() => tracer.endSpan(spanId));
        }
        tracer.endSpan(spanId);
        return result;
      } catch (error) {
        tracer.addTag(spanId, 'error', String(error));
        tracer.endSpan(spanId);
        throw error;
      }
    };
  };
}
