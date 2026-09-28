import { describe, expect, it } from 'vitest'
import { rememberScope } from '../../src/core/remember-scope.js'

describe('rememberScope (#656)', () => {
  it('a call with a path remembers that exact path, however it is spelled', () => {
    const scope = rememberScope('qa-bot', 'read_file', { path: '/home/u/.ssh/id_rsa' })
    expect(scope.summary).toBe('qa-bot → read_file, only for "/home/u/.ssh/id_rsa"')
    expect(scope.conditions?.pathMatch).toEqual(['^/home/u/\\.ssh/id_rsa$'])
    const dotted = rememberScope('qa-bot', 'read_file', { file_path: 'a/../.env' })
    expect(dotted.conditions?.pathMatch).toEqual(['^a/\\.\\./\\.env$', '^\\.env$'])
  })

  it('a call with a command remembers that command', () => {
    const scope = rememberScope('qa-bot', 'shell_exec', { cmd: 'rm -rf /' })
    expect(scope.conditions).toEqual({ commandMatch: ['rm -rf /'] })
    expect(scope.summary).toBe('qa-bot → shell_exec, only for commands containing "rm -rf /"')
  })

  it('without a path or command it covers the tool, and says so', () => {
    const scope = rememberScope('qa-bot', 'list_agents', {})
    expect(scope.conditions).toBeUndefined()
    expect(scope.summary).toBe('every list_agents call from qa-bot')
  })
})
