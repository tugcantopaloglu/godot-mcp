
<img width="2752" height="1536" alt="godot_mcp_header" src="https://github.com/user-attachments/assets/ed7ac605-8fb5-4a5f-adf8-4b6912cbc18c" />

# Godot MCP - Full Control

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io/introduction) (MCP) server that gives AI assistants **full control** over the Godot game engine. **74 tools** spanning file I/O, runtime code execution, property inspection, scene manipulation, animation control, signal management, tweening, project creation, camera control, physics raycasting, and more.

## Acknowledgments

This project is built upon and extends [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo). The original project provided the foundational architecture including the TypeScript MCP server, headless GDScript operations system, and TCP-based runtime interaction server. Thank you for making this possible with your excellent open-source work!

## What's New (Improvements Over Original)

The original godot-mcp provided 20 tools for basic project management and scene creation. This fork extends it to **74 tools** with the following major additions:

### Runtime Code Execution
- **`game_eval`** - Execute arbitrary GDScript code in the running game with return values
- Full `await` support for async GDScript code
- Works even when the game is paused (`PROCESS_MODE_ALWAYS`)

### Runtime Node Inspection & Manipulation
- **`game_get_property`** / **`game_set_property`** - Read/write any property on any node by path
- **`game_call_method`** - Call any method on any node with arguments
- **`game_get_node_info`** - Full node introspection: properties, signals, methods, children
- **`game_instantiate_scene`** - Dynamically add scenes to the running game
- **`game_remove_node`** - Remove nodes at runtime
- **`game_change_scene`** - Switch scenes at runtime
- **`game_reparent_node`** - Move nodes between parents

### Signal System
- **`game_connect_signal`** - Wire up signal connections at runtime
- **`game_disconnect_signal`** - Remove signal connections
- **`game_emit_signal`** - Emit signals with arguments

### Animation & Tweening
- **`game_play_animation`** - Control AnimationPlayer (play, stop, pause, list)
- **`game_tween_property`** - Smooth property animation with configurable easing

### Game Control & Debugging
- **`game_pause`** - Pause/unpause the game
- **`game_performance`** - FPS, frame time, memory, object counts, draw calls
- **`game_wait`** - Wait N frames (timing-sensitive operations)
- **`game_get_nodes_in_group`** - Query nodes by group
- **`game_find_nodes_by_class`** - Find all nodes of a specific class

### Headless Scene Operations (No Running Game Needed)
- **`read_scene`** - Parse any .tscn file and get full node tree with properties as JSON
- **`modify_scene_node`** - Change node properties in scene files
- **`remove_scene_node`** - Remove nodes from scene files
- **`attach_script`** - Attach GDScript files to nodes in scenes
- **`create_resource`** - Create .tres resource files (materials, themes, etc.)

### Project Management
- **`read_project_settings`** - Parse project.godot as structured JSON
- **`modify_project_settings`** - Change project settings programmatically
- **`list_project_files`** - List and filter project files by extension

### File I/O
- **`read_file`** / **`write_file`** / **`delete_file`** - Full file system access within Godot projects
- **`create_directory`** - Create directory structures for scripts, scenes, assets

### Error & Log Capture
- **`game_get_errors`** - Get new push_error/push_warning messages since last call
- **`game_get_logs`** - Get new print output from the running game since last call

### Enhanced Input
- **`game_key_hold`** / **`game_key_release`** - Hold keys down for movement testing (WASD etc.)
- **`game_scroll`** - Mouse scroll wheel events
- **`game_mouse_drag`** - Drag between two points over multiple frames
- **`game_gamepad`** - Gamepad button and axis input events

### Project Creation & Configuration
- **`create_project`** - Create a new Godot project from scratch
- **`manage_autoloads`** - Add, remove, or list autoloads
- **`manage_input_map`** - Add, remove, or list input actions and key bindings
- **`manage_export_presets`** - Create or modify export preset configuration

### Camera, Physics & Audio
- **`game_get_camera`** / **`game_set_camera`** - Query and control 2D/3D cameras
- **`game_raycast`** - Cast physics rays (auto-detects 2D vs 3D)
- **`game_get_audio`** - Get audio bus layout and playing streams
- **`game_spawn_node`** - Create any node type at runtime with properties
- **`game_set_shader_param`** - Set shader parameters on materials
- **`game_audio_play`** / **`game_audio_bus`** - Full audio playback and bus control
- **`game_navigate_path`** - Query navigation paths (2D/3D)
- **`game_tilemap`** - Get/set TileMapLayer cells
- **`game_add_collision`** - Add collision shapes to physics bodies
- **`game_environment`** - Configure post-processing (fog, glow, SSAO, tonemap, etc.)

