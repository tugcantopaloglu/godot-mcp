import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_TOOL_NAMES = [
  'launch_editor', 'run_project', 'get_debug_output', 'stop_project',
  'get_godot_version', 'list_projects', 'get_project_info', 'create_scene',
  'add_node', 'load_sprite', 'export_mesh_library', 'save_scene',
  'get_uid', 'update_project_uids', 'game_screenshot', 'game_click',
  'game_key_press', 'game_mouse_move', 'game_get_ui', 'game_get_scene_tree',
  'game_eval', 'game_get_property', 'game_set_property', 'game_call_method',
  'game_get_node_info', 'game_instantiate_scene', 'game_remove_node',
  'game_change_scene', 'game_pause', 'game_performance', 'game_wait',
  'read_scene', 'modify_scene_node', 'remove_scene_node',
  'read_project_settings', 'modify_project_settings', 'list_project_files',
  'game_connect_signal', 'game_disconnect_signal', 'game_emit_signal',
  'game_play_animation', 'game_tween_property', 'game_get_nodes_in_group',
  'game_find_nodes_by_class', 'game_reparent_node', 'attach_script',
  'create_resource',
  // File I/O tools
  'read_file', 'write_file', 'delete_file', 'create_directory',
  // Error/Log capture tools
  'game_get_errors', 'game_get_logs',
  // Enhanced input tools
  'game_key_hold', 'game_key_release', 'game_scroll', 'game_mouse_drag', 'game_gamepad',
  // Project management tools
  'create_project', 'manage_autoloads', 'manage_input_map', 'manage_export_presets',
  // Advanced runtime tools
  'game_get_camera', 'game_set_camera', 'game_raycast', 'game_get_audio', 'game_spawn_node',
  // Shader, audio, navigation, tilemap, collision, environment tools
  'game_set_shader_param', 'game_audio_play', 'game_audio_bus', 'game_navigate_path',
  'game_tilemap', 'game_add_collision', 'game_environment',
  // Group, timer, particles, animation, export, state, physics, joint, bone, theme, viewport, debug tools
  'game_manage_group', 'game_create_timer', 'game_set_particles', 'game_create_animation',
  'export_project', 'game_serialize_state', 'game_physics_body', 'game_create_joint',
  'game_bone_pose', 'game_ui_theme', 'game_viewport', 'game_debug_draw',
];

let sourceCode: string;

beforeAll(() => {
  sourceCode = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
});

describe('Tool definitions', () => {
  it('defines exactly 86 tools', () => {
    expect(ALL_TOOL_NAMES).toHaveLength(86);
  });

  it('all tool names are unique', () => {
    const unique = new Set(ALL_TOOL_NAMES);
    expect(unique.size).toBe(ALL_TOOL_NAMES.length);
  });

  for (const toolName of ALL_TOOL_NAMES) {
    it(`defines tool "${toolName}" in source`, () => {
      expect(sourceCode).toContain(`name: '${toolName}'`);
    });
  }

  it('all tool names use snake_case', () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('each tool has a description', () => {
    const toolBlockRegex = /name:\s*'([^']+)',\s*\n\s*description:\s*'([^']+)'/g;
    const matches = [...sourceCode.matchAll(toolBlockRegex)];
    const toolsWithDesc = matches.map(m => m[1]);
    for (const name of ALL_TOOL_NAMES) {
      expect(toolsWithDesc).toContain(name);
    }
  });

  it('each tool has an inputSchema with type "object"', () => {
    const schemaRegex = /name:\s*'([^']+)'[\s\S]*?inputSchema:\s*\{[\s\S]*?type:\s*'object'/g;
    const matches = [...sourceCode.matchAll(schemaRegex)];
    expect(matches.length).toBeGreaterThanOrEqual(ALL_TOOL_NAMES.length);
  });

  it('switch statement handles all tool names', () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(sourceCode).toContain(`case '${name}':`);
    }
  });

  it('no tool description exceeds 80 characters', () => {
    const descRegex = /description:\s*'([^']+)'/g;
    const matches = [...sourceCode.matchAll(descRegex)];
    for (const match of matches) {
      const desc = match[1];
      if (desc.length > 80) {
        expect.fail(`Description too long (${desc.length} chars): "${desc}"`);
      }
    }
  });

  it('required fields reference valid properties', () => {
    // Extract tool definitions and check each required field exists in properties
    const toolRegex = /properties:\s*\{([\s\S]*?)\},\s*\n\s*required:\s*\[([^\]]*)\]/g;
    const matches = [...sourceCode.matchAll(toolRegex)];
    for (const match of matches) {
      const propsBlock = match[1];
      const requiredStr = match[2];
      if (!requiredStr.trim()) continue;
      const required = requiredStr.match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [];
      for (const field of required) {
        expect(propsBlock).toContain(field);
      }
    }
  });
});
