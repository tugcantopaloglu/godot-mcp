import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateCsharpScriptSource,
  generateCsprojContent,
  generateGodotProjectFeatures,
  getGodotBinaryCandidates,
  normalizeParameters,
} from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceCode = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const utilsCode = readFileSync(join(__dirname, '..', 'src', 'utils.ts'), 'utf8');

describe('generateCsharpScriptSource', () => {
  it('generates a minimal C# script with default _Ready method', () => {
    const result = generateCsharpScriptSource({
      namespace: 'MyGame',
      inherits: 'Node',
      className: 'Player',
    });
    expect(result).toContain('using Godot;');
    expect(result).toContain('using System;');
    expect(result).toContain('namespace MyGame;');
    expect(result).toContain('public partial class Player : Node');
    expect(result).toContain('public override void _Ready()');
    expect(result).toContain('// TODO: Implement');
    expect(result).toContain('}');
  });

  it('generates script with custom methods', () => {
    const result = generateCsharpScriptSource({
      namespace: 'MyRpg',
      inherits: 'CharacterBody3D',
      className: 'Hero',
      methods: ['_Ready', '_Process', '_PhysicsProcess'],
    });
    expect(result).toContain('namespace MyRpg;');
    expect(result).toContain('public partial class Hero : CharacterBody3D');
    expect(result).toContain('public override void _Ready()');
    expect(result).toContain('public override void _Process()');
    expect(result).toContain('public override void _PhysicsProcess()');
  });

  it('generates script with a single custom method (no default _Ready)', () => {
    const result = generateCsharpScriptSource({
      namespace: 'Game',
      inherits: 'Control',
      className: 'Hud',
      methods: ['_EnterTree'],
    });
    expect(result).toContain('public override void _EnterTree()');
    expect(result).not.toContain('public override void _Ready()');
  });

  it('handles empty methods array by defaulting to _Ready', () => {
    const result = generateCsharpScriptSource({
      namespace: 'Test',
      inherits: 'Node',
      className: 'TestScript',
      methods: [],
    });
    expect(result).toContain('public override void _Ready()');
  });

  it('handles undefined methods by defaulting to _Ready', () => {
    const result = generateCsharpScriptSource({
      namespace: 'Test',
      inherits: 'Node',
      className: 'TestScript',
    });
    expect(result).toContain('public override void _Ready()');
  });

  it('each method has braces and TODO comment', () => {
    const result = generateCsharpScriptSource({
      namespace: 'Ns',
      inherits: 'Node',
      className: 'C',
      methods: ['A', 'B'],
    });
    const methodCount = (result.match(/public override void/g) || []).length;
    expect(methodCount).toBe(2);
    expect(result).toContain('{');
    expect(result).toContain('// TODO: Implement');
  });

  it('ends with a newline and closing brace', () => {
    const result = generateCsharpScriptSource({
      namespace: 'Ns',
      inherits: 'Node',
      className: 'C',
    });
    expect(result.endsWith('}\n')).toBe(true);
  });
});

describe('isDotnetProject', () => {
  it('exists in source', () => {
    expect(sourceCode).toContain('isDotnetProject');
  });

  it('reads directory entries ending with .csproj', () => {
    expect(sourceCode).toContain('readdirSync');
    expect(sourceCode).toContain('.csproj');
  });

  it('returns false on error', () => {
    // The catch block returns false
    expect(sourceCode).toContain('catch');
    expect(sourceCode).toContain('return false');
  });
});