### Robustness Improvements
- **Reentrancy guard** - Prevents concurrent command processing during async operations
- **Full type conversion** - Supports Vector2/3, Color, Quaternion, Basis, Transform2D/3D, AABB, Rect2, and all packed array types
- **Smart property type detection** - Uses node's `get_property_list()` for automatic type conversion
- **PackedArray serialization** - Proper JSON arrays instead of string fallback
- **Graceful error handling** - Scene read fallback to raw .tscn text on missing dependencies

## All 74 Tools

### Project Management (7 tools)
| Tool | Description |
|------|-------------|
| `launch_editor` | Launch Godot editor for a project |
| `run_project` | Run a Godot project and capture output |
| `stop_project` | Stop the running project |
| `get_debug_output` | Get console output and errors |
| `get_godot_version` | Get installed Godot version |
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Get project metadata |

### Scene Management (7 tools)
| Tool | Description |
|------|-------------|
| `create_scene` | Create a new scene with a root node type |
| `add_node` | Add a node to an existing scene |
| `load_sprite` | Load a texture into a Sprite2D node |
| `export_mesh_library` | Export a scene as MeshLibrary |
| `save_scene` | Save a scene (with optional variant path) |
| `get_uid` | Get UID for a file (Godot 4.4+) |
| `update_project_uids` | Resave resources to update UIDs |

### Headless Scene Operations (5 tools)
| Tool | Description |
|------|-------------|
| `read_scene` | Read full scene tree as JSON |
| `modify_scene_node` | Modify node properties in a scene file |
| `remove_scene_node` | Remove a node from a scene file |
| `attach_script` | Attach a GDScript to a scene node |
| `create_resource` | Create a .tres resource file |

### Project Settings (3 tools)
| Tool | Description |
|------|-------------|
| `read_project_settings` | Parse project.godot as JSON |
| `modify_project_settings` | Change a project setting |
| `list_project_files` | List/filter project files |

### Runtime Input (4 tools)
| Tool | Description |
|------|-------------|
| `game_screenshot` | Capture a screenshot (base64 PNG) |
| `game_click` | Click at a position |
| `game_key_press` | Send key press or input action |
| `game_mouse_move` | Move the mouse |

### Runtime Inspection (3 tools)
| Tool | Description |
|------|-------------|
| `game_get_ui` | Get all visible UI elements |
| `game_get_scene_tree` | Get full scene tree structure |
| `game_get_node_info` | Detailed node introspection |

### Runtime Code Execution (1 tool)
| Tool | Description |
|------|-------------|
| `game_eval` | Execute arbitrary GDScript with return values |

### Runtime Node Manipulation (7 tools)
| Tool | Description |
|------|-------------|
| `game_get_property` | Get any node property |
| `game_set_property` | Set any node property (auto type conversion) |
| `game_call_method` | Call any method on a node |
| `game_instantiate_scene` | Add a PackedScene to the running tree |
| `game_remove_node` | Remove a node from the tree |
| `game_change_scene` | Switch to a different scene |
| `game_reparent_node` | Move a node to a new parent |

### Runtime Signals (3 tools)
| Tool | Description |
|------|-------------|
| `game_connect_signal` | Connect a signal to a method |
| `game_disconnect_signal` | Disconnect a signal |
| `game_emit_signal` | Emit a signal with arguments |

### Runtime Animation (2 tools)
| Tool | Description |
|------|-------------|
| `game_play_animation` | Control AnimationPlayer |
| `game_tween_property` | Tween a property with easing |

### Runtime Utilities (5 tools)
| Tool | Description |
|------|-------------|
| `game_pause` | Pause/unpause the game |
| `game_performance` | Get FPS, memory, draw calls |
| `game_wait` | Wait N frames |
| `game_get_nodes_in_group` | Query nodes by group |
| `game_find_nodes_by_class` | Find nodes by class type |

### File I/O (4 tools)
| Tool | Description |
|------|-------------|
| `read_file` | Read a text file from a Godot project |
| `write_file` | Create or overwrite a text file |
| `delete_file` | Delete a file from a project |
| `create_directory` | Create a directory inside a project |

### Error & Log Capture (2 tools)
| Tool | Description |
|------|-------------|
| `game_get_errors` | Get new errors/warnings since last call |
| `game_get_logs` | Get new print output since last call |

### Enhanced Input (5 tools)
| Tool | Description |
|------|-------------|
| `game_key_hold` | Hold a key down (no auto-release) |
| `game_key_release` | Release a held key |
| `game_scroll` | Mouse scroll wheel event |
| `game_mouse_drag` | Drag between two points over N frames |
| `game_gamepad` | Gamepad button or axis input |

