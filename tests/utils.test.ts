import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  PARAMETER_MAPPINGS,
  REVERSE_PARAMETER_MAPPINGS,
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  validateProjectPath,
  createErrorResponse,
  isGodot44OrLater,
  toWslProjectPath,
  toNativeProjectPath,
  isWindowsGodotExe,
  projectGodotFile,
  projectFilePath,
  toWindowsAccessiblePath,
  addGodotIniSectionLine,
  removeGodotIniSectionLine,
  parseGodotIni,
} from '../src/utils.js';

describe('PARAMETER_MAPPINGS', () => {
  it('maps snake_case to camelCase', () => {
    expect(PARAMETER_MAPPINGS['project_path']).toBe('projectPath');
    expect(PARAMETER_MAPPINGS['scene_path']).toBe('scenePath');
    expect(PARAMETER_MAPPINGS['node_path']).toBe('nodePath');
    expect(PARAMETER_MAPPINGS['node_type']).toBe('nodeType');
    expect(PARAMETER_MAPPINGS['node_name']).toBe('nodeName');
  });

  it('covers all expected parameter names', () => {
    const expectedKeys = [
      'project_path', 'scene_path', 'root_node_type', 'parent_node_path',
      'node_type', 'node_name', 'texture_path', 'node_path', 'output_path',
      'mesh_item_names', 'new_path', 'file_path', 'signal_name', 'target_path',
      'class_name', 'root_path', 'new_parent_path', 'keep_global_transform',
      'script_path', 'resource_type', 'resource_path', 'final_value',
      'trans_type', 'ease_type', 'type_hint', 'parent_path',
      // New mappings
      'directory_path', 'from_x', 'from_y', 'to_x', 'to_y',
      'project_name', 'action_name',
    ];
    for (const key of expectedKeys) {
      expect(PARAMETER_MAPPINGS).toHaveProperty(key);
    }
  });
});

describe('REVERSE_PARAMETER_MAPPINGS', () => {
  it('is the inverse of PARAMETER_MAPPINGS', () => {
    for (const [snake, camel] of Object.entries(PARAMETER_MAPPINGS)) {
      expect(REVERSE_PARAMETER_MAPPINGS[camel]).toBe(snake);
    }
  });

  it('has same number of entries as PARAMETER_MAPPINGS', () => {
    expect(Object.keys(REVERSE_PARAMETER_MAPPINGS).length).toBe(
      Object.keys(PARAMETER_MAPPINGS).length
    );
  });
});