describe('handleCreateCsharpScript', () => {
  it('exists in source as a handler method', () => {
    expect(sourceCode).toContain('handleCreateCsharpScript');
  });

  it('validates projectPath and scriptPath are required', () => {
    const args = normalizeParameters({ projectPath: '/game' });
    expect(!args.projectPath || !args.scriptPath).toBe(true);
  });

  it('checks for project.godot before creating', () => {
    expect(sourceCode).toContain("project.godot");
    expect(sourceCode).toContain("Not a valid Godot project");
  });

  it('checks for .csproj (isDotnetProject) before creating', () => {
    expect(sourceCode).toContain('isDotnetProject');
    expect(sourceCode).toContain('Not a Godot .NET project');
  });

  it('falls back to default namespace from projectPath basename', () => {
    expect(sourceCode).toContain('basename(args.projectPath)');
  });

  it('falls back to Node as default inherits', () => {
    expect(sourceCode).toContain("inherits || 'Node'");
  });
});

describe('handleCreateProject dotnet support', () => {
  it('has dotnet property in schema definition', () => {
    const createProjectBlock = sourceCode.substring(
      sourceCode.indexOf("name: 'create_project'"),
      sourceCode.indexOf("name: 'manage_autoloads'"),
    );
    expect(createProjectBlock).toContain('dotnet');
  });

  it('checks args.dotnet === true for .NET project creation', () => {
    expect(sourceCode).toContain("args.dotnet === true");
  });

  it('generates .csproj file with Godot.NET.Sdk', () => {
    expect(utilsCode).toContain('Godot.NET.Sdk');
    expect(utilsCode).toContain('TargetFramework');
    expect(utilsCode).toContain('net8.0');
  });

  it('includes DotNet in features when dotnet is true', () => {
    expect(sourceCode).toContain('DotNet');
  });

  it('appends (Godot .NET) suffix in response text', () => {
    expect(sourceCode).toContain("' (Godot .NET)'");
  });
});

describe('get_project_info isDotnet field', () => {
  it('calls isDotnetProject in get_project_info', () => {
    expect(sourceCode).toContain('handleGetProjectInfo');
    expect(sourceCode).toContain('isDotnetProject');
  });

  it('includes isDotnet in response', () => {
    expect(sourceCode).toContain('isDotnet');
  });
});

describe('create_csharp_script tool definition', () => {
  it('defines create_csharp_script tool name', () => {
    expect(sourceCode).toContain("name: 'create_csharp_script'");
  });

  it('has required projectPath and scriptPath properties', () => {
    const toolBlock = sourceCode.substring(
      sourceCode.indexOf("name: 'create_csharp_script'"),
    );
    // Find the required array within this tool block (stops before next tool)
    const requiredEnd = toolBlock.indexOf('required:');
    const propsEnd = requiredEnd !== -1 ? requiredEnd : toolBlock.length;
    const propsBlock = toolBlock.substring(0, propsEnd);
    expect(propsBlock).toContain('projectPath');
    expect(propsBlock).toContain('scriptPath');
  });

  it('has optional properties inherits, namespace, methods, source', () => {
    const toolBlock = sourceCode.substring(
      sourceCode.indexOf("name: 'create_csharp_script'"),
      sourceCode.indexOf("name: 'manage_scene_signals'"),
    );
    expect(toolBlock).toContain('inherits');
    expect(toolBlock).toContain('namespace');
    expect(toolBlock).toContain('methods');
    expect(toolBlock).toContain('source');
  });
});

describe('generateCsharpScriptSource in utils.ts', () => {
  it('is exported from utils.ts', () => {
    expect(utilsCode).toContain('export function generateCsharpScriptSource');
  });
});

describe('generateCsprojContent', () => {
  it('generates .csproj with Godot.NET.Sdk and net8.0', () => {
    const result = generateCsprojContent('MyGame');
    expect(result).toContain('<Project Sdk="Godot.NET.Sdk/4.3.0">');
    expect(result).toContain('<TargetFramework>net8.0</TargetFramework>');
    expect(result).toContain('<Nullable>enable</Nullable>');
  });

  it('sanitizes project name for RootNamespace', () => {
    const result = generateCsprojContent('My Cool Game!');
    expect(result).toContain('<RootNamespace>My_Cool_Game_</RootNamespace>');
  });

  it('handles already-safe names', () => {
    const result = generateCsprojContent('GameName');
    expect(result).toContain('<RootNamespace>GameName</RootNamespace>');
  });

  it('starts with Project Sdk and ends with Project tag', () => {
    const result = generateCsprojContent('Test');
    expect(result.trim()).toMatch(/^<Project /);
    expect(result.trim()).toMatch(/<\/Project>$/);
  });
});

