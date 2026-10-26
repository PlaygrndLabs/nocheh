"""Pinned TUI changes: capture before interpretation, stable IDs, no external processes.

The managed gateway entry lives in services/hermes/browser_bridge.py (the TUI attaches over WebSocket)."""
from pathlib import Path
import sys
root = Path(sys.argv[1])

def patch(relative, replacements):
    path = root / relative; source = path.read_text()
    for old, new in replacements:
        if source.count(old) != 1: raise SystemExit('native TUI compatibility anchor changed: ' + relative)
        source = source.replace(old, new)
    path.write_text(source)

patch('ui-tui/src/gatewayClient.ts', [
    ('  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {', '''  private nochehInputs: Array<{text: string; event_id: string; session_id: unknown}> = []

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (method === 'nocheh.input') {
      const result = await this.nochehNativeRequest<{event_id: string}>(method, {
        ...params, id: params.id || globalThis.crypto.randomUUID(), submission: 'composer'
      })
      this.nochehInputs.push({text: String(params.text || ''), event_id: result.event_id, session_id: params.session_id})
      if (this.nochehInputs.length > 128) this.nochehInputs.shift()
      return result as T
    }
    if (method === 'prompt.submit') {
      let input = this.nochehInputs.find(item => item.session_id === params.session_id && item.text === String(params.text || ''))
      if (!input) {
        const result = await this.nochehNativeRequest<{event_id: string}>('nocheh.input', {
          session_id: params.session_id, text: params.text,
          id: globalThis.crypto.randomUUID(), submission: 'resubmission'
        })
        input = {text: String(params.text || ''), event_id: result.event_id, session_id: params.session_id}
        this.nochehInputs.push(input)
      }
      const result = await this.nochehNativeRequest<T>(method, {...params, nocheh_event_id: input.event_id}, timeoutMs)
      this.nochehInputs = this.nochehInputs.filter(item => item !== input)
      return result
    }
    return this.nochehNativeRequest<T>(method, params, timeoutMs)
  }

  private nochehNativeRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {'''),
])
patch('ui-tui/src/app/useSubmission.ts', [
    ('  const dispatchSubmission = useCallback(\n    (input: string | QueueItem) => {', '  const dispatchSubmission = useCallback(\n    async (input: string | QueueItem) => {'),
    ('      const toHistory = submission.text\n', '''      const toHistory = submission.text
      try {
        await gw.request('nocheh.input', {session_id: getUiState().sid, text: submission.text, display: full})
      } catch {
        sys('Input was not sent: archive capture is unavailable. Your text is still in the composer.')
        return
      }
'''),
    ('      if (shouldInterpolateSubmission(full)) {', '      if (false && shouldInterpolateSubmission(full)) {'),
])
patch('ui-tui/src/lib/externalCli.ts', [
    ('''export const launchHermesCommand = (args: string[]): Promise<LaunchResult> =>
  new Promise(resolve => {
    const child = spawn(resolveHermesBin(), args, { stdio: 'inherit' })

    child.on('error', err => resolve({ code: null, error: err.message }))
    child.on('exit', code => resolve({ code }))
  })''', '''export const launchHermesCommand = (_args: string[]): Promise<LaunchResult> =>
  Promise.resolve({code: 1, error: 'Nocheh manages model providers. Use Nocheh Settings and CLI.'})'''),
])
patch('ui-tui/src/lib/editor.ts', [
    ("    status = spawnSync(cmd!, [...args, file], { stdio: 'inherit' }).status", "    status = null // External editor processes require the managed tools boundary."),
])
patch('ui-tui/src/app/useComposerState.ts', [
    ("      exitCode = spawnSync(cmd!, [...args, file], { stdio: 'inherit' }).status", "      exitCode = null // Keep editing in the managed browser composer."),
])
