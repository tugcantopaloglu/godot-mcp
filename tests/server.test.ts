import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockRenameSync = vi.fn();
const mockExecFile = vi.fn();

// Mock child_process before importing GodotServer
vi.mock('child_process', () => ({
  execFile: mockExecFile,
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: { on: vi.fn(), setEncoding: vi.fn() },
    stderr: { on: vi.fn(), setEncoding: vi.fn() },
    pid: 12345,
  })),
}));

// Mock util.promisify to return a wrapper that returns { stdout, stderr }
vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: vi.fn((fn: Function) => {
      return (...args: any[]) => {
        return new Promise((resolve, reject) => {
          const callback = (err: Error | null, stdout?: string, stderr?: string) => {
            if (err) reject(err);
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
          };
          fn(...args, callback);
        });
      };
    }),
  };
});

// Mock net to prevent actual TCP connections
vi.mock('net', () => ({
  createConnection: vi.fn(() => ({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    setEncoding: vi.fn(),
    setTimeout: vi.fn(),
  })),
  Socket: vi.fn(),
}));

// Mock fs to allow per-test control of key functions
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
    renameSync: mockRenameSync,
  };
});

describe('GodotServer', () => {
  let GodotServer: { new: (config?: any) => any };

  beforeAll(async () => {
    process.env.GODOT_PATH = '/mock/godot';
    const mod = await import('../src/index.js');
    GodotServer = mod.GodotServer;
  });

  afterAll(() => {
    delete process.env.GODOT_PATH;
  });

  beforeEach(() => {
    mockExecFile.mockImplementation((...args: any[]) => {
      // promisify(execFile) passes callback, call it with (null, stdout, stderr)
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb(null, 'Godot 4.3.stable\n', '');
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isDotnetProject', () => {
    it('returns true when .csproj files exist in directory', () => {
      mockReaddirSync.mockReturnValue(['MyGame.csproj', 'Main.cs']);
      const server = new (GodotServer as any)();
      const result = server.isDotnetProject('/fake/project');
      expect(result).toBe(true);
    });

    it('returns false when no .csproj files exist', () => {
      mockReaddirSync.mockReturnValue(['Main.gd', 'Main.tscn']);
      const server = new (GodotServer as any)();
      const result = server.isDotnetProject('/fake/project');
      expect(result).toBe(false);
    });

    it('returns false when directory cannot be read', () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('permission denied'); });
      const server = new (GodotServer as any)();
      const result = server.isDotnetProject('/fake/project');
      expect(result).toBe(false);
    });
  });

  describe('detectGodotPath', () => {
    afterEach(() => {
      delete process.env.GODOT_PATH;
    });

    it('uses GODOT_PATH env var if valid', async () => {
      process.env.GODOT_PATH = '/mock/godot';
      mockExistsSync.mockReturnValue(true);
      const server = new (GodotServer as any)();
      await server.detectGodotPath();
      expect(server.godotPath).toBe('/mock/godot');
    });

    it('returns without changing when existing godotPath is valid', async () => {
      mockExistsSync.mockReturnValue(true);
      const server = new (GodotServer as any)({ godotPath: '/custom/godot' });
      await server.detectGodotPath();
      expect(server.godotPath).toBe('/custom/godot');
    });
  });

  describe('getProjectStructure', () => {
    it('categorizes directories correctly', async () => {
      mockReaddirSync.mockReturnValue([
        { name: 'scenes', isDirectory: () => true },
        { name: 'scripts', isDirectory: () => true },
        { name: 'textures', isDirectory: () => true },
        { name: '.godot', isDirectory: () => true },
        { name: 'main.tscn', isDirectory: () => false },
      ]);
      const server = new (GodotServer as any)();
      const result = await server.getProjectStructure('/fake/project');
      expect(result.scenes).toContain('scenes');
      expect(result.scripts).toContain('scripts');
      expect(result.assets).toContain('textures');
    });
  });

  describe('findGodotProjects', () => {
    it('finds immediate Godot projects in a directory', () => {
      // Only subdirectories have project.godot, not the parent itself
      mockExistsSync.mockImplementation(
        (p: string) => !p.toString().endsWith('projects/project.godot'),
      );
      mockReaddirSync.mockReturnValue([
        { name: 'MyGame', isDirectory: () => true },
        { name: 'OtherGame', isDirectory: () => true },
      ]);
      const server = new (GodotServer as any)();
      const result = server.findGodotProjects('/fake/projects', false);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('MyGame');
      expect(result[1].name).toBe('OtherGame');
    });

    it('returns empty when no projects found', () => {
      mockReaddirSync.mockReturnValue([]);
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = server.findGodotProjects('/fake/projects', false);
      expect(result).toHaveLength(0);
    });
  });

  describe('handleCreateProject', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false);
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
    });

    it('creates a regular project successfully', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateProject({
        projectPath: '/tmp/test-project',
        projectName: 'TestGame',
      });
      const text = result.content[0].text;
      expect(text).toContain('TestGame');
      expect(text).not.toContain('.NET');
    });

    it('creates a .NET project when dotnet flag is true', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateProject({
        projectPath: '/tmp/test-dotnet',
        projectName: 'DotNetGame',
        dotnet: true,
      });
      const text = result.content[0].text;
      expect(text).toContain('DotNetGame');
      expect(text).toContain('.NET');
    });

    it('rejects when projectPath or projectName is missing', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateProject({ projectPath: '/tmp' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('projectPath and projectName are required');
    });

    it('rejects when project already exists', async () => {
      mockExistsSync.mockReturnValue(true);
      const server = new (GodotServer as any)();
      const result = await server.handleCreateProject({
        projectPath: '/tmp/existing',
        projectName: 'Existing',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already exists');
    });

    it('rejects invalid path', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateProject({
        projectPath: '../../etc/passwd',
        projectName: 'Bad',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('isValidGodotPath', () => {
    it('returns true for godot (PATH check) without fs access', async () => {
      const server = new (GodotServer as any)();
      const result = await server.isValidGodotPath('godot');
      expect(result).toBe(true);
    });

    it('returns false when path does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.isValidGodotPath('/invalid/path');
      expect(result).toBe(false);
    });
  });

  describe('setGodotPath', () => {
    it('returns false for invalid path', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.setGodotPath('/invalid/path');
      expect(result).toBe(false);
    });
  });

  describe('handleGetProjectInfo', () => {
    it('returns error for non-existent project', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.handleGetProjectInfo({ projectPath: '/fake' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not a valid Godot project');
    });

    it('reads project info and includes isDotnet', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[application]
config/name="TestGame"
config/features=PackedStringArray("4.3", "DotNet")
      `);
      // getProjectStructureAsync (Dirent-like) called first, then isDotnetProject (strings)
      mockReaddirSync
        .mockReturnValueOnce([
          { name: 'TestGame.csproj', isDirectory: () => false, isFile: () => true },
        ])
        .mockReturnValueOnce(['TestGame.csproj']);
      const server = new (GodotServer as any)();
      const result = await server.handleGetProjectInfo({ projectPath: '/fake' });
      const json = JSON.parse(result.content[0].text);
      expect(json.name).toBe('TestGame');
      expect(json.isDotnet).toBe(true);
    });

    it('reads project info without .NET', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`
[application]
config/name="MyGame"
      `);
      mockReaddirSync
        .mockReturnValueOnce([
          { name: 'Main.gd', isDirectory: () => false, isFile: () => true },
        ])
        .mockReturnValueOnce(['Main.gd']);
      const server = new (GodotServer as any)();
      const result = await server.handleGetProjectInfo({ projectPath: '/fake' });
      const json = JSON.parse(result.content[0].text);
      expect(json.name).toBe('MyGame');
      expect(json.isDotnet).toBe(false);
    });
  });

  describe('handleCreateCsharpScript', () => {
    it('rejects non-.NET projects', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);
      const server = new (GodotServer as any)();
      const result = await server.handleCreateCsharpScript({
        projectPath: '/fake',
        scriptPath: 'scripts/Player.cs',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not a Godot .NET project');
    });

    it('creates a C# script in a .NET project', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['MyGame.csproj']);
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      const server = new (GodotServer as any)();
      const result = await server.handleCreateCsharpScript({
        projectPath: '/fake',
        scriptPath: 'scripts/Player.cs',
        namespace: 'MyGame',
        inherits: 'CharacterBody3D',
        methods: ['_Ready', '_Process'],
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Player.cs');
    });
  });

  describe('handleCsharpScript validation', () => {
    it('rejects when projectPath or scriptPath is missing', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateCsharpScript({ projectPath: '/fake' });
      expect(result.isError).toBe(true);
    });

    it('rejects when project.godot does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.handleCreateCsharpScript({
        projectPath: '/fake',
        scriptPath: 'test.cs',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not a valid Godot project');
    });

    it('rejects path traversal', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleCreateCsharpScript({
        projectPath: '../../etc',
        scriptPath: 'test.cs',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('constructor config', () => {
    it('accepts strictPathValidation config', () => {
      const server = new (GodotServer as any)({ strictPathValidation: true });
      expect(server.strictPathValidation).toBe(true);
    });

    it('resets godotPath when sync validation fails', () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)({ godotPath: '/bad/path' });
      expect(server.godotPath).toBeNull();
    });
  });

  describe('handleGetGodotVersion', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('returns Godot version via execFileAsync', async () => {
      const server = new (GodotServer as any)();
      server.godotPath = '/mock/godot';
      const result = await server.handleGetGodotVersion();
      expect(result.content[0].text).toBe('Godot 4.3.stable');
    });
  });

  describe('handleListProjects', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects when directory is missing', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleListProjects({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Directory is required');
    });

    it('rejects invalid directory path', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleListProjects({ directory: '../../etc' });
      expect(result.isError).toBe(true);
    });

    it('rejects non-existent directory', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.handleListProjects({ directory: '/noexist' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Directory does not exist');
    });

    it('lists projects in a directory', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        { name: 'MyGame', isDirectory: () => true },
      ]);
      const server = new (GodotServer as any)();
      const result = await server.handleListProjects({ directory: '/projects' });
      expect(result.isError).toBeFalsy();
      const projects = JSON.parse(result.content[0].text);
      expect(Array.isArray(projects)).toBe(true);
    });
  });

  describe('handleReadFile', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing params', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleReadFile({ projectPath: '/p' });
      expect(r.isError).toBe(true);
    });

    it('rejects invalid path', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleReadFile({ projectPath: '../../etc', filePath: 'x' });
      expect(r.isError).toBe(true);
    });

    it('rejects when project.godot does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const r = await server.handleReadFile({ projectPath: '/p', filePath: 'f.txt' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('Not a valid Godot project');
    });

    it('rejects when target file does not exist', async () => {
      mockExistsSync.mockImplementation(
        (p: string) => p.toString().endsWith('project.godot'),
      );
      const server = new (GodotServer as any)();
      const r = await server.handleReadFile({ projectPath: '/p', filePath: 'f.txt' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('File does not exist');
    });

    it('reads file content successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('hello world');
      const server = new (GodotServer as any)();
      const r = await server.handleReadFile({ projectPath: '/p', filePath: 'f.txt' });
      expect(r.content[0].text).toBe('hello world');
    });
  });

  describe('handleWriteFile', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing content', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleWriteFile({ projectPath: '/p', filePath: 'f.txt' });
      expect(r.isError).toBe(true);
    });

    it('writes file successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);
      const server = new (GodotServer as any)();
      const r = await server.handleWriteFile({ projectPath: '/p', filePath: 'f.txt', content: 'data' });
      expect(r.content[0].text).toContain('File written');
    });
  });

  describe('handleDeleteFile', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing params', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleDeleteFile({});
      expect(r.isError).toBe(true);
    });

    it('deletes file successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockUnlinkSync.mockReturnValue(undefined);
      const server = new (GodotServer as any)();
      const r = await server.handleDeleteFile({ projectPath: '/p', filePath: 'f.txt' });
      expect(r.content[0].text).toContain('File deleted');
    });
  });

  describe('handleCreateDirectory', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing params', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleCreateDirectory({ projectPath: '/p' });
      expect(r.isError).toBe(true);
    });

    it('creates directory successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockMkdirSync.mockReturnValue(undefined);
      const server = new (GodotServer as any)();
      const r = await server.handleCreateDirectory({ projectPath: '/p', directoryPath: 'new_dir' });
      expect(r.content[0].text).toContain('Directory created');
    });
  });

  describe('handleRenameFile', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing params', async () => {
      const server = new (GodotServer as any)();
      const r = await server.handleRenameFile({ projectPath: '/p', filePath: 'a.txt' });
      expect(r.isError).toBe(true);
    });

    it('renames file successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockMkdirSync.mockReturnValue(undefined);
      mockRenameSync.mockReturnValue(undefined);
      const server = new (GodotServer as any)();
      const r = await server.handleRenameFile({ projectPath: '/p', filePath: 'a.txt', newPath: 'b.txt' });
      expect(r.content[0].text).toContain('Renamed');
    });
  });

  describe('setGodotPath', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('sets a valid Godot path successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args.find((a: any) => typeof a === 'function');
        if (cb) cb(null, 'Godot 4.3.stable\n', '');
      });
      const server = new (GodotServer as any)();
      const result = await server.setGodotPath('/valid/godot');
      expect(result).toBe(true);
      expect(server.godotPath).toBe('/valid/godot');
    });

    it('rejects invalid Godot path (non-existent file)', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.setGodotPath('/bad/godot');
      expect(result).toBe(false);
    });
  });

  describe('gameCommand error paths', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects when no active process', async () => {
      const server = new (GodotServer as any)();
      const result = await server.gameCommand('test_cmd', {}, () => ({}));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No active Godot process');
    });

    it('rejects when not connected', async () => {
      const server = new (GodotServer as any)();
      server.activeProcess = { process: { kill: vi.fn() }, output: [], errors: [] };
      const result = await server.gameCommand('test_cmd', {}, () => ({}));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not connected');
    });
  });

  describe('headlessOp with mocked executeOperation', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('rejects missing projectPath', async () => {
      const server = new (GodotServer as any)();
      const result = await server.headlessOp('op', {}, () => ({ projectPath: '', params: {} }));
      expect(result.isError).toBe(true);
    });

    it('rejects invalid path', async () => {
      const server = new (GodotServer as any)();
      const result = await server.headlessOp('op', { projectPath: '../../etc' }, (a: any) => ({ projectPath: a.projectPath, params: {} }));
      expect(result.isError).toBe(true);
    });

    it('rejects non-existent project', async () => {
      mockExistsSync.mockReturnValue(false);
      const server = new (GodotServer as any)();
      const result = await server.headlessOp('op', { projectPath: '/fake' }, (a: any) => ({ projectPath: a.projectPath, params: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not a valid Godot project');
    });
  });

  describe('handleGetDebugOutput', () => {
    it('rejects when no active process', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleGetDebugOutput();
      expect(result.isError).toBe(true);
    });

    it('returns output and errors arrays', async () => {
      const server = new (GodotServer as any)();
      server.activeProcess = { process: { kill: vi.fn() }, output: ['log1'], errors: ['err1'] };
      const result = await server.handleGetDebugOutput();
      const json = JSON.parse(result.content[0].text);
      expect(json.output).toContain('log1');
      expect(json.errors).toContain('err1');
    });
  });

  describe('handleGameGetErrors', () => {
    it('rejects when no active process', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleGameGetErrors();
      expect(result.isError).toBe(true);
    });

    it('returns accumulated errors since last call', async () => {
      const server = new (GodotServer as any)();
      server.activeProcess = { process: { kill: vi.fn() }, output: [], errors: ['err1', 'err2'] };
      const result = await server.handleGameGetErrors();
      const json = JSON.parse(result.content[0].text);
      expect(json.count).toBe(2);
    });
  });

  describe('handleGameGetLogs', () => {
    it('rejects when no active process', async () => {
      const server = new (GodotServer as any)();
      const result = await server.handleGameGetLogs();
      expect(result.isError).toBe(true);
    });

    it('returns accumulated logs since last call', async () => {
      const server = new (GodotServer as any)();
      server.activeProcess = { process: { kill: vi.fn() }, output: ['log1', 'log2'], errors: [] };
      const result = await server.handleGameGetLogs();
      const json = JSON.parse(result.content[0].text);
      expect(json.count).toBe(2);
    });
  });

  describe('handleGetGodotVersion error paths', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('returns error when no godot path found in strict mode', async () => {
      mockExistsSync.mockReturnValue(false);
      // Override execFile to fail for all paths so auto-detect fails
      mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args.find((a: any) => typeof a === 'function');
        if (cb) cb(new Error('not found'), '', '');
      });
      const server = new (GodotServer as any)({ strictPathValidation: true });
      const result = await server.handleGetGodotVersion();
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get Godot version');
    });
  });
});
