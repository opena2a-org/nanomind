import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Another socket on the machine can hold a fixed port. A test that listens on
// it then fails with EADDRINUSE; for a daemon the error arrives after start()
// has returned, and the suite's tests then fail on connect. These tests read
// the other test files of this package and fail on a listen() call or an
// httpPort option whose port is a fixed number.

/**
 * Each line of `source` where a listen() call or an httpPort option has a
 * fixed port: a number other than 0, or a name that `source` declares with
 * such a number. Returned as `<line number>: <line>`.
 */
function fixedPortListeners(source: string): string[] {
  const declared = new Map<string, string>();
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*(?:[;,)]|$)/gm)) {
    declared.set(m[1], m[2]);
  }
  const lines = source.split('\n');
  const found: string[] = [];
  for (const m of source.matchAll(/\.listen\(\s*(?:\{[^}]*?\bport\s*:\s*)?([\w$]+)|\bhttpPort\s*:\s*([\w$]+)/g)) {
    const token = m[1] ?? m[2];
    const port = /^\d/.test(token) ? token : declared.get(token);
    if (port !== undefined && Number(port.replaceAll('_', '')) !== 0) {
      const line = source.slice(0, m.index).split('\n').length;
      found.push(`${line}: ${lines[line - 1].trim()}`);
    }
  }
  return found;
}

describe('fixed TCP ports in the tests of this package', () => {
  it('finds a listen() or httpPort port written as a number, or as a name declared with one', () => {
    // The two suites of fabric-adapter.test.ts that had fixed ports.
    assert.deepStrictEqual(fixedPortListeners([
      "  const DAEMON_PORT = 47286; // distinct from the other suites' ports",
      '    daemon = new NanoMindDaemon({',
      '      httpPort: DAEMON_PORT,',
      "  const PORT = 47287; // distinct from the other suites' ports",
      "    server.listen(PORT, '127.0.0.1');",
    ].join('\n')), [
      '3: httpPort: DAEMON_PORT,',
      "5: server.listen(PORT, '127.0.0.1');",
    ]);
    // Two shapes that server.test.ts had before it took its ports from the OS.
    assert.deepStrictEqual(fixedPortListeners([
      '    const port = 47296;',
      '      httpPort: port,',
      '    const other = new NanoMindDaemon({ httpPort: 47295, ipcPath: path, engine: stubEngine });',
    ].join('\n')), [
      '2: httpPort: port,',
      '3: const other = new NanoMindDaemon({ httpPort: 47295, ipcPath: path, engine: stubEngine });',
    ]);
    assert.deepStrictEqual(fixedPortListeners([
      "server.listen({ host: '127.0.0.1', port: 8080 });",
      'server.listen(',
      '  8081,',
      ');',
    ].join('\n')), [
      "1: server.listen({ host: '127.0.0.1', port: 8080 });",
      '2: server.listen(',
    ]);
  });

  it('passes port 0, a port read at run time and a socket path', () => {
    assert.deepStrictEqual(fixedPortListeners([
      "    server.listen(0, '127.0.0.1');",
      "    server.listen({ host: '127.0.0.1', port: 0 });",
      '  let TEST_PORT: number;',
      '      httpPort: TEST_PORT,',
      '      httpPort: 0,',
      '    const other = new NanoMindDaemon({ httpPort: await freePort(), ipcPath: path, engine: stubEngine });',
      "    await new Promise<void>(resolve => listener.listen(join(SOCKET_DIR, 'moved.sock'), resolve));",
    ].join('\n')), []);
  });

  it('finds none in the other test files of this package', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const self = basename(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter(name => name.endsWith('.test.ts') && name !== self);
    assert.ok(files.includes('fabric-adapter.test.ts'), `test files read: ${files.join(', ')}`);
    const found = files.flatMap(name =>
      fixedPortListeners(readFileSync(join(dir, name), 'utf-8')).map(hit => `${name}:${hit}`),
    );
    assert.deepStrictEqual(found, []);
  });
});
