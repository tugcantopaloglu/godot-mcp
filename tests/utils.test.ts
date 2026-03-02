import { describe, it, expect } from 'vitest';
import {
  PARAMETER_MAPPINGS,
  REVERSE_PARAMETER_MAPPINGS,
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
  isGodot44OrLater,
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

  it('accepts optional possibleSolutions without crashing', () => {
    const result = createErrorResponse('Error', ['Fix A', 'Fix B']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error');
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
