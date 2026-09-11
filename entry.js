/**
 * Local knowledge base for DeepSeek Harness — plugin entry.
 *
 * The Cordis loader refuses plugin modules above a small size, so this file
 * stays tiny: it materializes the runtime files into ~/.dsh/knowledge and
 * evaluates them there. That keeps every source file editable and lets the
 * desktop widget read its own PowerShell script from a stable path.
 *
 * @module dsh-knowledge
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const name = 'knowledge'
export const inject = ['fs', 'shell', 'timer', 'tools', 'webServer']

/** Files copied next to the runtime state on every activation. */
const RUNTIME_FILES = ['engine.js', 'impl.js', 'desktop.ps1']

/**
 * Locate this package's own directory.
 * @returns the directory holding the runtime files.
 */
function packageDir() {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    // The loader may evaluate the module without import.meta; fall back to the
    // profile install locations pnpm materializes.
    const roots = [
      join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-knowledge'),
      join(homedir(), '.dsh', 'profiles', 'node_modules', 'dsh-knowledge'),
      join(homedir(), '.dsh', 'profiles', 'headless', 'node_modules', 'dsh-knowledge'),
    ]
    for (const root of roots) if (existsSync(root)) return root
    throw new Error('dsh-knowledge: cannot locate the installed package directory')
  }
}

/**
 * Mount the knowledge plugin: materialize the runtime files, then evaluate and
 * run the on-disk implementation against this row's context.
 * @param ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const from = packageDir()
  const home = join(homedir(), '.dsh', 'knowledge')
  mkdirSync(home, { recursive: true })
  for (const name of RUNTIME_FILES) {
    const source = join(from, name)
    const target = join(home, name)
    if (!existsSync(source)) continue
    if (!existsSync(target) || statSync(source).mtimeMs > statSync(target).mtimeMs) copyFileSync(source, target)
  }
  const createEngine = new Function('return (' + readFileSync(join(home, 'engine.js'), 'utf8') + ')')()
  const impl = new Function('return (' + readFileSync(join(home, 'impl.js'), 'utf8') + ')')()
  return impl(ctx, { fs: fs, os: os, path: path }, createEngine)
}
