import { DiagnosticsManager } from '../../src/diagnostics/diagnosticsManager';

describe('DiagnosticsManager', () => {
  let diag: DiagnosticsManager;

  beforeEach(() => {
    diag = new DiagnosticsManager(true, 100);
  });

  it('records diagnostic events when enabled', () => {
    diag.record('rpc_call', { url: 'https://rpc.example.com' });
    diag.record('rpc_response', { status: 200 });

    expect(diag.getEventCount()).toBe(2);
  });

  it('does not record when disabled', () => {
    diag.setEnabled(false);
    diag.record('test', {});
    expect(diag.getEventCount()).toBe(0);
  });

  it('generates a report with summary', () => {
    diag.record('error_connect', { msg: 'timeout' });
    diag.record('error_auth', { msg: 'unauthorized' });
    diag.record('warn_retry', { attempt: 1 });
    diag.record('info_start', {});

    const report = diag.generateReport();
    expect(report.summary.totalEvents).toBe(4);
    expect(report.summary.errors).toBe(2);
    expect(report.summary.warnings).toBe(1);
    expect(report.summary.byType['error_connect']).toBe(1);
  });

  it('filters events by type', () => {
    diag.record('error', {});
    diag.record('info', {});
    diag.record('error', {});

    const errors = diag.getEvents({ type: 'error' });
    expect(errors).toHaveLength(2);
  });

  it('filters events by timestamp', () => {
    diag.record('old', {});
    const now = Date.now();
    diag.record('new', {});

    const recent = diag.getEvents({ since: now });
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe('new');
  });

  it('emits events to listeners', () => {
    const received: any[] = [];
    diag.onDiagnosticEvent((e) => received.push(e));
    diag.record('test', { value: 42 });

    expect(received).toHaveLength(1);
    expect(received[0].data.value).toBe(42);
  });

  it('unsubscribes listeners', () => {
    const received: any[] = [];
    const unsub = diag.onDiagnosticEvent((e) => received.push(e));
    unsub();
    diag.record('test', {});
    expect(received).toHaveLength(0);
  });

  it('clears all events', () => {
    diag.record('a', {});
    diag.record('b', {});
    diag.clear();
    expect(diag.getEventCount()).toBe(0);
  });
});
