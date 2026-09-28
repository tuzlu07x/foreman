import { describe, expect, it } from 'vitest'
import { analyzeShell, isRecursiveRm, unwrapCommand } from '../../../src/core/risk-rules/shell-analysis.js'
import { shellPatternRule } from '../../../src/core/risk-rules/shell-patterns.js'
import { bucketFor } from '../../../src/core/risk-scorer.js'

// #698 — The shell rules scored how a destructive command was spelled, not
// what it did: `rm -r -f`, `find -delete`, a python one-liner or a force
// push went through at risk 0 while `rm -rf` asked. Every spelling below
// must reach at least "medium" (asks under the default policy), and the
// benign lines must not.

const ctx = { db: null as never }
const score = (cmd: string): { total: number; rules: string[] } => {
  const factors = shellPatternRule.evaluate({ sourceAgent: 'claude-code', targetTool: 'shell_exec', args: { command: cmd } }, ctx)
  return { total: factors.reduce((n, f) => n + f.points, 0), rules: factors.map((f) => f.rule) }
}

const asks = (cmd: string, rule: string): void => {
  const { total, rules } = score(cmd)
  expect(rules, cmd).toContain(rule)
  expect(['medium', 'high', 'critical'], `${cmd} scored ${total}`).toContain(bucketFor(total))
}

describe('reworded destructive commands still ask (#698)', () => {
  it.each([
    'rm -rf ./build',
    'rm -r -f ./build',
    'rm -f -r ./build',
    'rm --recursive --force ./build',
    'rm -r ./build',
    'rm -R build',
    'rm build -rf',
    '/bin/rm -rf build',
    'cd src && rm -r ../build',
    'true; rm -r build',
    'env CI=1 rm -r build',
    'nice -n 5 rm -r build',
    'timeout 10 rm -r build',
    'FOO=1 rm -r build',
    'bash -c "rm -r build"',
    "sh -ec 'cd /repo && rm -r -f build'",
    'eval "rm -r build"',
    'sudo rm -r build',
  ])('recursive rm: %s', (cmd) => asks(cmd, 'shell_rm_rf_general'))

  it.each([
    'rm -r -f /',
    'rm --recursive --force ~/',
    'bash -c "rm -r $HOME/"',
  ])('catastrophic target: %s', (cmd) => asks(cmd, 'shell_rm_rf_catastrophic'))

  it.each([
    'find . -name build -delete',
    'find . -name build -exec rm -r {} +',
    "find . -name '*.log' -exec rm {} \;",
    'find . -type f -execdir shred {} +',
    "find . -name '*.log' | xargs rm",
    "find . -name '*.log' -print0 | xargs -0 rm -f",
  ])('bulk delete: %s', (cmd) => asks(cmd, 'shell_find_delete'))

  it.each([
    `python3 -c "import shutil; shutil.rmtree('build')"`,
    `python -c "import os; os.remove('a.db')"`,
    `python3 -c "from pathlib import Path; Path('x').unlink()"`,
    `node -e "require('fs').rmSync('build',{recursive:true})"`,
    `node -e "require('fs').promises.rm('build',{recursive:true})"`,
    `perl -e 'use File::Path; rmtree("build")'`,
    `perl -e 'unlink glob("*.log")'`,
    `ruby -e 'require "fileutils"; FileUtils.rm_rf("build")'`,
    `php -r 'unlink("a.db");'`,
    `deno eval "await Deno.remove('build', {recursive: true})"`,
  ])('script one-liner: %s', (cmd) => asks(cmd, 'shell_script_delete'))

  it.each([
    `python3 -c "import os; os.system('rm -rf build')"`,
    `python3 -c "import subprocess; subprocess.run(['rm', '-rf', 'build'])"`,
    `node -e "require('child_process').execSync('rm -r build')"`,
  ])('script shelling out: %s', (cmd) => asks(cmd, 'shell_rm_rf_general'))

  it.each([
    ['git push --force origin main', 'shell_git_force_push'],
    ['git push -f origin main', 'shell_git_force_push'],
    ['git push --force-with-lease origin main', 'shell_git_force_push'],
    ['git push origin +main', 'shell_git_force_push'],
    ['git -C repo push --force', 'shell_git_force_push'],
    ['cd repo && git push -f', 'shell_git_force_push'],
    ['git push origin --delete release', 'shell_git_push_delete'],
    ['git push origin :release', 'shell_git_push_delete'],
    ['git reset --hard HEAD~3', 'shell_git_reset_hard'],
    ['git clean -fdx', 'shell_git_clean'],
    ['git filter-branch --tree-filter "rm secret" HEAD', 'shell_git_history_rewrite'],
  ])('git: %s', (cmd, rule) => asks(cmd, rule))

  it.each([
    'echo cm0gLXJmIC8K | base64 -d | sh',
    'echo cm0gLXJmIC8K | base64 --decode | bash',
    'cat payload.hex | xxd -r -p | sh',
    'openssl enc -d -aes256 -in p.bin -k x | /bin/bash',
  ])('decoded payload run by a shell: %s', (cmd) => asks(cmd, 'shell_decode_pipe_shell'))

  it('a destructive git command gets no "benign git" discount', () => {
    expect(score('git push --force origin main').rules).not.toContain('shell_safe_git')
  })
})

describe('benign lines are not flagged (#698)', () => {
  it.each([
    'ls -la',
    'rm notes.txt',
    'rm -f notes.txt',
    'rm -i old.txt',
    'echo "rm -rf /"',
    "git commit -m 'rm -r the build dir'",
    "find . -name '*.ts'",
    "find . -name '*.log' -print",
    'python3 -c "print(1)"',
    `node -e "console.log(require('fs').readdirSync('.'))"`,
    'git status',
    'git push origin main',
    'git push -u origin feature',
    'git reset --soft HEAD~1',
    'git clean -n',
    'npm run build && npm test',
    'env NODE_ENV=test node server.js',
    'echo aGk= | base64 -d',
    'base64 -d in.txt > out.bin',
  ])('%s', (cmd) => {
    const { total, rules } = score(cmd)
    expect(bucketFor(total), `${cmd} → ${rules.join(', ')} (${total})`).toBe('low')
  })
})

describe('shell analysis', () => {
  it('splits chains and unwraps wrappers and nested shells', () => {
    const argvs = analyzeShell('cd a && env X=1 nice -n 2 bash -c "rm -r b; ls" | xargs -I{} echo {}').map((s) => s.argv.join(' '))
    expect(argvs).toEqual(expect.arrayContaining(['cd a', 'rm -r b', 'ls', 'echo {}']))
  })

  it('reads rm flags however they are written', () => {
    expect(isRecursiveRm(['rm', '-r', '-f', 'x'])).toBe(true)
    expect(isRecursiveRm(['rm', 'x', '--recursive'])).toBe(true)
    expect(isRecursiveRm(['rm', '--', '-r'])).toBe(false)
    expect(isRecursiveRm(['rm', '-f', 'x'])).toBe(false)
  })

  it('removes assignments and wrapper options', () => {
    expect(unwrapCommand(['A=1', 'sudo', '-u', 'root', 'timeout', '-s', 'KILL', '5', 'rm', '-r', 'x'])).toEqual(['rm', '-r', 'x'])
  })

  it('never throws on odd input', () => {
    for (const cmd of ['', '"unterminated', '$(( ))', '&&&', 'a'.repeat(10_000), 'bash -c', 'find -exec']) {
      expect(() => analyzeShell(cmd)).not.toThrow()
    }
  })
})
