import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/@vant/weapp/lib');
const target = resolve(root, 'miniprogram/admin/vendor/vant');
const copied = new Set();
const version = JSON.parse(readFileSync(resolve(source, '../package.json'), 'utf8')).version;
assert.equal(version, '1.11.7');

function copyModule(base) {
  for (const suffix of ['.js', '.json', '.wxml', '.wxss']) copy(`${base}${suffix}`);
}

function copy(file) {
  if (copied.has(file)) return;
  const name = relative(source, file);
  assert(!name.startsWith('..'), `Dependency outside Vant: ${name}`);
  assert(existsSync(file), `Missing Vant dependency: ${name}`);
  copied.add(file);
  const output = resolve(target, name);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(file, output);
  const content = readFileSync(file, 'utf8');
  if (extname(file) === '.json') {
    for (const dependency of Object.values(JSON.parse(content).usingComponents || {})) {
      copyModule(resolve(dirname(file), dependency));
    }
    return;
  }
  const pattern = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|\bsrc=['"]([^'"{}]+)['"]|@import\s+['"]([^'"]+)['"])/g;
  for (const match of content.matchAll(pattern)) {
    let dependency = resolve(dirname(file), match[1] || match[2] || match[3]);
    if (!extname(dependency)) dependency += '.js';
    copy(dependency);
  }
}

copyModule(resolve(source, 'uploader/index'));
copyFileSync(resolve(source, '../LICENSE'), resolve(target, 'LICENSE'));
console.log(`Vant Weapp ${version}: ${copied.size} dependency files copied to the admin package.`);
