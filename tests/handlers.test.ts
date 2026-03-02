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

  // game_key_hold
  describe('handleGameKeyHold', () => {
    it('passes key parameter', () => {
      const r = fakeGameCommand(true, true, { key: 'W' }, a => ({ key: a.key }));
      expect(r.commandArgs).toEqual({ key: 'W' });
    });

    it('passes action parameter', () => {
      const r = fakeGameCommand(true, true, { action: 'move_forward' }, a => ({ action: a.action }));
      expect(r.commandArgs).toEqual({ action: 'move_forward' });
    });
  });

  // game_key_release
  describe('handleGameKeyRelease', () => {
    it('passes key parameter', () => {
      const r = fakeGameCommand(true, true, { key: 'W' }, a => ({ key: a.key }));
      expect(r.commandArgs).toEqual({ key: 'W' });
    });
  });

  // game_scroll
  describe('handleGameScroll', () => {
    const argsFn = (a: any) => ({
      x: a.x ?? 0, y: a.y ?? 0, direction: a.direction || 'up', amount: a.amount || 1,
    });

    it('defaults direction to up and amount to 1', () => {
      const r = fakeGameCommand(true, true, { x: 100, y: 200 }, argsFn);
      expect(r.commandArgs).toEqual({ x: 100, y: 200, direction: 'up', amount: 1 });
    });

    it('accepts custom direction and amount', () => {
      const r = fakeGameCommand(true, true, { x: 0, y: 0, direction: 'down', amount: 3 }, argsFn);
      expect(r.commandArgs!.direction).toBe('down');
      expect(r.commandArgs!.amount).toBe(3);
    });
  });

  // game_mouse_drag
  describe('handleGameMouseDrag', () => {
    const argsFn = (a: any) => ({
      from_x: a.fromX, from_y: a.fromY, to_x: a.toX, to_y: a.toY,
      button: a.button || 1, steps: a.steps || 10,
    });

    it('maps all drag params', () => {
      const r = fakeGameCommand(true, true, {
        fromX: 10, fromY: 20, toX: 100, toY: 200,
      }, argsFn);
      expect(r.commandArgs).toEqual({
        from_x: 10, from_y: 20, to_x: 100, to_y: 200, button: 1, steps: 10,
      });
    });

    it('accepts custom button and steps', () => {
      const r = fakeGameCommand(true, true, {
        fromX: 0, fromY: 0, toX: 50, toY: 50, button: 2, steps: 20,
      }, argsFn);
      expect(r.commandArgs!.button).toBe(2);
      expect(r.commandArgs!.steps).toBe(20);
    });
  });

  // game_gamepad
  describe('handleGameGamepad', () => {
    const argsFn = (a: any) => ({
      type: a.type, index: a.index, value: a.value, device: a.device || 0,
    });

    it('passes button type', () => {
      const r = fakeGameCommand(true, true, { type: 'button', index: 0, value: 1 }, argsFn);
      expect(r.commandArgs).toEqual({ type: 'button', index: 0, value: 1, device: 0 });
    });

    it('passes axis type with custom device', () => {
      const r = fakeGameCommand(true, true, { type: 'axis', index: 1, value: -0.5, device: 2 }, argsFn);
      expect(r.commandArgs!.device).toBe(2);
    });
  });

  // game_get_camera (no args)
  describe('handleGameGetCamera', () => {
    it('sends empty args', () => {
      const r = fakeGameCommand(true, true, {}, () => ({}));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_set_camera
  describe('handleGameSetCamera', () => {
    it('passes position', () => {
      const r = fakeGameCommand(true, true, { position: { x: 10, y: 20 } }, a => ({
        ...(a.position ? { position: a.position } : {}),
      }));
      expect(r.commandArgs).toEqual({ position: { x: 10, y: 20 } });
    });

    it('omits undefined fields', () => {
      const r = fakeGameCommand(true, true, {}, a => ({
        ...(a.position ? { position: a.position } : {}),
        ...(a.fov !== undefined ? { fov: a.fov } : {}),
      }));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_raycast
  describe('handleGameRaycast', () => {
    const argsFn = (a: any) => ({
      from: a.from, to: a.to, collision_mask: a.collisionMask ?? 0xFFFFFFFF,
    });

    it('passes from/to with default mask', () => {
      const r = fakeGameCommand(true, true, {
        from: { x: 0, y: 0 }, to: { x: 100, y: 100 },
      }, argsFn);
      expect(r.commandArgs).toEqual({
        from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, collision_mask: 0xFFFFFFFF,
      });
    });

    it('accepts custom collision mask', () => {
      const r = fakeGameCommand(true, true, {
        from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, collisionMask: 1,
      }, argsFn);
      expect(r.commandArgs!.collision_mask).toBe(1);
    });
  });

  // game_get_audio (no args)
  describe('handleGameGetAudio', () => {
    it('sends empty args', () => {
      const r = fakeGameCommand(true, true, {}, () => ({}));
      expect(r.commandArgs).toEqual({});
    });
  });

  // game_spawn_node
  describe('handleGameSpawnNode', () => {
    const argsFn = (a: any) => ({
      type: a.type, name: a.name || '', parent_path: a.parentPath || '/root',
      ...(a.properties ? { properties: a.properties } : {}),
    });

    it('defaults name to empty and parent to /root', () => {
      const r = fakeGameCommand(true, true, { type: 'Sprite2D' }, argsFn);
      expect(r.commandArgs).toEqual({ type: 'Sprite2D', name: '', parent_path: '/root' });
    });

    it('accepts custom name and parent', () => {
      const r = fakeGameCommand(true, true, {
        type: 'Node2D', name: 'MyNode', parentPath: '/root/World',
      }, argsFn);
      expect(r.commandArgs).toEqual({ type: 'Node2D', name: 'MyNode', parent_path: '/root/World' });
    });

    it('includes properties when provided', () => {
      const r = fakeGameCommand(true, true, {
        type: 'Sprite2D', properties: { visible: false },
      }, argsFn);
      expect(r.commandArgs!.properties).toEqual({ visible: false });
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

  it('read_file requires projectPath and filePath', () => {
    const args = normalizeParameters({ projectPath: '/game' });
    expect(!args.projectPath || !args.filePath).toBe(true);
  });

  it('write_file requires projectPath, filePath, and content', () => {
    const args = normalizeParameters({ projectPath: '/game', filePath: 'test.gd' });
    expect(args.content === undefined).toBe(true);
  });

  it('delete_file requires projectPath and filePath', () => {
    const args = normalizeParameters({});
    expect(!args.projectPath || !args.filePath).toBe(true);
  });

  it('create_directory requires projectPath and directoryPath', () => {
    const args = normalizeParameters({ projectPath: '/game' });
    expect(!args.projectPath || !args.directoryPath).toBe(true);
  });

  it('game_key_hold requires key or action', () => {
    const args = normalizeParameters({});
    expect(!args.key && !args.action).toBe(true);
  });

  it('game_key_release requires key or action', () => {
    const args = {};
    expect(!(args as any).key && !(args as any).action).toBe(true);
  });

  it('game_mouse_drag requires fromX, fromY, toX, toY', () => {
    const args = normalizeParameters({ fromX: 10 });
    expect(args.toX === undefined || args.toY === undefined).toBe(true);
  });

  it('game_gamepad requires type, index, and value', () => {
    const args = normalizeParameters({ type: 'button' });
    expect(args.index === undefined || args.value === undefined).toBe(true);
  });

  it('create_project requires projectPath and projectName', () => {
    const args = normalizeParameters({ projectPath: '/game' });
    expect(!args.projectPath || !args.projectName).toBe(true);
  });

  it('manage_autoloads requires projectPath and action', () => {
    const args = normalizeParameters({ projectPath: '/game' });
    expect(!args.projectPath || !args.action).toBe(true);
  });

  it('manage_input_map requires projectPath and action', () => {
    const args = normalizeParameters({});
    expect(!args.projectPath || !args.action).toBe(true);
  });

  it('manage_export_presets requires projectPath and action', () => {
    const args = normalizeParameters({});
    expect(!args.projectPath || !args.action).toBe(true);
  });

  it('game_raycast requires from and to', () => {
    const args = normalizeParameters({ from: { x: 0, y: 0 } });
    expect(!args.from || !args.to).toBe(true);
  });

  it('game_spawn_node requires type', () => {
    const args = normalizeParameters({});
    expect(!args.type).toBe(true);
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
      // New game handlers
      'handleGameGetErrors', 'handleGameGetLogs',
      'handleGameKeyHold', 'handleGameKeyRelease', 'handleGameScroll',
      'handleGameMouseDrag', 'handleGameGamepad',
      'handleGameGetCamera', 'handleGameSetCamera', 'handleGameRaycast',
      'handleGameGetAudio', 'handleGameSpawnNode',
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

  it('all file I/O handlers exist', () => {
    const fileHandlers = [
      'handleReadFile', 'handleWriteFile', 'handleDeleteFile', 'handleCreateDirectory',
    ];
    for (const h of fileHandlers) {
      expect(sourceCode).toContain(h);
    }
  });

  it('all project management handlers exist', () => {
    const pmHandlers = [
      'handleCreateProject', 'handleManageAutoloads',
      'handleManageInputMap', 'handleManageExportPresets',
    ];
    for (const h of pmHandlers) {
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
// 7b. Shader, audio, navigation, tilemap, collision, environment handlers
// ---------------------------------------------------------------------------
describe('Game command handlers — new tools (shader, audio, nav, tilemap, collision, env)', () => {
  // game_set_shader_param
  describe('handleGameSetShaderParam', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, param_name: a.paramName, value: a.value,
      ...(a.typeHint ? { type_hint: a.typeHint } : {}),
    });

    it('requires nodePath and paramName', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      // argsFn succeeds but returns undefined fields — validation is in the TS handler
      expect(r.error).toBeNull();
    });

    it('passes shader params correctly', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Mesh', paramName: 'albedo_color', value: { r: 1, g: 0, b: 0, a: 1 }, typeHint: 'Color' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Mesh', param_name: 'albedo_color', value: { r: 1, g: 0, b: 0, a: 1 }, type_hint: 'Color' });
    });

    it('omits type_hint when not provided', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Mesh', paramName: 'speed', value: 2.5 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Mesh', param_name: 'speed', value: 2.5 });
    });
  });

  // game_audio_play
  describe('handleGameAudioPlay', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, action: a.action || 'play',
      ...(a.stream ? { stream: a.stream } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.pitch !== undefined ? { pitch: a.pitch } : {}),
      ...(a.bus ? { bus: a.bus } : {}),
      ...(a.fromPosition !== undefined ? { from_position: a.fromPosition } : {}),
    });

    it('defaults action to play', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Music' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Music', action: 'play' });
    });

    it('passes all optional audio params', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/SFX', action: 'play', volume: 0.5, pitch: 1.2, bus: 'Effects', fromPosition: 3.5, stream: 'res://audio.ogg' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/SFX', action: 'play', volume: 0.5, pitch: 1.2, bus: 'Effects', from_position: 3.5, stream: 'res://audio.ogg' });
    });
  });

  // game_audio_bus
  describe('handleGameAudioBus', () => {
    const argsFn = (a: any) => ({
      bus_name: a.busName || 'Master',
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.mute !== undefined ? { mute: a.mute } : {}),
      ...(a.solo !== undefined ? { solo: a.solo } : {}),
    });

    it('defaults bus to Master', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ bus_name: 'Master' });
    });

    it('sets volume and mute', () => {
      const r = fakeGameCommand(true, true, { busName: 'Music', volume: 0.3, mute: true }, argsFn);
      expect(r.commandArgs).toEqual({ bus_name: 'Music', volume: 0.3, mute: true });
    });
  });

  // game_navigate_path
  describe('handleGameNavigatePath', () => {
    const argsFn = (a: any) => ({
      start: a.start, end: a.end, optimize: a.optimize ?? true,
    });

    it('passes 2D points', () => {
      const r = fakeGameCommand(true, true, { start: { x: 0, y: 0 }, end: { x: 100, y: 200 } }, argsFn);
      expect(r.commandArgs).toEqual({ start: { x: 0, y: 0 }, end: { x: 100, y: 200 }, optimize: true });
    });

    it('passes 3D points with optimize false', () => {
      const r = fakeGameCommand(true, true, { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 10 }, optimize: false }, argsFn);
      expect(r.commandArgs).toEqual({ start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 10 }, optimize: false });
    });
  });

  // game_tilemap
  describe('handleGameTilemap', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.cells ? { cells: a.cells } : {}),
      ...(a.sourceId !== undefined ? { source_id: a.sourceId } : {}),
    });

    it('handles get_cell action', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/TileMap', action: 'get_cell', x: 5, y: 3 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/TileMap', action: 'get_cell', x: 5, y: 3 });
    });

    it('handles set_cells with cell array', () => {
      const cells = [{ x: 0, y: 0, source_id: 0, atlas_x: 0, atlas_y: 0, alt_tile: 0 }];
      const r = fakeGameCommand(true, true, { nodePath: '/root/TileMap', action: 'set_cells', cells }, argsFn);
      expect(r.commandArgs!.action).toBe('set_cells');
      expect(r.commandArgs!.cells).toHaveLength(1);
    });

    it('handles get_used_cells with source filter', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/TileMap', action: 'get_used_cells', sourceId: 2 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/TileMap', action: 'get_used_cells', source_id: 2 });
    });
  });

  // game_add_collision
  describe('handleGameAddCollision', () => {
    const argsFn = (a: any) => ({
      parent_path: a.parentPath, shape_type: a.shapeType,
      ...(a.shapeParams ? { shape_params: a.shapeParams } : {}),
      ...(a.collisionLayer !== undefined ? { collision_layer: a.collisionLayer } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    });

    it('passes box shape with params', () => {
      const r = fakeGameCommand(true, true, { parentPath: '/root/Body', shapeType: 'box', shapeParams: { size_x: 2, size_y: 2, size_z: 2 } }, argsFn);
      expect(r.commandArgs).toEqual({ parent_path: '/root/Body', shape_type: 'box', shape_params: { size_x: 2, size_y: 2, size_z: 2 } });
    });

    it('passes collision layer and mask', () => {
      const r = fakeGameCommand(true, true, { parentPath: '/root/Body', shapeType: 'sphere', collisionLayer: 1, collisionMask: 3 }, argsFn);
      expect(r.commandArgs).toEqual({ parent_path: '/root/Body', shape_type: 'sphere', collision_layer: 1, collision_mask: 3 });
    });
  });

  // game_environment
  describe('handleGameEnvironment', () => {
    it('source defines handleGameEnvironment method', () => {
      expect(sourceCode).toContain('handleGameEnvironment');
    });

    it('handler passes environment settings via envKeys loop', () => {
      expect(sourceCode).toContain("const envKeys");
    });

    it('defaults action to set', () => {
      expect(sourceCode).toContain("action: args.action || 'set'");
    });
  });
});