### Project Creation (4 tools)
| Tool | Description |
|------|-------------|
| `create_project` | Create a new Godot project from scratch |
| `manage_autoloads` | Add, remove, or list autoloads |
| `manage_input_map` | Add, remove, or list input actions |
| `manage_export_presets` | Create or modify export presets |

### Advanced Runtime (12 tools)
| Tool | Description |
|------|-------------|
| `game_get_camera` | Get active camera position/rotation/zoom |
| `game_set_camera` | Move or rotate the active camera |
| `game_raycast` | Cast a ray and return collision results |
| `game_get_audio` | Get audio bus layout and playing streams |
| `game_spawn_node` | Create a new node of any type at runtime |
| `game_set_shader_param` | Set a shader parameter on a node's material |
| `game_audio_play` | Play, stop, or pause an AudioStreamPlayer node |
| `game_audio_bus` | Set volume, mute, or solo on an audio bus |
| `game_navigate_path` | Query a navigation path between two points |
| `game_tilemap` | Get or set cells in a TileMapLayer node |
| `game_add_collision` | Add a collision shape to a physics body node |
| `game_environment` | Get or set environment and post-processing settings |

## Requirements

- [Godot Engine](https://godotengine.org/download) (4.x recommended, 4.4+ for UID features)
- [Node.js](https://nodejs.org/) >= 18.0.0
- An AI assistant that supports MCP (Claude Code, Cline, Cursor, etc.)

## Installation

```bash
git clone https://github.com/tugcantopaloglu/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

## Configuration

### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

### Cline (VS Code)

Add to your Cline MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"],
      "disabled": false
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"]
    }
  }
}
```

## Runtime Tools Setup

To use the `game_*` runtime tools, your Godot project needs the MCP interaction server autoload. Copy `build/scripts/mcp_interaction_server.gd` to your project and register it as an autoload:

1. Copy `build/scripts/mcp_interaction_server.gd` to your project's scripts folder
2. In Godot: **Project > Project Settings > Autoload**
3. Add the script with the name `McpInteractionServer`

The server listens on `127.0.0.1:9090` and accepts JSON commands over TCP when the game is running.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides auto-detection) |
| `DEBUG` | Set to `"true"` for detailed server-side logging |

## Architecture

The server uses two communication channels:

1. **Headless CLI** - For operations that don't need a running game (scene reading, modification, resource creation). Runs Godot with `--headless --script godot_operations.gd <operation> <json_params>`.

2. **TCP Socket** - For runtime interaction with a running game. The `mcp_interaction_server.gd` autoload listens on port 9090 and processes JSON commands sent by the TypeScript MCP server.

### Source layout

| Path | Description |
|------|-------------|
| `src/index.ts` | MCP server, tool definitions, and all handlers |
| `src/utils.ts` | Pure utility functions (parameter mapping, validation, error helpers) |
| `src/scripts/godot_operations.gd` | Headless GDScript operations runner |
| `src/scripts/mcp_interaction_server.gd` | TCP interaction server autoload |
| `tests/` | Vitest test suite |

## Testing

The project uses [Vitest](https://vitest.dev/) with 246 tests across 3 files:

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/utils.test.ts` | 31 | Parameter mappings, normalization, path validation, error responses, version detection |
| `tests/tool-definitions.test.ts` | 75 | All 74 tools defined, schemas valid, names unique, descriptions < 80 chars |
| `tests/handlers.test.ts` | 140 | Game command arg transforms, required-param validation, headless op path checks, source structure |

```bash
npm test          # run once
npm run test:watch  # watch mode
```

## Example Prompts

```text
"Run my Godot project and check for errors"

"Eval this in my running game: return get_tree().current_scene.name"

"Get the player's position in the running game"

"Set the player's health to 100"

"Read the test_level.tscn scene and show me the node tree"

"Change the player's speed property in the player.tscn scene file"

"List all .gd files in my project"

"Connect the enemy's 'died' signal to the game manager's 'on_enemy_died' method"

"Tween the camera's position to (0, 10, -5) over 2 seconds with ease-out"

"Get performance metrics - what's my FPS and draw call count?"

"Pause the game and take a screenshot"

"Find all CharacterBody3D nodes in the scene"

"Create a new Godot project called 'MyGame' and write a player script"

"Hold down the W key for 2 seconds to test walking"

"Cast a ray from the player downward to check for ground"

"Get the camera position and move it to look at the player"

"Show me the latest error messages from the running game"
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

- **Original project**: [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo) - provided the foundational MCP server architecture, headless operations system, and TCP interaction framework
- **Extended by**: [Tugcan Topaloglu](https://github.com/tugcantopaloglu) - added 47 new tools for file I/O, runtime code execution, node manipulation, signals, animation, tweening, project creation, camera control, physics raycasting, enhanced input, and comprehensive type conversion
