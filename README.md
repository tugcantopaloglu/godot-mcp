# Godot MCP - Full Control

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io/introduction) (MCP) server that gives AI assistants **full control** over the Godot game engine. **47 tools** spanning runtime code execution, property inspection, scene manipulation, animation control, signal management, tweening, project settings, and more.

## Acknowledgments

This project is built upon and extends [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo). The original project provided the foundational architecture including the TypeScript MCP server, headless GDScript operations system, and TCP-based runtime interaction server. Thank you for making this possible with your excellent open-source work!

## What's New (Improvements Over Original)

The original godot-mcp provided 20 tools for basic project management and scene creation. This fork extends it to **47 tools** with the following major additions:

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

### Robustness Improvements
- **Reentrancy guard** - Prevents concurrent command processing during async operations
- **Full type conversion** - Supports Vector2/3, Color, Quaternion, Basis, Transform2D/3D, AABB, Rect2, and all packed array types
- **Smart property type detection** - Uses node's `get_property_list()` for automatic type conversion
- **PackedArray serialization** - Proper JSON arrays instead of string fallback
- **Graceful error handling** - Scene read fallback to raw .tscn text on missing dependencies

## All 47 Tools

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
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

- **Original project**: [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo) - provided the foundational MCP server architecture, headless operations system, and TCP interaction framework
- **Extended by**: [Tugcan Topaloglu](https://github.com/tugcantopaloglu) - added 27 new tools for runtime code execution, node manipulation, signals, animation, tweening, project management, and comprehensive type conversion