describe('normalizeParameters', () => {
  it('converts snake_case keys to camelCase', () => {
    const result = normalizeParameters({ project_path: '/foo', scene_path: 'bar.tscn' });
    expect(result).toEqual({ projectPath: '/foo', scenePath: 'bar.tscn' });
  });

  it('preserves already-camelCase keys', () => {
    const result = normalizeParameters({ projectPath: '/foo', scenePath: 'bar.tscn' });
    expect(result).toEqual({ projectPath: '/foo', scenePath: 'bar.tscn' });
  });

  it('preserves unknown keys as-is', () => {
    const result = normalizeParameters({ custom_key: 'value', another: 42 });
    expect(result).toEqual({ custom_key: 'value', another: 42 });
  });

  it('handles nested objects', () => {
    const result = normalizeParameters({
      project_path: '/foo',
      nested: { node_path: '/root/Player' },
    });
    expect(result).toEqual({
      projectPath: '/foo',
      nested: { nodePath: '/root/Player' },
    });
  });

  it('preserves arrays without modification', () => {
    const result = normalizeParameters({ items: [1, 2, 3] });
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it('returns falsy inputs as-is', () => {
    expect(normalizeParameters(null as any)).toBeNull();
    expect(normalizeParameters(undefined as any)).toBeUndefined();
  });

  it('handles empty object', () => {
    expect(normalizeParameters({})).toEqual({});
  });

  it('handles mixed snake_case and camelCase', () => {
    const result = normalizeParameters({
      project_path: '/foo',
      nodeName: 'Player',
    });
    expect(result).toEqual({ projectPath: '/foo', nodeName: 'Player' });
  });

  it('normalizes new parameter mappings', () => {
    const result = normalizeParameters({
      directory_path: 'scripts',
      from_x: 10, from_y: 20,
      to_x: 100, to_y: 200,
      project_name: 'MyGame',
      action_name: 'jump',
    });
    expect(result.directoryPath).toBe('scripts');
    expect(result.fromX).toBe(10);
    expect(result.fromY).toBe(20);
    expect(result.toX).toBe(100);
    expect(result.toY).toBe(200);
    expect(result.projectName).toBe('MyGame');
    expect(result.actionName).toBe('jump');
  });
});

describe('convertCamelToSnakeCase', () => {
  it('converts known camelCase keys to snake_case', () => {
    const result = convertCamelToSnakeCase({ projectPath: '/foo', scenePath: 'bar.tscn' });
    expect(result).toEqual({ project_path: '/foo', scene_path: 'bar.tscn' });
  });

  it('converts unknown camelCase keys using regex', () => {
    const result = convertCamelToSnakeCase({ myCustomKey: 'value' });
    expect(result).toEqual({ my_custom_key: 'value' });
  });

  it('handles nested objects', () => {
    const result = convertCamelToSnakeCase({
      projectPath: '/foo',
      nested: { nodePath: '/root' },
    });
    expect(result).toEqual({
      project_path: '/foo',
      nested: { node_path: '/root' },
    });
  });

  it('preserves arrays', () => {
    const result = convertCamelToSnakeCase({ items: [1, 2] });
    expect(result).toEqual({ items: [1, 2] });
  });

  it('handles empty object', () => {
    expect(convertCamelToSnakeCase({})).toEqual({});
  });

  it('preserves already snake_case keys', () => {
    const result = convertCamelToSnakeCase({ already_snake: 'value' });
    expect(result).toEqual({ already_snake: 'value' });
  });
});

describe('validatePath', () => {
  it('returns true for valid paths', () => {
    expect(validatePath('/home/user/project')).toBe(true);
    expect(validatePath('scenes/main.tscn')).toBe(true);
    expect(validatePath('C:\\Users\\test')).toBe(true);
  });

  it('returns false for paths with ..', () => {
    expect(validatePath('../../../etc/passwd')).toBe(false);
    expect(validatePath('foo/../bar')).toBe(false);
    expect(validatePath('..')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(validatePath('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(validatePath(null as any)).toBe(false);
    expect(validatePath(undefined as any)).toBe(false);
  });
});

describe('validateProjectPath', () => {
  const originalRoots = process.env.GODOT_MCP_PROJECT_ROOTS;

  afterEach(() => {
    if (originalRoots === undefined) delete process.env.GODOT_MCP_PROJECT_ROOTS;
    else process.env.GODOT_MCP_PROJECT_ROOTS = originalRoots;
  });

  it('allows any valid project path when no project roots are configured', () => {
    delete process.env.GODOT_MCP_PROJECT_ROOTS;
    expect(validateProjectPath('/home/user/project')).toBe(true);
  });

  it('allows only configured absolute project roots when configured', () => {
    process.env.GODOT_MCP_PROJECT_ROOTS = '/mnt/c/Code/SpaceportArchitect/SpaceportArchitect';
    expect(validateProjectPath('/mnt/c/Code/SpaceportArchitect/SpaceportArchitect')).toBe(true);
    expect(validateProjectPath('/mnt/c/Code/SpaceportArchitect/SpaceportArchitect/Bootstrap')).toBe(true);
    expect(validateProjectPath('/mnt/c/Code/OtherProject')).toBe(false);
  });

  it('rejects relative project paths when project roots are configured', () => {
    process.env.GODOT_MCP_PROJECT_ROOTS = '/mnt/c/Code/SpaceportArchitect/SpaceportArchitect';
    expect(validateProjectPath('Bootstrap/Game.tscn')).toBe(false);
  });
});

describe('createErrorResponse', () => {
  it('returns object with isError true', () => {
    const result = createErrorResponse('Something went wrong');
    expect(result.isError).toBe(true);
  });

  it('includes error message in content', () => {
    const result = createErrorResponse('Test error');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Test error');
  });

  it('handles different error messages', () => {
    const result = createErrorResponse('Another error');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Another error');
  });
});

describe('isGodot44OrLater', () => {
  it('returns true for 4.4', () => {
    expect(isGodot44OrLater('4.4.0')).toBe(true);
    expect(isGodot44OrLater('4.4')).toBe(true);
  });

  it('returns true for versions after 4.4', () => {
    expect(isGodot44OrLater('4.5.0')).toBe(true);
    expect(isGodot44OrLater('5.0.0')).toBe(true);
    expect(isGodot44OrLater('4.10.1')).toBe(true);
  });

  it('returns false for versions before 4.4', () => {
    expect(isGodot44OrLater('4.3.0')).toBe(false);
    expect(isGodot44OrLater('4.0.0')).toBe(false);
    expect(isGodot44OrLater('3.5.0')).toBe(false);
  });

  it('returns false for non-matching strings', () => {
    expect(isGodot44OrLater('')).toBe(false);
    expect(isGodot44OrLater('invalid')).toBe(false);
  });

  it('handles version strings with extra info', () => {
    expect(isGodot44OrLater('4.4.1.stable')).toBe(true);
    expect(isGodot44OrLater('4.3.2.rc1')).toBe(false);
  });
});

describe('WSL path translation', () => {
  const origPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  afterEach(() => setPlatform(origPlatform));

  describe('on linux', () => {
    beforeEach(() => setPlatform('linux'));

    it('toWslProjectPath converts C:/... to /mnt/c/...', () => {
      expect(toWslProjectPath('C:/Users/me/game')).toBe('/mnt/c/Users/me/game');
      expect(toWslProjectPath('D:/projects/x')).toBe('/mnt/d/projects/x');
    });

    it('toWslProjectPath converts Windows backslashes too', () => {
      expect(toWslProjectPath(String.raw`C:\Users\me\game`)).toBe('/mnt/c/Users/me/game');
    });

    it('toWslProjectPath passes /mnt/ paths through', () => {
      expect(toWslProjectPath('/mnt/c/Users/me')).toBe('/mnt/c/Users/me');
    });

    it('toWslProjectPath passes linux-native paths through', () => {
      expect(toWslProjectPath('/home/joachima/game')).toBe('/home/joachima/game');
    });

    it('toNativeProjectPath converts /mnt/c/... to C:/...', () => {
      expect(toNativeProjectPath('/mnt/c/Users/me/game')).toBe('C:/Users/me/game');
      expect(toNativeProjectPath('/mnt/d/x')).toBe('D:/x');
    });

    it('toNativeProjectPath passes non-mount paths through', () => {
      expect(toNativeProjectPath('/home/joachima/game')).toBe('/home/joachima/game');
    });

    it('toNativeProjectPath passes Windows paths through unchanged', () => {
      expect(toNativeProjectPath('C:/foo')).toBe('C:/foo');
    });
  });

  describe('on non-linux', () => {
    beforeEach(() => setPlatform('darwin'));

    it('toWslProjectPath is a no-op', () => {
      expect(toWslProjectPath('C:/Users/me')).toBe('C:/Users/me');
      expect(toWslProjectPath('/Users/me')).toBe('/Users/me');
    });

    it('toNativeProjectPath is a no-op', () => {
      expect(toNativeProjectPath('/mnt/c/foo')).toBe('/mnt/c/foo');
    });
  });

  describe('empty / falsy paths', () => {
    it('returns the input unchanged', () => {
      expect(toWslProjectPath('')).toBe('');
      expect(toNativeProjectPath('')).toBe('');
    });
  });
});

describe('isWindowsGodotExe', () => {
  it('is true for .exe paths', () => {
    expect(isWindowsGodotExe('C:/Program Files/Godot/Godot.exe')).toBe(true);
    expect(isWindowsGodotExe('godot.EXE')).toBe(true);
  });

  it('is false for linux / unix binaries', () => {
    expect(isWindowsGodotExe('/usr/bin/godot')).toBe(false);
    expect(isWindowsGodotExe('godot')).toBe(false);
  });

  it('is false for null / undefined / empty', () => {
    expect(isWindowsGodotExe(null)).toBe(false);
    expect(isWindowsGodotExe(undefined)).toBe(false);
    expect(isWindowsGodotExe('')).toBe(false);
  });
});

describe('projectGodotFile', () => {
  const origPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  afterEach(() => setPlatform(origPlatform));

  it('joins a WSL-translated project path with project.godot on linux', () => {
    setPlatform('linux');
    expect(projectGodotFile('C:/Users/me/game')).toBe('/mnt/c/Users/me/game/project.godot');
  });

  it('passes a native project path through on linux', () => {
    setPlatform('linux');
    expect(projectGodotFile('/home/me/game')).toBe('/home/me/game/project.godot');
  });

  it('joins as-is on non-linux', () => {
    setPlatform('win32');
    // win32 path.join uses backslashes — just check it ends with project.godot
    expect(projectGodotFile('C:/Users/me/game')).toMatch(/project\.godot$/);
  });
});

describe('projectFilePath', () => {
  const origPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  afterEach(() => setPlatform(origPlatform));

  it('translates Windows-style paths on linux', () => {
    setPlatform('linux');
    expect(projectFilePath('C:/game', 'Dockerfile')).toBe('/mnt/c/game/Dockerfile');
  });

  it('passes linux-native paths through', () => {
    setPlatform('linux');
    expect(projectFilePath('/home/me/game', 'addons', 'x')).toBe(
      '/home/me/game/addons/x'
    );
  });
});

describe('toWindowsAccessiblePath', () => {
  const origPlatform = process.platform;
  const origDistro = process.env.WSL_DISTRO_NAME;
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  beforeEach(() => setPlatform('linux'));
  afterEach(() => {
    setPlatform(origPlatform);
    if (origDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = origDistro;
  });

  it('passes through when godotPath is not a .exe', () => {
    expect(toWindowsAccessiblePath('/home/me/x.gd', '/usr/bin/godot')).toBe('/home/me/x.gd');
  });

  it('converts /mnt/<letter>/... to Windows drive form for Godot.exe', () => {
    expect(toWindowsAccessiblePath('/mnt/c/Foo/bar.gd', 'C:/Godot/Godot.exe')).toBe(
      'C:/Foo/bar.gd'
    );
  });

  it('converts /home/... to WSL UNC form for Godot.exe', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    expect(toWindowsAccessiblePath('/home/me/script.gd', 'C:/Godot/Godot.exe')).toBe(
      String.raw`\\wsl.localhost\Ubuntu\home\me\script.gd`
    );
  });

  it('uses WSL_DISTRO_NAME from the environment when present', () => {
    process.env.WSL_DISTRO_NAME = 'Debian';
    expect(toWindowsAccessiblePath('/opt/tool', 'C:/Godot/Godot.exe')).toMatch(
      /\\\\wsl\.localhost\\Debian\\opt\\tool/
    );
  });

  it('defaults the distro to Ubuntu when the env var is unset', () => {
    delete process.env.WSL_DISTRO_NAME;
    expect(toWindowsAccessiblePath('/var/x', 'C:/Godot/Godot.exe')).toMatch(
      /^\\\\wsl\.localhost\\Ubuntu\\var\\x$/
    );
  });

  it('passes a Windows-native path through unchanged', () => {
    expect(toWindowsAccessiblePath('C:/Foo/bar.gd', 'C:/Godot/Godot.exe')).toBe(
      'C:/Foo/bar.gd'
    );
  });

  it('is a no-op on non-linux platforms', () => {
    setPlatform('win32');
    expect(toWindowsAccessiblePath('/home/me/x.gd', 'C:/Godot/Godot.exe')).toBe(
      '/home/me/x.gd'
    );
  });

  it('returns the input unchanged when path or godotPath is empty', () => {
    expect(toWindowsAccessiblePath('', 'C:/Godot/Godot.exe')).toBe('');
    expect(toWindowsAccessiblePath('/home/me/x.gd', null)).toBe('/home/me/x.gd');
  });

  it('passes an already-UNC path through unchanged', () => {
    const unc = String.raw`\\wsl.localhost\Ubuntu\home\me`;
    expect(toWindowsAccessiblePath(unc, 'C:/Godot/Godot.exe')).toBe(unc);
  });

  it('passes a bare drive letter through unchanged', () => {
    expect(toWindowsAccessiblePath('C:', 'C:/Godot/Godot.exe')).toBe('C:');
  });

  it('passes a drive-relative path through unchanged', () => {
    expect(toWindowsAccessiblePath('C:project.godot', 'C:/Godot/Godot.exe')).toBe(
      'C:project.godot'
    );
  });

  it('handles /mnt/c with no subpath', () => {
    expect(toWindowsAccessiblePath('/mnt/c', 'C:/Godot/Godot.exe')).toBe('C:/');
  });

  it('leaves relative linux-style paths alone', () => {
    expect(toWindowsAccessiblePath('scripts/x.gd', 'C:/Godot/Godot.exe')).toBe(
      'scripts/x.gd'
    );
  });
});

describe('parseGodotIni', () => {
  describe('Godot INI section line helpers', () => {
    const autoloadLine = 'McpInteractionServer="*res://mcp_interaction_server.gd"';

    it('round-trips an injected autoload without leaving whitespace', () => {
      const original = `[application]\nconfig/name="Game"\n`;
      const injected = addGodotIniSectionLine(
        original,
        'autoload',
        autoloadLine,
        'McpInteractionServer'
      );

      expect(injected).toBe(
        `[application]\n` +
          `config/name="Game"\n` +
          `\n` +
          `[autoload]\n` +
          `${autoloadLine}\n`
      );
      expect(removeGodotIniSectionLine(injected, 'autoload', 'McpInteractionServer')).toBe(original);
    });

    it('preserves surrounding whitespace when other entries remain', () => {
      const content =
        `[autoload]\n` +
        `\n` +
        `${autoloadLine}\n` +
        `Globals="*res://globals.gd"\n`;

      expect(removeGodotIniSectionLine(content, 'autoload', 'McpInteractionServer')).toBe(
        `[autoload]\n` +
          `\n` +
          `Globals="*res://globals.gd"\n`
      );
    });

    it('round-trips byte-for-byte against Godot formatting with other entries', () => {
      // Godot keeps a blank line after each section header and before the next
      // section. Injecting then removing the autoload must leave the file
      // identical so there is no git churn.
      const original =
        `[application]\n` +
        `\n` +
        `config/name="Game"\n` +
        `\n` +
        `[autoload]\n` +
        `\n` +
        `Globals="*res://globals.gd"\n` +
        `\n` +
        `[rendering]\n` +
        `\n` +
        `renderer/rendering_method="gl_compatibility"\n`;

      const injected = addGodotIniSectionLine(
        original,
        'autoload',
        autoloadLine,
        'McpInteractionServer'
      );

      expect(injected).toBe(
        `[application]\n` +
          `\n` +
          `config/name="Game"\n` +
          `\n` +
          `[autoload]\n` +
          `\n` +
          `Globals="*res://globals.gd"\n` +
          `${autoloadLine}\n` +
          `\n` +
          `[rendering]\n` +
          `\n` +
          `renderer/rendering_method="gl_compatibility"\n`
      );
      expect(removeGodotIniSectionLine(injected, 'autoload', 'McpInteractionServer')).toBe(original);
    });

    it('only removes matching keys from the target section', () => {
      const content =
        `[application]\n` +
        `McpInteractionServer="not an autoload"\n` +
        `\n` +
        `[autoload]\n` +
        `${autoloadLine}\n`;

      expect(removeGodotIniSectionLine(content, 'autoload', 'McpInteractionServer')).toBe(
        `[application]\n` +
          `McpInteractionServer="not an autoload"\n`
      );
    });

    it('does not duplicate an existing autoload key', () => {
      const content = `[autoload]\n${autoloadLine}\n`;

      expect(addGodotIniSectionLine(content, 'autoload', autoloadLine, 'McpInteractionServer')).toBe(content);
    });
  });

  it('parses a simple flat section', () => {
    const out = parseGodotIni(
      `[application]\n` +
        `config/name="Game"\n` +
        `run/main_scene="res://Main.tscn"\n`
    );
    expect(out.application).toEqual({
      'config/name': '"Game"',
      'run/main_scene': '"res://Main.tscn"',
    });
  });

  it('parses multi-line input map actions without truncation', () => {
    const content =
      `[input]\n` +
      `PaintGrass={\n` +
      `"deadzone": 0.5,\n` +
      `"events": [Object(InputEventKey,"keycode":71,"pressed":false)]\n` +
      `}\n`;
    const out = parseGodotIni(content);
    expect(out.input).toBeDefined();
    expect(out.input.PaintGrass).toContain('"deadzone": 0.5');
    expect(out.input.PaintGrass).toContain('"events"');
    expect(out.input.PaintGrass).toContain('"keycode":71');
    expect(out.input.PaintGrass.trim().endsWith('}')).toBe(true);
  });

  it('parses multi-line array values', () => {
    const content =
      `[autoload]\n` +
      `Globals=[\n` +
      `"res://a.gd",\n` +
      `"res://b.gd"\n` +
      `]\n`;
    const out = parseGodotIni(content);
    expect(out.autoload.Globals).toContain('"res://a.gd"');
    expect(out.autoload.Globals).toContain('"res://b.gd"');
    expect(out.autoload.Globals.trim().endsWith(']')).toBe(true);
  });

  it('ignores braces inside string literals for depth tracking', () => {
    const content =
      `[input]\n` +
      `evil={\n` +
      `"comment": "has } inside",\n` +
      `"closer": "[ not opener"\n` +
      `}\n`;
    const out = parseGodotIni(content);
    expect(out.input.evil.trim().endsWith('}')).toBe(true);
    expect(out.input.evil).toContain('"has } inside"');
  });

  it('skips comments and blank lines', () => {
    const out = parseGodotIni(
      `; comment\n` +
        `\n` +
        `[rendering]\n` +
        `; another\n` +
        `msaa_3d=2\n`
    );
    expect(out.rendering.msaa_3d).toBe('2');
  });

  it('handles multiple sections with mixed single and multi-line values', () => {
    const content =
      `[application]\n` +
      `config/name="X"\n` +
      `\n` +
      `[input]\n` +
      `jump={\n` +
      `"events": []\n` +
      `}\n` +
      `left={"deadzone": 0.5}\n`;
    const out = parseGodotIni(content);
    expect(out.application['config/name']).toBe('"X"');
    expect(out.input.jump).toContain('"events"');
    expect(out.input.jump.trim().endsWith('}')).toBe(true);
    expect(out.input.left).toBe('{"deadzone": 0.5}');
  });
});