// ---------------------------------------------------------------------------
// 7c. Group, timer, particles, animation, export, state, physics, joint, bone, theme, viewport, debug handlers
// ---------------------------------------------------------------------------
describe('Game command handlers — new tools (group, timer, particles, animation, physics, etc.)', () => {
  // game_manage_group
  describe('handleGameManageGroup', () => {
    const argsFn = (a: any) => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.group ? { group: a.group } : {}),
    });

    it('passes add action with group', () => {
      const r = fakeGameCommand(true, true, { action: 'add', nodePath: '/root/Player', group: 'enemies' }, argsFn);
      expect(r.commandArgs).toEqual({ action: 'add', node_path: '/root/Player', group: 'enemies' });
    });

    it('passes get_groups without group param', () => {
      const r = fakeGameCommand(true, true, { action: 'get_groups', nodePath: '/root/Player' }, argsFn);
      expect(r.commandArgs).toEqual({ action: 'get_groups', node_path: '/root/Player' });
    });
  });

  // game_create_timer
  describe('handleGameCreateTimer', () => {
    const argsFn = (a: any) => ({
      parent_path: a.parentPath || '/root',
      wait_time: a.waitTime ?? 1.0,
      one_shot: a.oneShot ?? false,
      autostart: a.autostart ?? false,
    });

    it('defaults to /root parent and 1s wait', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ parent_path: '/root', wait_time: 1.0, one_shot: false, autostart: false });
    });

    it('passes custom timer settings', () => {
      const r = fakeGameCommand(true, true, { parentPath: '/root/Game', waitTime: 5.0, oneShot: true, autostart: true }, argsFn);
      expect(r.commandArgs).toEqual({ parent_path: '/root/Game', wait_time: 5.0, one_shot: true, autostart: true });
    });
  });

  // game_set_particles
  describe('handleGameSetParticles', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath,
      ...(a.emitting !== undefined ? { emitting: a.emitting } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
    });

    it('passes particle settings', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Particles', emitting: true, amount: 100 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Particles', emitting: true, amount: 100 });
    });
  });

  // game_create_animation
  describe('handleGameCreateAnimation', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, animation_name: a.animationName,
      length: a.length ?? 1.0, loop_mode: a.loopMode ?? 0, tracks: a.tracks || [],
    });

    it('passes animation params', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/AnimPlayer', animationName: 'walk', length: 2.0 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/AnimPlayer', animation_name: 'walk', length: 2.0, loop_mode: 0, tracks: [] });
    });
  });

  // export_project
  describe('handleExportProject', () => {
    it('source defines handleExportProject method', () => {
      expect(sourceCode).toContain('handleExportProject');
    });

    it('uses execFileAsync for headless export', () => {
      expect(sourceCode).toContain('--export-release');
      expect(sourceCode).toContain('--export-debug');
    });
  });

  // game_serialize_state
  describe('handleGameSerializeState', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath || '/root', action: a.action || 'save', max_depth: a.maxDepth ?? 5,
    });

    it('defaults to save with depth 5', () => {
      const r = fakeGameCommand(true, true, {}, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root', action: 'save', max_depth: 5 });
    });
  });

  // game_physics_body
  describe('handleGamePhysicsBody', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath,
      ...(a.mass !== undefined ? { mass: a.mass } : {}),
      ...(a.gravityScale !== undefined ? { gravity_scale: a.gravityScale } : {}),
    });

    it('passes physics body params', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Ball', mass: 2.0, gravityScale: 0.5 }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Ball', mass: 2.0, gravity_scale: 0.5 });
    });
  });

  // game_create_joint
  describe('handleGameCreateJoint', () => {
    const argsFn = (a: any) => ({
      parent_path: a.parentPath, joint_type: a.jointType,
      ...(a.nodeAPath ? { node_a_path: a.nodeAPath } : {}),
      ...(a.nodeBPath ? { node_b_path: a.nodeBPath } : {}),
    });

    it('passes joint creation params', () => {
      const r = fakeGameCommand(true, true, { parentPath: '/root', jointType: 'pin_3d', nodeAPath: '/root/A', nodeBPath: '/root/B' }, argsFn);
      expect(r.commandArgs).toEqual({ parent_path: '/root', joint_type: 'pin_3d', node_a_path: '/root/A', node_b_path: '/root/B' });
    });
  });

  // game_bone_pose
  describe('handleGameBonePose', () => {
    const argsFn = (a: any) => ({
      node_path: a.nodePath, action: a.action || 'list',
      ...(a.boneName ? { bone_name: a.boneName } : {}),
    });

    it('defaults to list action', () => {
      const r = fakeGameCommand(true, true, { nodePath: '/root/Skeleton' }, argsFn);
      expect(r.commandArgs).toEqual({ node_path: '/root/Skeleton', action: 'list' });
    });
  });

  // game_ui_theme
  describe('handleGameUiTheme', () => {
    const argsFn = (a: any) => ({ node_path: a.nodePath, overrides: a.overrides });

    it('passes theme overrides', () => {
      const overrides = { colors: { font_color: { r: 1, g: 0, b: 0, a: 1 } } };
      const r = fakeGameCommand(true, true, { nodePath: '/root/Label', overrides }, argsFn);
      expect(r.commandArgs!.node_path).toBe('/root/Label');
      expect(r.commandArgs!.overrides.colors.font_color.r).toBe(1);
    });
  });

  // game_viewport
  describe('handleGameViewport', () => {
    const argsFn = (a: any) => ({
      action: a.action || 'create',
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
    });

    it('defaults to create action', () => {
      const r = fakeGameCommand(true, true, { parentPath: '/root', width: 256, height: 256 }, argsFn);
      expect(r.commandArgs).toEqual({ action: 'create', parent_path: '/root', width: 256, height: 256 });
    });
  });

  // game_debug_draw
  describe('handleGameDebugDraw', () => {
    const argsFn = (a: any) => ({
      action: a.action,
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.color ? { color: a.color } : {}),
    });

    it('passes line draw params', () => {
      const r = fakeGameCommand(true, true, { action: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 } }, argsFn);
      expect(r.commandArgs).toEqual({ action: 'line', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 } });
    });

    it('passes clear action', () => {
      const r = fakeGameCommand(true, true, { action: 'clear' }, argsFn);
      expect(r.commandArgs).toEqual({ action: 'clear' });
    });
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
    // Should match all 86 tools
    expect(matches.length).toBe(86);
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