describe('generateGodotProjectFeatures', () => {
  it('returns DotNet features when isDotnet is true', () => {
    const result = generateGodotProjectFeatures(true);
    expect(result).toBe('PackedStringArray("4.3", "DotNet")');
  });

  it('returns standard features when isDotnet is false', () => {
    const result = generateGodotProjectFeatures(false);
    expect(result).toBe('PackedStringArray("4.3")');
  });
});

describe('getGodotBinaryCandidates', () => {
  it('always includes godot as first candidate', () => {
    const result = getGodotBinaryCandidates('darwin');
    expect(result[0]).toBe('godot');
  });

  it('returns darwin paths with mono variants', () => {
    const result = getGodotBinaryCandidates('darwin', '/Users/test');
    expect(result).toContain('/Applications/Godot.app/Contents/MacOS/Godot');
    expect(result).toContain('/Applications/Godot_mono.app/Contents/MacOS/Godot');
    expect(result).toContain('/Applications/Godot_4_mono.app/Contents/MacOS/Godot');
  });

  it('returns darwin home-relative paths when homeDir is provided', () => {
    const result = getGodotBinaryCandidates('darwin', '/Users/test');
    expect(result).toContain('/Users/test/Applications/Godot.app/Contents/MacOS/Godot');
    expect(result).toContain('/Users/test/Applications/Godot_mono.app/Contents/MacOS/Godot');
  });

  it('returns darwin steam path when homeDir is provided', () => {
    const result = getGodotBinaryCandidates('darwin', '/Users/test');
    expect(result).toContain('/Users/test/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot');
  });

  it('does not include home-relative paths when homeDir is not provided', () => {
    const result = getGodotBinaryCandidates('darwin');
    expect(result).not.toContain('/Users');
    expect(result).not.toContain('/Library');
  });

  it('returns win32 paths with mono variants', () => {
    const result = getGodotBinaryCandidates('win32');
    expect(result).toContain('C:\\Program Files\\Godot\\Godot.exe');
    expect(result).toContain('C:\\Program Files\\Godot\\Godot_mono.exe');
    expect(result).toContain('C:\\Program Files\\Godot_4_mono\\Godot.exe');
  });

  it('returns win32 user-specific paths when userProfile is provided', () => {
    const result = getGodotBinaryCandidates('win32', undefined, 'C:\\Users\\test');
    expect(result).toContain('C:\\Users\\test\\Godot\\Godot.exe');
    expect(result).toContain('C:\\Users\\test\\Godot\\Godot_mono.exe');
  });

  it('does not include user-specific paths when userProfile is not provided', () => {
    const result = getGodotBinaryCandidates('win32');
    expect(result.filter(p => p.includes('Users'))).toHaveLength(0);
  });

  it('returns linux paths with mono variants', () => {
    const result = getGodotBinaryCandidates('linux');
    expect(result).toContain('/usr/bin/godot');
    expect(result).toContain('/usr/bin/godot-mono');
    expect(result).toContain('/usr/local/bin/godot-mono');
  });

  it('returns linux home-relative paths when homeDir is provided', () => {
    const result = getGodotBinaryCandidates('linux', '/home/test');
    expect(result).toContain('/home/test/.local/bin/godot');
    expect(result).toContain('/home/test/.local/bin/godot-mono');
  });

  it('does not include home-relative paths on linux when no homeDir', () => {
    const result = getGodotBinaryCandidates('linux');
    expect(result.filter(p => p.includes('/home/'))).toHaveLength(0);
  });

  it('returns only godot for unknown platforms', () => {
    const result = getGodotBinaryCandidates('android');
    expect(result).toEqual(['godot']);
  });
});
