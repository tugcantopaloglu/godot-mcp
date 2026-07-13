import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syncVersions } from '../scripts/sync-version.js';

async function writeJson(root: string, name: string, value: unknown) {
  await writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(root: string, name: string) {
  return JSON.parse(await readFile(path.join(root, name), 'utf8'));
}

describe('syncVersions', () => {
  it('runs automatically during npm version', async () => {
    const rootPackage = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    );

    expect(rootPackage.scripts.version).toBe(
      'node scripts/sync-version.js && git add package-lock.json server.json'
    );
  });

  it('keeps the repository release manifests in sync', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const packageJson = await readJson(root, 'package.json');
    const packageLock = await readJson(root, 'package-lock.json');
    const server = await readJson(root, 'server.json');

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(server.version).toBe(packageJson.version);
    expect(server.packages.every((entry: { version: string }) => entry.version === packageJson.version)).toBe(
      true
    );
  });

  it('uses package.json as the version source for lockfile and MCP registry metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'godot-mcp-version-'));

    await writeJson(root, 'package.json', { name: 'godot-mcp', version: '3.2.0' });
    await writeJson(root, 'package-lock.json', {
      name: 'godot-mcp',
      version: '3.1.0',
      packages: { '': { name: 'godot-mcp', version: '3.1.0' } },
    });
    await writeJson(root, 'server.json', {
      version: '3.1.0',
      packages: [
        { registryType: 'npm', identifier: 'godot-mcp', version: '3.1.0' },
        { registryType: 'oci', identifier: 'godot-mcp', version: '3.1.0' },
      ],
    });

    await syncVersions(root);

    const lock = await readJson(root, 'package-lock.json');
    const server = await readJson(root, 'server.json');

    expect(lock.version).toBe('3.2.0');
    expect(lock.packages[''].version).toBe('3.2.0');
    expect(server.version).toBe('3.2.0');
    expect(server.packages.map((entry: { version: string }) => entry.version)).toEqual([
      '3.2.0',
      '3.2.0',
    ]);
  });
});
