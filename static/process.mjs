// 浏览器端 process polyfill（供 xterm.js 使用）
const p = {
  env: {},
  argv: [],
  version: '',
  versions: { node: '' },
  platform: 'browser',
  title: 'browser',
  pid: 1,
  ppid: 0,
  arch: '',
  cwd: () => '/',
  hrtime: () => [0, 0],
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  on: () => {},
  removeListener: () => {},
  emit: () => {},
  listeners: () => [],
  stdout: { isTTY: false },
  stderr: { isTTY: false },
  stdin: { isTTY: false },
};
export default p;
