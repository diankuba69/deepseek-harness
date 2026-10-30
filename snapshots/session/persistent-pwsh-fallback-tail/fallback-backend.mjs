/** Frame terminal sintetis untuk hasil fallback melalui tool dan log Session produksi. */
class SnapshotSession {
  motd = ''
  statusValue = { kind: 'running' }
  queue = []

  startSend(request) {
    if (request.text.startsWith('stty -echo')) return this.operation('', 'stdin_read')
    if (request.submit) {
      const start = /__DSH_PERSISTENT_PWSH_START_[a-f0-9-]+__/.exec(request.text)?.[0]
      const end = /__DSH_PERSISTENT_PWSH_END_[a-f0-9-]+:/.exec(request.text)?.[0]
      if (!start || !end) throw new Error('fallback snapshot requires actual command markers')
      this.queue = request.text.includes('FALLBACK_ONE')
        ? [start.slice(0, 20), start.slice(20) + '\n' + 'older '.repeat(100), 'FINAL-TAIL']
        : [start + '\nhello\n' + end.slice(0, 20), end.slice(20), '0\n' + 'trailer '.repeat(100)]
    }
    const delta = this.queue.shift() ?? ''
    return this.operation(delta, this.queue.length === 0 ? 'stdin_read' : 'inferred_idle')
  }

  operation(delta, waitReason) {
    return {
      done: Promise.resolve({ viewport: '', waitReason, sessionStatus: this.statusValue, truncated: false }),
      readOutput: () => ({ delta, truncated: false }),
      cancel: () => false,
    }
  }

  read() {
    return { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }
  }

  signal() {
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status() {
    return this.statusValue
  }

  close() {
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
    return Promise.resolve()
  }
}

/** Identitas fixture lokal skenario. */
export const name = 'pwsh-fallback-snapshot'
/** Layanan terminal memiliki registrasi backend dan sesi. */
export const inject = ['terminals']

/** Mendaftarkan frame deterministik. @param ctx - Konteks plugin pemilik efek. */
export function apply(ctx) {
  ctx.terminals.registerBackend({ type: 'shell', spawn: () => Promise.resolve(new SnapshotSession()) })
}
