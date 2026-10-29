import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const project = readJson(resolve(root, 'project.config.json'));
const appRoot = resolve(root, project.miniprogramRoot);
const app = readJson(resolve(appRoot, 'app.json'));
const files = [];
const checkedComponents = new Set();

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
}

function checkModule(base, component = false) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    assert(existsSync(`${base}.${extension}`), `缺少页面或组件文件：${base}.${extension}`);
  }
  const config = readJson(`${base}.json`);
  if (component) assert.equal(config.component, true);

  const markup = readFileSync(`${base}.wxml`, 'utf8');
  const code = readFileSync(`${base}.js`, 'utf8');
  const eventCode = code.includes('Page(createLoginPage(')
    ? `${code}\n${readFileSync(resolve(appRoot, 'services/login-page.js'), 'utf8')}`
    : code;
  for (const match of markup.matchAll(/(?:bind|catch)(?::)?[\w-]+\s*=\s*"([A-Za-z_]\w*)"/g)) {
    assert(new RegExp(`\\b${match[1]}\\s*(?::\\s*function\\s*)?\\(`).test(eventCode), `事件处理方法不存在：${base} → ${match[1]}`);
  }
  for (const match of markup.matchAll(/\bsrc="(\/[^"{}]+)"/g)) {
    assert(existsSync(resolve(appRoot, `.${match[1]}`)), `图片不存在：${match[1]}`);
  }
  for (const path of Object.values(config.usingComponents || {})) {
    checkComponent(path.startsWith('/') ? resolve(appRoot, `.${path}`) : resolve(dirname(base), path));
  }
}

function checkComponent(base) {
  if (checkedComponents.has(base)) return;
  checkedComponents.add(base);
  checkModule(base, true);
}

assert.match(project.appid, /^wx[0-9a-f]{16}$/);
assert.equal(project.appid, 'wxb7e6889ef5fe7e88');
assert.equal(project.compileType, 'miniprogram');
assert(existsSync(resolve(root, project.cloudfunctionRoot)));
assert(existsSync(resolve(appRoot, 'app.js')));
assert(existsSync(resolve(appRoot, 'app.wxss')));
assert(existsSync(resolve(appRoot, app.sitemapLocation)));
assert.equal(new Set(app.pages).size, app.pages.length, '页面重复注册');
assert.equal(app.tabBar.list.length, 3, '首版必须保持三个底部 tab');

for (const page of app.pages) checkModule(resolve(appRoot, page));
let subpackagePages = 0;
for (const subpackage of app.subPackages || []) {
  for (const page of subpackage.pages) {
    checkModule(resolve(appRoot, subpackage.root, page));
    subpackagePages += 1;
  }
}
for (const path of Object.values(app.usingComponents || {})) {
  checkComponent(resolve(appRoot, `.${path}`));
}
for (const tab of app.tabBar.list) {
  assert(app.pages.includes(tab.pagePath), `底部 tab 未注册：${tab.pagePath}`);
  for (const property of ['iconPath', 'selectedIconPath']) {
    const path = resolve(appRoot, tab[property]);
    const png = readFileSync(path);
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `图标不是 PNG：${path}`);
    assert(png.readUInt32BE(16) <= 81 && png.readUInt32BE(20) <= 81, `图标尺寸超出预期：${path}`);
    assert(statSync(path).size <= 40 * 1024, `图标超过 40KB：${path}`);
  }
}

walk(appRoot);
for (const entry of readdirSync(resolve(root, project.cloudfunctionRoot), { withFileTypes: true })) {
  if (entry.isDirectory()) walk(resolve(root, project.cloudfunctionRoot, entry.name));
}
let scriptsChecked = 0;
for (const path of files) {
  if (extname(path) === '.json') readJson(path);
  if (extname(path) !== '.js') continue;
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path}\n${result.stderr || result.error || ''}`);
  scriptsChecked += 1;
}

console.log(`检查通过：${app.pages.length} 个主包页面、${subpackagePages} 个分包页面、${checkedComponents.size} 个组件、${scriptsChecked} 个 JS 文件语法、底部导航和静态资源引用。`);
console.log('检查仅覆盖工程结构与 JavaScript 语法；WXML/WXSS 编译、界面与云端行为需在微信开发者工具/真机验证。');
