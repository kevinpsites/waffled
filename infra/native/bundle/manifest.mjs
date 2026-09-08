#!/usr/bin/env node
// manifest.json for the runtime bundle — written by build.sh, checked by build.sh verify,
// and (Phase 2) by waffled-runtime before it starts anything.
//
//   node manifest.mjs write  <runtime dir>   # metadata JSON on stdin → <dir>/manifest.json
//   node manifest.mjs verify <runtime dir>   # exit 1 on any missing/extra/changed file
//
// Shape (schema 1):
//   { schema, name, arch, platform, builtAt, gitSha, gitDirty, waffledVersion,
//     components: { node|postgres|caddy|api|powersync|web|config: { version, path, ... } },
//     fileCount, symlinkCount, totalBytes,
//     files:    { "<relative path>": { sha256, size, mode } },   // regular files only; mode = "755"/"644"
//     symlinks: { "<relative path>": "<link target, as stored>" } }
// Paths are POSIX-relative to the runtime dir and sorted. manifest.json itself is not listed.
// Symlinks are recorded as links (target string), never followed — pnpm's node_modules
// and Postgres' lib/ depend on them, and the runtime must preserve them when it copies
// or verifies the tree.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SCHEMA = 1
const MANIFEST = 'manifest.json'

async function walk(root) {
  const files = {}
  const symlinks = {}
  const pending = []
  async function visit(rel) {
    const abs = path.join(root, rel)
    const entries = await readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (childRel === MANIFEST) continue
      if (e.isSymbolicLink()) {
        symlinks[childRel] = await readlink(path.join(root, childRel))
      } else if (e.isDirectory()) {
        await visit(childRel)
      } else if (e.isFile()) {
        pending.push(childRel)
      } else {
        throw new Error(`unsupported entry (not a file/dir/symlink): ${childRel}`)
      }
    }
  }
  await visit('')
  // Hash with bounded concurrency.
  let i = 0
  const workers = Array.from({ length: 32 }, async () => {
    while (i < pending.length) {
      const rel = pending[i++]
      const abs = path.join(root, rel)
      const st = await lstat(abs)
      files[rel] = { sha256: await sha256(abs), size: st.size, mode: (st.mode & 0o777).toString(8) }
    }
  })
  await Promise.all(workers)
  return { files: sortKeys(files), symlinks: sortKeys(symlinks) }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function write(root) {
  const meta = JSON.parse(await readStdin())
  const { files, symlinks } = await walk(root)
  const manifest = {
    schema: SCHEMA,
    name: 'waffled-runtime',
    arch: meta.arch,
    platform: meta.platform,
    builtAt: new Date().toISOString(),
    gitSha: meta.gitSha,
    gitDirty: meta.gitDirty,
    waffledVersion: meta.waffledVersion,
    components: meta.components,
    fileCount: Object.keys(files).length,
    symlinkCount: Object.keys(symlinks).length,
    totalBytes: Object.values(files).reduce((n, f) => n + f.size, 0),
    files,
    symlinks,
  }
  await writeFile(path.join(root, MANIFEST), JSON.stringify(manifest, null, 1) + '\n')
  console.log(`  · ${manifest.fileCount} files, ${manifest.symlinkCount} symlinks, ${(manifest.totalBytes / 1e6).toFixed(0)} MB hashed`)
}

async function verify(root) {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'))
  const problems = []
  if (manifest.schema !== SCHEMA) problems.push(`schema ${manifest.schema} (this tool understands ${SCHEMA})`)
  if (manifest.arch !== process.arch) problems.push(`manifest arch ${manifest.arch} but this machine is ${process.arch}`)
  if (manifest.platform !== process.platform) problems.push(`manifest platform ${manifest.platform} but this machine is ${process.platform}`)
  const actual = await walk(root)
  for (const [rel, want] of Object.entries(manifest.files)) {
    const got = actual.files[rel]
    if (!got) { problems.push(`missing file: ${rel}`); continue }
    if (got.sha256 !== want.sha256) problems.push(`changed: ${rel}`)
    else if (got.size !== want.size) problems.push(`size differs: ${rel}`)
    // Only the owner-exec bit is load-bearing (a chmod-less copy keeps it; umask may alter the rest).
    else if ((parseInt(got.mode, 8) & 0o100) !== (parseInt(want.mode, 8) & 0o100)) problems.push(`exec bit differs: ${rel}`)
  }
  for (const rel of Object.keys(actual.files)) if (!manifest.files[rel]) problems.push(`extra file: ${rel}`)
  for (const [rel, target] of Object.entries(manifest.symlinks)) {
    if (!(rel in actual.symlinks)) problems.push(`missing symlink: ${rel}`)
    else if (actual.symlinks[rel] !== target) problems.push(`symlink target differs: ${rel} → ${actual.symlinks[rel]} (manifest: ${target})`)
  }
  for (const rel of Object.keys(actual.symlinks)) if (!(rel in manifest.symlinks)) problems.push(`extra symlink: ${rel}`)
  if (problems.length) {
    console.error(`✗ manifest: ${problems.length} problem(s)`)
    for (const p of problems.slice(0, 25)) console.error(`    ${p}`)
    if (problems.length > 25) console.error(`    … ${problems.length - 25} more`)
    process.exit(1)
  }
  const c = manifest.components
  console.log(`✓ manifest ok — ${manifest.fileCount} files + ${manifest.symlinkCount} symlinks, ${(manifest.totalBytes / 1e6).toFixed(0)} MB, ${manifest.arch}/${manifest.platform}, built ${manifest.builtAt} from ${String(manifest.gitSha).slice(0, 9)}${manifest.gitDirty ? ' (dirty)' : ''}`)
  console.log(`  node ${c.node.version} · postgres ${c.postgres.version} (+${c.postgres.clientTools.tools.split(' ').length} client tools ${c.postgres.clientTools.version}) · caddy ${c.caddy.version} · powersync ${c.powersync.version} · api ${c.api.version} · web ${c.web.version}`)
}

const [cmd, dir] = process.argv.slice(2)
if (!dir || !['write', 'verify'].includes(cmd)) {
  console.error('usage: manifest.mjs write|verify <runtime dir>')
  process.exit(2)
}
await (cmd === 'write' ? write : verify)(path.resolve(dir))
