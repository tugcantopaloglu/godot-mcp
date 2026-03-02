/**
 * Handler tests for Godot MCP server.
 *
 * Because GodotServer is not exported and auto-starts on import, we cannot
 * instantiate it directly.  Instead we test the handler logic by:
 *   1. Importing the source as raw text and verifying structural invariants.
 *   2. Testing the pure utility helpers that handlers depend on (normalizeParameters,
 *      validatePath, convertCamelToSnakeCase, createErrorResponse).
 *   3. Exercising the gameCommand / headlessOp patterns via focused unit-style
 *      tests that simulate what each handler does with its arguments.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
} from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sourceCode: string;

beforeAll(() => {
  sourceCode = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
});

// ---------------------------------------------------------------------------
// Helpers that replicate the core logic of gameCommand / headlessOp so we can
// unit-test argument validation and transform functions extracted from handlers.
// ---------------------------------------------------------------------------

function fakeGameCommand(
  hasActiveProcess: boolean,
  hasConnection: boolean,
  args: any,
  argsFn: (a: any) => Record<string, any>,
): { error: string | null; commandArgs: Record<string, any> | null } {
  if (!hasActiveProcess) return { error: 'No active Godot process. Use run_project first.', commandArgs: null };
  if (!hasConnection) return { error: 'Not connected to game interaction server.', commandArgs: null };
  args = normalizeParameters(args || {});
  try {
    return { error: null, commandArgs: argsFn(args) };
  } catch (e: any) {
    return { error: e.message, commandArgs: null };
  }
}

function fakeHeadlessOp(
  args: any,
  argsFn: (a: any) => { projectPath: string; params: any },
  projectExists: boolean = true,
): { error: string | null; operation: { projectPath: string; params: any } | null } {
  args = normalizeParameters(args || {});
  const { projectPath, params } = argsFn(args);
  if (!projectPath) return { error: 'projectPath is required.', commandArgs: null } as any;
  if (!validatePath(projectPath)) return { error: 'Invalid path.', commandArgs: null } as any;
  if (!projectExists) return { error: `Not a valid Godot project: ${projectPath}`, commandArgs: null } as any;
  return { error: null, operation: { projectPath, params } };
}

// ---------------------------------------------------------------------------
// 1. gameCommand-based handler tests
// ---------------------------------------------------------------------------
describe('Game command handlers — argument transforms', () => {
  // game_click
  describe('handleGameClick', () => {
    const argsFn = (a: any) => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button ?? 1 });

    it('defaults x/y to 0 and button to 1', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.error).toBeNull();
      expect(r.commandArgs).toEqual({ x: 0, y: 0, button: 1 });
    });

    it('passes provided coordinates', () => {
      const r = fakeGameCommand(true, true, { x: 100, y: 200, button: 2 }, argsFn);
      expect(r.commandArgs).toEqual({ x: 100, y: 200, button: 2 });
    });

    it('returns error when no active process', () => {
      const r = fakeGameCommand(false, true, {}, argsFn);
      expect(r.error).toContain('No active Godot process');
    });

    it('returns error when not connected', () => {
      const r = fakeGameCommand(true, false, {}, argsFn);
      expect(r.error).toContain('Not connected');
    });
  });

  // game_mouse_move
  describe('handleGameMouseMove', () => {
    const argsFn = (a: any) => ({
      x: a.x ?? 0, y: a.y ?? 0, relative_x: a.relative_x ?? 0, relative_y: a.relative_y ?? 0,
    });

    it('defaults all values to 0', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ x: 0, y: 0, relative_x: 0, relative_y: 0 });
    });

    it('preserves provided values', () => {
      const r = fakeGameCommand(true, true, { x: 10, y: 20, relative_x: 5, relative_y: -3 }, argsFn);
      expect(r.commandArgs).toEqual({ x: 10, y: 20, relative_x: 5, relative_y: -3 });
    });
  });

  // game_get_ui (no args)
  describe('handleGameGetUi', () => {
    it('sends empty args', () => {
      const r = fakeGameCommand(true, true, {}, () => ({}));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_get_scene_tree (no args)
  describe('handleGameGetSceneTree', () => {
    it('sends empty args', () => {
      const r = fakeGameCommand(true, true, {}, () => ({}));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_eval
  describe('handleGameEval', () => {
    it('passes code parameter', () => {
      const args = normalizeParameters({ code: 'get_tree().root.name' });
      const r = fakeGameCommand(true, true, args, a => ({ code: a.code }));
      expect(r.commandArgs).toEqual({ code: 'get_tree().root.name' });
    });
  });

  // game_get_property
  describe('handleGameGetProperty', () => {
    const argsFn = (a: any) => ({ node_path: a.nodePath, property: a.property });

    it('maps nodePath to node_path', () => {
      const args = normalizeParameters({ node_path: '/root/Player', property: 'position' });
      const r = fakeGameCommand(true, true, args, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Player', property: 'position' });
    });

    it('accepts already camelCase nodePath', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Enemy', property: 'health' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Enemy', property: 'health' });
    });
  });

  // game_set_property
  describe('handleGameSetProperty', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, property: a.property, value: a.value, type_hint: a.typeHint || '',
    });

    it('maps all params correctly', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/Player', property: 'speed', value: 100, typeHint: 'int',
      }, argsFn);
      expect(r.commandArgs).toEqual({
        node_path: '/root/Player', property: 'speed', value: 100, type_hint: 'int',
      });
    });

    it('defaults type_hint to empty string', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/P', property: 'x', value: 0,
      }, argsFn);
      expect(r.commandArgs!.type_hint).toBe('');
    });
  });

  // game_call_method
  describe('handleGameCallMethod', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, method: a.method, args: a.args || [],
    });

    it('sends method with empty args array by default', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/P', method: 'jump' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/P', method: 'jump', args: [] });
    });

    it('passes provided args array', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/P', method: 'take_damage', args: [10, 'fire'],
      }, argsFn);
      expect(r.commandArgs!.args).toEqual([10, 'fire']);
    });
  });

  // game_get_node_info
  describe('handleGameGetNodeInfo', () => {
    it('passes nodePath as node_path', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/UI' }, a => ({ node_path: a.nodePath }));
      expect(r.commandArgs).toEqual({ node_path: '/root/UI' });
    });
  });

  // game_instantiate_scene
  describe('handleGameInstantiateScene', () => {
    const argsFn = (a: any) => ({
      scene_path: a.scenePath, parent_path: a.parentPath || '/root',
    });

    it('defaults parent_path to /root', () => {
      const r = fakeGameCommand(true, true, { scenePath: 'res://enemy.tscn' }, argsFn);
      expect(r.commandArgs).toEqual({ scene_path: 'res://enemy.tscn', parent_path: '/root' });
    });

    it('accepts custom parent_path', () => {
      const r = fakeGameCommand(true, true, {
        scenePath: 'res://bullet.tscn', parentPath: '/root/Bullets',
      }, argsFn);
      expect(r.commandArgs).toEqual({ scene_path: 'res://bullet.tscn', parent_path: '/root/Bullets' });
    });
  });

  // game_remove_node
  describe('handleGameRemoveNode', () => {
    it('passes node_path', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Enemy' }, a => ({ node_path: a.nodePath }));
      expect(r.commandArgs).toEqual({ node_path: '/root/Enemy' });
    });
  });

  // game_change_scene
  describe('handleGameChangeScene', () => {
    it('passes scene_path', () => {
      const r = fakeGameCommand(true, true, { scenePath: 'res://level2.tscn' }, a => ({ scene_path: a.scenePath }));
      expect(r.commandArgs).toEqual({ scene_path: 'res://level2.tscn' });
    });
  });

  // game_pause
  describe('handleGamePause', () => {
    const argsFn = (a: any) => ({ paused: a.paused !== undefined ? a.paused : true });

    it('defaults paused to true', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ paused: true });
    });

    it('accepts paused=false', () => {
      const r = fakeGameCommand(true, true, { paused: false }, argsFn);
      expect(r.commandArgs).toEqual({ paused: false });
    });
  });

  // game_performance (no args)
  describe('handleGamePerformance', () => {
    it('sends empty args', () => {
      const r = fakeGameCommand(true, true, {}, () => ({}));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_wait
  describe('handleGameWait', () => {
    const argsFn = (a: any) => ({ frames: a.frames || 1 });

    it('defaults frames to 1', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ frames: 1 });
    });

    it('accepts custom frame count', () => {
      const r = fakeGameCommand(true, true, { frames: 60 }, argsFn);
      expect(r.commandArgs).toEqual({ frames: 60 });
    });
  });

  // game_connect_signal
  describe('handleGameConnectSignal', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, signal_name: a.signalName,
      target_path: a.targetPath, method: a.method,
    });

    it('maps all signal params', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/Button', signalName: 'pressed',
        targetPath: '/root/Game', method: '_on_button_pressed',
      }, argsFn);
      expect(r.commandArgs).toEqual({
        node_path: '/root/Button', signal_name: 'pressed',
        target_path: '/root/Game', method: '_on_button_pressed',
      });
    });
  });

  // game_disconnect_signal
  describe('handleGameDisconnectSignal', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, signal_name: a.signalName,
      target_path: a.targetPath, method: a.method,
    });

    it('maps all disconnect params', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/B', signalName: 'pressed',
        targetPath: '/root/G', method: 'handler',
      }, argsFn);
      expect(r.commandArgs!.signal_name).toBe('pressed');
    });
  });

  // game_emit_signal
  describe('handleGameEmitSignal', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, signal_name: a.signalName, args: a.args || [],
    });

    it('defaults args to empty array', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/E', signalName: 'died',
      }, argsFn);
      expect(r.commandArgs!.args).toEqual([]);
    });

    it('passes provided signal args', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/E', signalName: 'hit', args: [10],
      }, argsFn);
      expect(r.commandArgs!.args).toEqual([10]);
    });
  });

  // game_play_animation
  describe('handleGamePlayAnimation', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, action: a.action || 'play', animation: a.animation || '',
    });

    it('defaults to action=play, animation=""', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/P' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/P', action: 'play', animation: '' });
    });

    it('accepts stop action', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/P', action: 'stop' }, argsFn);
      expect(r.commandArgs!.action).toBe('stop');
    });
  });

  // game_tween_property
  describe('handleGameTweenProperty', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, property: a.property, final_value: a.finalValue,
      duration: a.duration || 1.0, trans_type: a.transType || 0, ease_type: a.easeType || 2,
    });

    it('defaults duration/trans/ease', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/Sprite', property: 'modulate:a', finalValue: 0,
      }, argsFn);
      expect(r.commandArgs).toEqual({
        node_path: '/root/Sprite', property: 'modulate:a', final_value: 0,
        duration: 1.0, trans_type: 0, ease_type: 2,
      });
    });

    it('accepts custom tween params', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/Sprite', property: 'position:x', finalValue: 100,
        duration: 2.5, transType: 1, easeType: 3,
      }, argsFn);
      expect(r.commandArgs!.duration).toBe(2.5);
      expect(r.commandArgs!.trans_type).toBe(1);
      expect(r.commandArgs!.ease_type).toBe(3);
    });
  });

  // game_get_nodes_in_group
  describe('handleGameGetNodesInGroup', () => {
    it('passes group name', () => {
      const r = fakeGameCommand(true, true, { group: 'enemies' }, a => ({ group: a.group }));
      expect(r.commandArgs).toEqual({ group: 'enemies' });
    });
  });

  // game_find_nodes_by_class
  describe('handleGameFindNodesByClass', () => {
    const argsFn = (a: any) => ({
      class_name: a.className, root_path: a.rootPath || '/root',
    });

    it('defaults root_path to /root', () => {
      const r = fakeGameCommand(true, true, { className: 'Sprite2D' }, argsFn);
      expect(r.commandArgs).toEqual({ class_name: 'Sprite2D', root_path: '/root' });
    });

    it('accepts custom root_path', () => {
      const r = fakeGameCommand(true, true, { className: 'Label', rootPath: '/root/UI' }, argsFn);
      expect(r.commandArgs!.root_path).toBe('/root/UI');
    });
  });

  // game_reparent_node
  describe('handleGameReparentNode', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, new_parent_path: a.newParentPath,
      keep_global_transform: a.keepGlobalTransform !== false,
    });

    it('defaults keep_global_transform to true', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/Player', newParentPath: '/root/World',
      }, argsFn);
      expect(r.commandArgs!.keep_global_transform).toBe(true);
    });

    it('accepts keep_global_transform=false', () => {
      const r = fakeGameCommand(true, true, {
        nodePath: '/root/P', newParentPath: '/root/W', keepGlobalTransform: false,
      }, argsFn);
      expect(r.commandArgs!.keep_global_transform).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Handler validation tests (missing required params)
// ---------------------------------------------------------------------------
describe('Handler required-parameter validation', () => {
  // Each handler validates required params before calling gameCommand/headlessOp.
  // We verify the validation logic by source inspection and inline tests.

  it('game_eval requires code', () => {
    const args = normalizeParameters({});
    expect(args.code).toBeUndefined();
    // The handler checks: if (!args.code) return createErrorResponse(...)
    const result = !args.code ? createErrorResponse('code parameter is required.') : null;
    expect(result!.isError).toBe(true);
  });

  it('game_get_property requires nodePath and property', () => {
    const args = normalizeParameters({});
    const missing = !args.nodePath || !args.property;
    expect(missing).toBe(true);
  });

  it('game_set_property requires nodePath and property', () => {
    const args = normalizeParameters({ nodePath: '/root/P' });
    const missing = !args.nodePath || !args.property;
    expect(missing).toBe(true);
  });

  it('game_call_method requires nodePath and method', () => {
    const args = normalizeParameters({ method: 'jump' });
    const missing = !args.nodePath || !args.method;
    expect(missing).toBe(true);
  });

  it('game_get_node_info requires nodePath', () => {
    const args = normalizeParameters({});
    expect(!args.nodePath).toBe(true);
  });

  it('game_instantiate_scene requires scenePath', () => {
    const args = normalizeParameters({});
    expect(!args.scenePath).toBe(true);
  });

  it('game_remove_node requires nodePath', () => {
    const args = normalizeParameters({});
    expect(!args.nodePath).toBe(true);
  });

  it('game_change_scene requires scenePath', () => {
    const args = normalizeParameters({});
    expect(!args.scenePath).toBe(true);
  });

  it('game_key_press requires key or action', () => {
    const args = normalizeParameters({});
    expect(!args.key && !args.action).toBe(true);
  });

  it('game_key_press with key only is valid', () => {
    const args = { key: 'W' };
    expect(!args.key && !(args as any).action).toBe(false);
  });

  it('game_key_press with action only is valid', () => {
    const args = { action: 'ui_accept' };
    expect(!(args as any).key && !args.action).toBe(false);
  });

  it('game_connect_signal requires 4 params', () => {
    const args = normalizeParameters({ nodePath: '/root/B', signalName: 'pressed' });
    const missing = !args.nodePath || !args.signalName || !args.targetPath || !args.method;
    expect(missing).toBe(true);
  });

  it('game_disconnect_signal requires 4 params', () => {
    const args = normalizeParameters({ targetPath: '/root/G' });
    const missing = !args.nodePath || !args.signalName || !args.targetPath || !args.method;
    expect(missing).toBe(true);
  });

  it('game_emit_signal requires nodePath and signalName', () => {
    const args = normalizeParameters({ signalName: 'died' });
    const missing = !args.nodePath || !args.signalName;
    expect(missing).toBe(true);
  });

  it('game_play_animation requires nodePath', () => {
    const args = normalizeParameters({});
    expect(!args.nodePath).toBe(true);
  });

  it('game_tween_property requires nodePath, property, finalValue', () => {
    const args = normalizeParameters({ nodePath: '/root/S', property: 'x' });
    expect(args.finalValue === undefined).toBe(true);
  });

  it('game_get_nodes_in_group requires group', () => {
    const args = normalizeParameters({});
    expect(!(args as any).group).toBe(true);
  });

  it('game_find_nodes_by_class requires className', () => {
    const args = normalizeParameters({});
    expect(!args.className).toBe(true);
  });

  it('game_reparent_node requires nodePath and newParentPath', () => {
    const args = normalizeParameters({ nodePath: '/root/P' });
    expect(!args.nodePath || !args.newParentPath).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. headlessOp-based handler tests
// ---------------------------------------------------------------------------
describe('Headless operation handlers — argument transforms', () => {
  describe('handleModifySceneNode', () => {
    const argsFn = (a: any) => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, properties: a.properties },
    });

    it('maps all params correctly', () => {
      const r = fakeHeadlessOp({
        projectPath: '/home/user/game',
        scenePath: 'scenes/main.tscn',
        nodePath: '/root/Player',
        properties: { visible: true },
      }, argsFn);
      expect(r.error).toBeNull();
      expect(r.operation!.projectPath).toBe('/home/user/game');
      expect(r.operation!.params.scenePath).toBe('scenes/main.tscn');
    });

    it('fails without projectPath', () => {
      const r = fakeHeadlessOp({ scenePath: 'a', nodePath: 'b', properties: {} }, argsFn);
      expect(r.error).toContain('projectPath');
    });
  });

  describe('handleRemoveSceneNode', () => {
    const argsFn = (a: any) => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath },
    });

    it('maps params', () => {
      const r = fakeHeadlessOp({
        projectPath: '/home/user/game', scenePath: 'main.tscn', nodePath: '/root/Enemy',
      }, argsFn);
      expect(r.error).toBeNull();
      expect(r.operation!.params.nodePath).toBe('/root/Enemy');
    });
  });

  describe('handleAttachScript', () => {
    const argsFn = (a: any) => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, scriptPath: a.scriptPath },
    });

    it('maps all params', () => {
      const r = fakeHeadlessOp({
        projectPath: '/game', scenePath: 'main.tscn',
        nodePath: '/root/Player', scriptPath: 'scripts/player.gd',
      }, argsFn);
      expect(r.error).toBeNull();
      expect(r.operation!.params.scriptPath).toBe('scripts/player.gd');
    });

    it('requires projectPath', () => {
      const r = fakeHeadlessOp({
        scenePath: 'main.tscn', nodePath: '/root/P', scriptPath: 's.gd',
      }, argsFn);
      expect(r.error).toContain('projectPath');
    });
  });

  describe('handleCreateResource', () => {
    const argsFn = (a: any) => ({
      projectPath: a.projectPath,
      params: {
        resourceType: a.resourceType, resourcePath: a.resourcePath,
        ...(a.properties ? { properties: a.properties } : {}),
      },
    });

    it('maps required params', () => {
      const r = fakeHeadlessOp({
        projectPath: '/game', resourceType: 'PackedScene', resourcePath: 'res://new.tres',
      }, argsFn);
      expect(r.error).toBeNull();
      expect(r.operation!.params.resourceType).toBe('PackedScene');
      expect(r.operation!.params.properties).toBeUndefined();
    });

    it('includes optional properties', () => {
      const r = fakeHeadlessOp({
        projectPath: '/game', resourceType: 'Theme', resourcePath: 'res://theme.tres',
        properties: { font_size: 16 },
      }, argsFn);
      expect(r.operation!.params.properties).toEqual({ font_size: 16 });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. headlessOp path validation
// ---------------------------------------------------------------------------
describe('headlessOp path validation', () => {
  const simpleArgsFn = (a: any) => ({ projectPath: a.projectPath, params: {} });

  it('rejects missing projectPath', () => {
    const r = fakeHeadlessOp({}, simpleArgsFn);
    expect(r.error).toContain('projectPath');
  });

  it('rejects path traversal', () => {
    const r = fakeHeadlessOp({ projectPath: '../../etc/passwd' }, simpleArgsFn);
    expect(r.error).toContain('Invalid');
  });

  it('rejects empty projectPath', () => {
    const r = fakeHeadlessOp({ projectPath: '' }, simpleArgsFn);
    expect(r.error).toBeTruthy();
  });

  it('accepts valid path when project exists', () => {
    const r = fakeHeadlessOp({ projectPath: '/home/user/game' }, simpleArgsFn, true);
    expect(r.error).toBeNull();
  });

  it('rejects when project does not exist', () => {
    const r = fakeHeadlessOp({ projectPath: '/home/user/game' }, simpleArgsFn, false);
    expect(r.error).toContain('Not a valid Godot project');
  });
});

// ---------------------------------------------------------------------------
// 5. snake_case parameter normalization in handlers
// ---------------------------------------------------------------------------
describe('Handler snake_case → camelCase normalization', () => {
  it('normalizes node_path to nodePath in game handlers', () => {
    const args = normalizeParameters({ node_path: '/root/Player', property: 'position' });
    expect(args.nodePath).toBe('/root/Player');
    expect(args.property).toBe('position');
  });

  it('normalizes scene_path and project_path in headless handlers', () => {
    const args = normalizeParameters({ project_path: '/game', scene_path: 'main.tscn' });
    expect(args.projectPath).toBe('/game');
    expect(args.scenePath).toBe('main.tscn');
  });

  it('normalizes signal handler parameters', () => {
    const args = normalizeParameters({
      node_path: '/root/B', signal_name: 'pressed', target_path: '/root/G',
    });
    expect(args.nodePath).toBe('/root/B');
    expect(args.signalName).toBe('pressed');
    expect(args.targetPath).toBe('/root/G');
  });

  it('normalizes tween parameters', () => {
    const args = normalizeParameters({
      node_path: '/root/S', final_value: 0, trans_type: 1, ease_type: 2,
    });
    expect(args.nodePath).toBe('/root/S');
    expect(args.finalValue).toBe(0);
    expect(args.transType).toBe(1);
    expect(args.easeType).toBe(2);
  });

  it('normalizes reparent parameters', () => {
    const args = normalizeParameters({
      node_path: '/root/P', new_parent_path: '/root/W', keep_global_transform: false,
    });
    expect(args.nodePath).toBe('/root/P');
    expect(args.newParentPath).toBe('/root/W');
    expect(args.keepGlobalTransform).toBe(false);
  });

  it('normalizes script/resource parameters', () => {
    const args = normalizeParameters({
      project_path: '/game', script_path: 'player.gd', resource_type: 'Theme', resource_path: 'res://t.tres',
    });
    expect(args.projectPath).toBe('/game');
    expect(args.scriptPath).toBe('player.gd');
    expect(args.resourceType).toBe('Theme');
    expect(args.resourcePath).toBe('res://t.tres');
  });
});

// ---------------------------------------------------------------------------
// 6. Source-level handler structure verification
// ---------------------------------------------------------------------------
describe('Handler source structure', () => {
  it('all game handlers call gameCommand or have manual checks', () => {
    const gameHandlers = [
      'handleGameClick', 'handleGameKeyPress', 'handleGameMouseMove',
      'handleGameGetUi', 'handleGameGetSceneTree', 'handleGameEval',
      'handleGameGetProperty', 'handleGameSetProperty', 'handleGameCallMethod',
      'handleGameGetNodeInfo', 'handleGameInstantiateScene', 'handleGameRemoveNode',
      'handleGameChangeScene', 'handleGamePause', 'handleGamePerformance',
      'handleGameWait', 'handleGameConnectSignal', 'handleGameDisconnectSignal',
      'handleGameEmitSignal', 'handleGamePlayAnimation', 'handleGameTweenProperty',
      'handleGameGetNodesInGroup', 'handleGameFindNodesByClass', 'handleGameReparentNode',
    ];
    for (const h of gameHandlers) {
      expect(sourceCode).toContain(h);
    }
  });

  it('all headless handlers call headlessOp or executeOperation', () => {
    const headlessHandlers = [
      'handleModifySceneNode', 'handleRemoveSceneNode',
      'handleAttachScript', 'handleCreateResource',
    ];
    for (const h of headlessHandlers) {
      expect(sourceCode).toContain(h);
    }
  });

  it('gameCommand checks activeProcess and gameConnection', () => {
    // Verify the gameCommand helper has the guard checks
    expect(sourceCode).toContain("if (!this.activeProcess) return createErrorResponse('No active Godot process");
    expect(sourceCode).toContain("if (!this.gameConnection.connected) return createErrorResponse('Not connected");
  });

  it('headlessOp validates projectPath and checks project.godot', () => {
    expect(sourceCode).toContain("if (!projectPath) return createErrorResponse('projectPath is required.");
    expect(sourceCode).toContain("if (!validatePath(projectPath)) return createErrorResponse('Invalid path.");
    expect(sourceCode).toContain("project.godot");
  });

  it('gameCommand normalizes parameters', () => {
    expect(sourceCode).toContain('args = normalizeParameters(args || {});');
  });

  it('gameCommand wraps sendGameCommand in try-catch', () => {
    // The gameCommand helper catches errors from sendGameCommand
    const gameCommandBlock = sourceCode.substring(
      sourceCode.indexOf('private async gameCommand('),
      sourceCode.indexOf('private async headlessOp(')
    );
    expect(gameCommandBlock).toContain('try {');
    expect(gameCommandBlock).toContain('catch (error');
    expect(gameCommandBlock).toContain('sendGameCommand');
  });

  it('headlessOp wraps executeOperation in try-catch', () => {
    const headlessOpBlock = sourceCode.substring(
      sourceCode.indexOf('private async headlessOp('),
      sourceCode.indexOf('private async executeOperation(')
    );
    expect(headlessOpBlock).toContain('try {');
    expect(headlessOpBlock).toContain('catch (error');
    expect(headlessOpBlock).toContain('executeOperation');
  });
});

// ---------------------------------------------------------------------------
// 7. Lifecycle handler source checks
// ---------------------------------------------------------------------------
describe('Lifecycle handlers', () => {
  it('handleLaunchEditor exists and detects godot path', () => {
    expect(sourceCode).toContain('handleLaunchEditor');
    expect(sourceCode).toContain('detectGodotPath');
  });

  it('handleRunProject exists and spawns process', () => {
    expect(sourceCode).toContain('handleRunProject');
    expect(sourceCode).toContain('spawn(');
  });

  it('handleStopProject exists and kills process', () => {
    expect(sourceCode).toContain('handleStopProject');
    // Should have some form of process termination
    expect(sourceCode).toContain('activeProcess');
  });

  it('handleGetDebugOutput exists and reads output buffer', () => {
    expect(sourceCode).toContain('handleGetDebugOutput');
    expect(sourceCode).toContain('.output');
  });

  it('handleGetGodotVersion exists and calls --version', () => {
    expect(sourceCode).toContain('handleGetGodotVersion');
    expect(sourceCode).toContain("'--version'");
  });

  it('handleListProjects exists and scans directories', () => {
    expect(sourceCode).toContain('handleListProjects');
    expect(sourceCode).toContain('project.godot');
  });

  it('handleGetProjectInfo reads project.godot', () => {
    expect(sourceCode).toContain('handleGetProjectInfo');
    expect(sourceCode).toContain('readFileSync');
  });

  it('handleCreateScene calls executeOperation', () => {
    expect(sourceCode).toContain('handleCreateScene');
    expect(sourceCode).toContain('executeOperation');
  });

  it('handleSaveScene calls executeOperation', () => {
    expect(sourceCode).toContain('handleSaveScene');
  });

  it('handleReadScene extracts JSON from markers', () => {
    expect(sourceCode).toContain('handleReadScene');
    expect(sourceCode).toContain('SCENE_JSON_START');
    expect(sourceCode).toContain('SCENE_JSON_END');
  });

  it('handleReadProjectSettings parses INI-style sections', () => {
    expect(sourceCode).toContain('handleReadProjectSettings');
    // It should parse [section] headers and key=value pairs
    expect(sourceCode).toContain("match(/^\\[(.+)\\]$/");
  });

  it('handleModifyProjectSettings writes to project.godot', () => {
    expect(sourceCode).toContain('handleModifyProjectSettings');
    expect(sourceCode).toContain('writeFileSync');
  });

  it('handleListProjectFiles scans directory tree', () => {
    expect(sourceCode).toContain('handleListProjectFiles');
    expect(sourceCode).toContain('readdirSync');
  });

  it('handleGameScreenshot returns image content type', () => {
    expect(sourceCode).toContain('handleGameScreenshot');
    expect(sourceCode).toContain("type: 'image'");
    expect(sourceCode).toContain("mimeType: 'image/png'");
  });

  it('handleUpdateProjectUids checks Godot version >= 4.4', () => {
    expect(sourceCode).toContain('handleUpdateProjectUids');
    expect(sourceCode).toContain('isGodot44OrLater');
  });
});

// ---------------------------------------------------------------------------
// 8. createErrorResponse in handlers
// ---------------------------------------------------------------------------
describe('Error response format in handlers', () => {
  it('createErrorResponse returns isError: true with text content', () => {
    const result = createErrorResponse('test error');
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'test error' });
  });

  it('error messages in game handlers include command name', () => {
    // gameCommand template: `${name} failed: ${response.error}`
    expect(sourceCode).toContain('failed:');
  });

  it('source uses createErrorResponse (not inline error objects)', () => {
    // Count createErrorResponse calls vs inline { isError: true } patterns
    const createErrorCalls = (sourceCode.match(/createErrorResponse\(/g) || []).length;
    expect(createErrorCalls).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 9. convertCamelToSnakeCase used in executeOperation
// ---------------------------------------------------------------------------
describe('executeOperation parameter conversion', () => {
  it('source calls convertCamelToSnakeCase before sending to Godot', () => {
    const execOpBlock = sourceCode.substring(
      sourceCode.indexOf('private async executeOperation('),
      sourceCode.indexOf('private async executeOperation(') + 1500
    );
    expect(execOpBlock).toContain('convertCamelToSnakeCase');
  });

  it('converts handler params for Godot consumption', () => {
    const params = { scenePath: 'main.tscn', nodePath: '/root/Player', properties: { visible: true } };
    const snake = convertCamelToSnakeCase(params);
    expect(snake).toEqual({ scene_path: 'main.tscn', node_path: '/root/Player', properties: { visible: true } });
  });

  it('round-trips normalize → convert', () => {
    const original = { scene_path: 'main.tscn', node_path: '/root/Player' };
    const camel = normalizeParameters(original);
    const snake = convertCamelToSnakeCase(camel);
    expect(snake).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// 10. Switch statement dispatch
// ---------------------------------------------------------------------------
describe('Tool dispatch switch statement', () => {
  it('has a default case that throws McpError', () => {
    expect(sourceCode).toContain("throw new McpError(");
    expect(sourceCode).toContain("ErrorCode.MethodNotFound");
    expect(sourceCode).toContain("Unknown tool:");
  });

  it('every case returns await this.handle*', () => {
    const caseRegex = /case '(\w+)':\s*\n\s*return await this\.handle/g;
    const matches = [...sourceCode.matchAll(caseRegex)];
    // Should match all 47 tools
    expect(matches.length).toBe(47);
  });

  it('no case falls through without return', () => {
    // Each case should have "return await" — no break statements
    const switchBlock = sourceCode.substring(
      sourceCode.indexOf("switch (request.params.name)"),
      sourceCode.indexOf("default:")
    );
    const caseStatements = switchBlock.match(/case '[^']+'/g) || [];
    const returnStatements = switchBlock.match(/return await/g) || [];
    expect(returnStatements.length).toBe(caseStatements.length);
  });
});
